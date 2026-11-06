const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { authRequired, admin1Only } = require('../middleware/auth');
const { sendOk } = require('../utils/http');

const router = express.Router();

/**
 * GET /
 * ADMIN 1 ONLY
 *
 * Menampilkan seluruh akun admin.
 * Password hash TIDAK pernah dikirim ke frontend.
 */
router.get(
  '/',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT
         id,
         username,
         name,
         role,
         avatar_url,
         is_active,
         last_login_at,
         created_at,
         updated_at
       FROM admin_user
       ORDER BY id ASC`
    );

    return sendOk(res, result.rows);
  })
);

/**
 * POST /
 * ADMIN 1 ONLY
 *
 * Membuat akun admin baru.
 */
router.post(
  '/',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const {
      username,
      password,
      name,
      role,
      avatar_url
    } = req.body || {};

    if (!username || !password || !role) {
      return res.status(422).json({
        success: false,
        error: 'username, password, and role are required'
      });
    }

    if (!['admin_1', 'admin_2'].includes(role)) {
      return res.status(422).json({
        success: false,
        error: 'Invalid role'
      });
    }

    if (password.length < 8) {
      return res.status(422).json({
        success: false,
        error: 'Password must be at least 8 characters'
      });
    }

    const existing = await query(
      `SELECT id
       FROM admin_user
       WHERE username = $1`,
      [username]
    );

    if (existing.rowCount) {
      return res.status(409).json({
        success: false,
        error: 'Username already exists'
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await query(
      `INSERT INTO admin_user (
         username,
         password_hash,
         name,
         role,
         avatar_url
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING
         id,
         username,
         name,
         role,
         avatar_url,
         is_active,
         last_login_at,
         created_at,
         updated_at`,
      [
        username,
        passwordHash,
        name || null,
        role,
        avatar_url || null
      ]
    );

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
       VALUES ($1, 'create', 'admin_user', $2, $3::jsonb, $4, $5)`,
      [
        req.user.sub,
        result.rows[0].id,
        JSON.stringify({
          username,
          role
        }),
        req.ip,
        req.get('user-agent') || null
      ]
    );

    return sendOk(res, result.rows[0], 201);
  })
);

/**
 * PUT /:id
 * ADMIN 1 ONLY
 *
 * Mengubah akun admin.
 */
router.put(
  '/:id',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const {
      username,
      password,
      name,
      role,
      avatar_url,
      is_active
    } = req.body || {};

    const existing = await query(
      `SELECT *
       FROM admin_user
       WHERE id = $1`,
      [req.params.id]
    );

    if (!existing.rowCount) {
      return res.status(404).json({
        success: false,
        error: 'Admin user not found'
      });
    }

    const currentUser = existing.rows[0];

    // Admin 1 tidak boleh menonaktifkan dirinya sendiri.
    if (
      String(req.params.id) === String(req.user.sub) &&
      is_active === false
    ) {
      return res.status(400).json({
        success: false,
        error: 'You cannot deactivate your own account'
      });
    }

    if (
      role !== undefined &&
      !['admin_1', 'admin_2'].includes(role)
    ) {
      return res.status(422).json({
        success: false,
        error: 'Invalid role'
      });
    }

    if (password !== undefined && password.length < 8) {
      return res.status(422).json({
        success: false,
        error: 'Password must be at least 8 characters'
      });
    }

    // Saat mengganti kata sandi, wajib verifikasi kata sandi lama akun yang
    // diubah terlebih dahulu (keamanan tambahan).
    if (password !== undefined) {
      const { old_password } = req.body || {};

      if (!old_password || typeof old_password !== 'string' || !old_password.length) {
        return res.status(422).json({
          success: false,
          error: 'Kata sandi lama wajib diisi untuk mengganti kata sandi'
        });
      }

      const oldMatch = await bcrypt.compare(old_password, currentUser.password_hash);

      if (!oldMatch) {
        return res.status(400).json({
          success: false,
          error: 'Kata sandi lama tidak cocok'
        });
      }
    }

    if (
      username !== undefined &&
      username !== currentUser.username
    ) {
      const duplicate = await query(
        `SELECT id
         FROM admin_user
         WHERE username = $1
           AND id <> $2`,
        [username, req.params.id]
      );

      if (duplicate.rowCount) {
        return res.status(409).json({
          success: false,
          error: 'Username already exists'
        });
      }
    }

    const fields = [];
    const values = [];

    if (username !== undefined) {
      fields.push(`username = $${values.length + 1}`);
      values.push(username);
    }

    if (name !== undefined) {
      fields.push(`name = $${values.length + 1}`);
      values.push(name);
    }

    if (role !== undefined) {
      fields.push(`role = $${values.length + 1}`);
      values.push(role);
    }

    if (avatar_url !== undefined) {
      fields.push(`avatar_url = $${values.length + 1}`);
      values.push(avatar_url);
    }

    if (is_active !== undefined) {
      fields.push(`is_active = $${values.length + 1}`);
      values.push(is_active);
    }

    if (password !== undefined) {
      const passwordHash = await bcrypt.hash(password, 12);

      fields.push(`password_hash = $${values.length + 1}`);
      values.push(passwordHash);
    }

    if (!fields.length) {
      return res.status(422).json({
        success: false,
        error: 'No fields to update'
      });
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    values.push(req.params.id);

    const result = await query(
      `UPDATE admin_user
       SET ${fields.join(', ')}
       WHERE id = $${values.length}
       RETURNING
         id,
         username,
         name,
         role,
         avatar_url,
         is_active,
         last_login_at,
         created_at,
         updated_at`,
      values
    );

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
       VALUES ($1, 'update', 'admin_user', $2, $3::jsonb, $4, $5)`,
      [
        req.user.sub,
        result.rows[0].id,
        JSON.stringify({
          updated_fields: Object.keys(req.body || {}),
          password_changed: password !== undefined
        }),
        req.ip,
        req.get('user-agent') || null
      ]
    );

    return sendOk(res, result.rows[0]);
  })
);

module.exports = router;