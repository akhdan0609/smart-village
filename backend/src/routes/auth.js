const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { sendOk, sendError } = require('../utils/http');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

/* =========================================================
   RATE LIMITING & CAPTCHA (in-memory, per alamat IP)
   ========================================================= */
const CAPTCHA_THRESHOLD = 3;    // jumlah kegagalan sebelum CAPTCHA diminta
const LOCK_THRESHOLD = 5;       // jumlah kegagalan sebelum IP dikunci sementara
const BASE_LOCK_MS = 30 * 1000; // durasi kunci pertama (30 detik)

const loginAttempts = new Map();

function getRecord(ip) {
  if (!loginAttempts.has(ip)) {
    loginAttempts.set(ip, {
      failures: 0,
      lockUntil: 0,
      lockCount: 0,
      captchaRequired: false,
      captcha: null
    });
  }
  return loginAttempts.get(ip);
}

function newCaptcha() {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  return { a, b };
}

function captchaText(captcha) {
  return `${captcha.a} + ${captcha.b} = ?`;
}

function resetRecord(record) {
  record.failures = 0;
  record.lockUntil = 0;
  record.lockCount = 0;
  record.captchaRequired = false;
  record.captcha = null;
}

async function logLogin({ userId, username, ip, ua, success }) {
  try {
    await query(
      `INSERT INTO activity_log (
         admin_user_id,
         action,
         entity_type,
         entity_id,
         detail,
         ip_address,
         user_agent
       )
       VALUES ($1, $2, 'admin_user', $1, $3::jsonb, $4, $5)`,
      [
        userId || null,
        success ? 'login' : 'login_failed',
        JSON.stringify({ ip, username: username || null }),
        ip,
        ua || null
      ]
    );
  } catch {
    // pencatatan log tidak boleh menggagalkan proses login
  }
}

router.post('/login', asyncHandler(async (req, res) => {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  const record = getRecord(ip);
  const now = Date.now();

  // 1. Soft lock (kunci sementara jika masih dalam masa tunggu)
  if (now < record.lockUntil) {
    const waitSec = Math.ceil((record.lockUntil - now) / 1000);
    return sendError(
      res,
      `Terlalu banyak percobaan login. Coba lagi dalam ${waitSec} detik.`,
      429
    );
  }

  const { username, password, captcha_answer } = req.body || {};
  if (!username || !password) {
    return sendError(res, 'Username dan kata sandi wajib diisi', 422);
  }

  // 2. Verifikasi CAPTCHA bila sudah diminta
  if (record.captchaRequired) {
    if (!captcha_answer || Number(captcha_answer) !== (record.captcha.a + record.captcha.b)) {
      record.captcha = newCaptcha();
      return res.status(400).json({
        success: false,
        error: 'Jawaban CAPTCHA salah',
        captcha_required: true,
        captcha: { question: captchaText(record.captcha) }
      });
    }
  }

  const result = await query(
    `SELECT id, username, password_hash, name, role, avatar_url, is_active
     FROM admin_user
     WHERE username = $1
     LIMIT 1`,
    [username]
  );

  const user = result.rows[0];

  let valid = false;
  if (user && user.is_active) {
    valid = await bcrypt.compare(password, user.password_hash);
  }

  if (!valid) {
    record.failures += 1;

    await logLogin({
      userId: user ? user.id : null,
      username,
      ip,
      ua: req.get('user-agent'),
      success: false
    });

    // 3a. Jika melebihi ambang kunci, terapkan soft lock dengan backoff eksponensial
    if (record.failures >= LOCK_THRESHOLD) {
      const backoff = BASE_LOCK_MS * Math.pow(2, record.lockCount);
      record.lockCount += 1;
      record.lockUntil = Date.now() + backoff;
      return sendError(
        res,
        `Terlalu banyak percobaan login. Akses dikunci sementara selama ${Math.round(backoff / 1000)} detik.`,
        429
      );
    }

    // 3b. Jika melebihi ambang CAPTCHA, minta verifikasi CAPTCHA
    const body = { success: false, error: 'Username atau Kata Sandi Salah' };
    if (record.failures >= CAPTCHA_THRESHOLD) {
      record.captchaRequired = true;
      record.captcha = newCaptcha();
      body.captcha_required = true;
      body.captcha = { question: captchaText(record.captcha) };
    }

    return res.status(401).json(body);
  }

  // Berhasil login -> reset pencatatan percobaan
  resetRecord(record);

  const token = jwt.sign(
    { sub: String(user.id), username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  await query(
    `UPDATE admin_user SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [user.id]
  );

  await logLogin({
    userId: user.id,
    username: user.username,
    ip,
    ua: req.get('user-agent'),
    success: true
  });

  return sendOk(res, {
    token,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      avatar_url: user.avatar_url
    }
  });
}));

router.get('/me', authRequired, asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT id, username, name, role, avatar_url, is_active, last_login_at, created_at
     FROM admin_user WHERE id = $1`,
    [req.user.sub]
  );
  if (!result.rowCount) return sendError(res, 'User not found', 404);
  return sendOk(res, result.rows[0]);
}));

router.post('/change-password', authRequired, asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return sendError(res, 'current_password and new_password are required', 422);
  if (new_password.length < 8) return sendError(res, 'New password must be at least 8 characters', 422);

  const result = await query('SELECT password_hash FROM admin_user WHERE id = $1', [req.user.sub]);
  if (!result.rowCount) return sendError(res, 'User not found', 404);

  const valid = await bcrypt.compare(current_password, result.rows[0].password_hash);
  if (!valid) return sendError(res, 'Current password is incorrect', 401);

  const hash = await bcrypt.hash(new_password, 12);
  await query('UPDATE admin_user SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [hash, req.user.sub]);

  return sendOk(res, { message: 'Password updated successfully' });
}));

module.exports = router;
