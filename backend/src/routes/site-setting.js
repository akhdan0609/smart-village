const express = require('express');
const { query } = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { authRequired, admin1Only } = require('../middleware/auth');
const { sendOk, sendError } = require('../utils/http');

const router = express.Router();

/**
 * GET /api/site-settings
 * Public
 *
 * Mengambil seluruh konfigurasi website.
 * Data ini hanya untuk dibaca oleh frontend.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT key, value, updated_at
       FROM site_setting
       WHERE key NOT LIKE 'wa\\_%' ESCAPE '\\'
       ORDER BY key`
    );

    return sendOk(res, result.rows);
  })
);

/**
 * GET /api/site-settings/:key
 * Public
 *
 * Mengambil satu konfigurasi berdasarkan key.
 */
router.get(
  '/:key',
  asyncHandler(async (req, res) => {
    if (/^wa_/i.test(req.params.key)) {
      return sendError(res, 'Setting not found', 404);
    }

    const result = await query(
      `SELECT key, value, updated_at
       FROM site_setting
       WHERE key = $1`,
      [req.params.key]
    );

    if (!result.rowCount) {
      return sendError(res, 'Setting not found', 404);
    }

    return sendOk(res, result.rows[0]);
  })
);

/**
 * PUT /api/site-settings/:key
 * ADMIN 1 ONLY
 *
 * Menyimpan/mengubah value setting (upsert berdasarkan key).
 */
router.put(
  '/:key',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    if (
      req.body?.value === undefined ||
      req.body?.value === null ||
      typeof req.body.value !== 'object' ||
      Array.isArray(req.body.value)
    ) {
      return sendError(res, 'Setting value must be a JSON object', 422);
    }

    const result = await query(
      `INSERT INTO site_setting (key, value, updated_at)
       VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (key)
       DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = CURRENT_TIMESTAMP
       RETURNING key, value, updated_at`,
      [
        req.params.key,
        JSON.stringify(req.body.value)
      ]
    );

    await query(
  `INSERT INTO activity_log (
    admin_user_id,
    action,
    entity_type,
    detail,
    ip_address,
    user_agent
  )
  VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
  [
    req.user.sub,
    'update',
    'site_setting',
    JSON.stringify({
      key: req.params.key,
      updated: true
    }),
    req.ip,
    req.get('user-agent') || null
  ]
);

    return sendOk(res, result.rows[0]);
  })
);

/**
 * DELETE /api/site-settings/:key
 * ADMIN 1 ONLY
 *
 * Menghapus setting berdasarkan key.
 */
router.delete(
  '/:key',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const result = await query(
      `DELETE FROM site_setting
       WHERE key = $1
       RETURNING key`,
      [req.params.key]
    );

    if (!result.rowCount) {
      return sendError(res, 'Setting not found', 404);
    }

    return sendOk(res, { key: result.rows[0].key, deleted: true });
  })
);

module.exports = router;