const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const { uploadEmergencyPhoto } = require('../middleware/upload');
const asyncHandler = require('../utils/asyncHandler');
const { authRequired, admin1Only } = require('../middleware/auth');
const { sendOk, sendError } = require('../utils/http');

const router = express.Router();

const emergencyUploadDir = path.join(
  __dirname,
  '..',
  'uploads',
  'emergency'
);

function deleteEmergencyPhoto(photoUrl) {
  if (!photoUrl) {
    return;
  }

  const filename = path.basename(photoUrl);
  const filePath = path.join(emergencyUploadDir, filename);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

async function logActivity({
  adminUserId,
  action,
  entityId = null,
  detail = {},
  ipAddress = null,
  userAgent = null
}) {
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
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      adminUserId,
      action,
      'emergency_contact',
      entityId,
      JSON.stringify(detail),
      ipAddress,
      userAgent
    
    ]
  );
}

/**
 * GET /
 * PUBLIC
 *
 * Hanya menampilkan kontak yang aktif.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT
         id,
         photo_url,
         name,
         institution,
         category,
         hotline,
         whatsapp,
         is_24_hours,
         is_active,
         created_at,
         updated_at
       FROM emergency_contact
       WHERE is_active = TRUE
       ORDER BY id ASC`
    );

    return sendOk(res, result.rows);
  })
);

/**
 * GET /all
 * ADMIN
 *
 * Admin dapat melihat seluruh kontak,
 * termasuk yang sudah dinonaktifkan.
 */
router.get(
  '/all',
  authRequired,
  asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT *
       FROM emergency_contact
       ORDER BY id ASC`
    );

    return sendOk(res, result.rows);
  })
);

/**
 * POST /
 * ADMIN 1 ONLY
 */
router.post(
  '/',
  authRequired,
  admin1Only,
  uploadEmergencyPhoto.single('photo'),
  asyncHandler(async (req, res) => {
    const {
      name,
      institution,
      category,
      hotline,
      whatsapp,
      is_24_hours,
      is_active
    } = req.body || {};

    const photo_url = req.file
  ? `/uploads/emergency/${req.file.filename}`
  : null;

    if (!name || !category) {
      return sendError(
        res,
        'name and category are required',
        422
      );
    }

    const result = await query(
      `INSERT INTO emergency_contact (
         photo_url,
         name,
         institution,
         category,
         hotline,
         whatsapp,
         is_24_hours,
         is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        photo_url || null,
        name,
        institution || null,
        category,
        hotline || null,
        whatsapp || null,
        is_24_hours ?? false,
        is_active ?? true
      ]
    );

    await logActivity({
      adminUserId: req.user.sub,
      action: 'create',
      entityId: result.rows[0].id,
      detail: {
        created: true
      },
        ipAddress: req.ip,
        userAgent: req.get('user-agent') || null
    });

    return sendOk(res, result.rows[0], 201);
  })
);

/**
 * PUT /:id
 * ADMIN 1 ONLY
 *
 * Update data kontak.
 * - Tanpa foto baru -> foto lama dipertahankan.
 * - Dengan foto baru -> photo_url diganti ke foto baru.
 */
router.put(
  '/:id',
  authRequired,
  admin1Only,
  uploadEmergencyPhoto.single('photo'),
  asyncHandler(async (req, res) => {
    const {
      name,
      institution,
      category,
      hotline,
      whatsapp,
      is_24_hours,
      is_active,
      remove_photo
    } = req.body || {};

    const shouldRemovePhoto =
      remove_photo === 'true' || remove_photo === true;

    if (!name || !category) {
      return sendError(
        res,
        'name and category are required',
        422
      );
    }

    // Ambil data lama terlebih dahulu
    const existing = await query(
      `SELECT *
       FROM emergency_contact
       WHERE id = $1`,
      [req.params.id]
    );

    if (!existing.rowCount) {
      return sendError(
        res,
        'Emergency contact not found',
        404
      );
    }

    const oldContact = existing.rows[0];

    // Kalau ada foto baru, gunakan foto baru.
    // Kalau diminta hapus foto, set null.
    // Selain itu, pertahankan foto lama.
    const photo_url = req.file
      ? `/uploads/emergency/${req.file.filename}`
      : shouldRemovePhoto
        ? null
        : oldContact.photo_url;

    const result = await query(
      `UPDATE emergency_contact
       SET
         photo_url = $1,
         name = $2,
         institution = $3,
         category = $4,
         hotline = $5,
         whatsapp = $6,
         is_24_hours = $7,
         is_active = $8,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $9
       RETURNING *`,
      [
        photo_url,
        name,
        institution || null,
        category,
        hotline || null,
        whatsapp || null,
        is_24_hours ?? false,
        is_active ?? true,
        req.params.id
      ]
    );
    //Hapus foto lama setelah database berhasil di-update
if ((req.file || shouldRemovePhoto) && oldContact.photo_url) {
  deleteEmergencyPhoto(oldContact.photo_url);
}
    await logActivity({
      adminUserId: req.user.sub,
      action: 'update',
      entityId: result.rows[0].id,
      detail: {
        updated: true,
        photo_changed: Boolean(req.file),
        photo_removed: shouldRemovePhoto
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null
    });

    return sendOk(res, result.rows[0]);
  })
);

/**
 * DELETE /:id
 * ADMIN 1 ONLY
 *
 * Hapus kontak beserta foto yang terkait.
 */
router.delete(
  '/:id',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    // Ambil data kontak terlebih dahulu
    const existing = await query(
      `SELECT *
       FROM emergency_contact
       WHERE id = $1`,
      [req.params.id]
    );

    if (!existing.rowCount) {
      return sendError(
        res,
        'Emergency contact not found',
        404
      );
    }

    const contact = existing.rows[0];

    // Hapus data dari database
    const result = await query(
      `DELETE FROM emergency_contact
       WHERE id = $1
       RETURNING id`,
      [req.params.id]
    );

    // Setelah database berhasil dihapus,
    // hapus foto yang terkait jika ada
    if (contact.photo_url) {
      deleteEmergencyPhoto(contact.photo_url);
    }

    await logActivity({
      adminUserId: req.user.sub,
      action: 'delete',
      entityId: result.rows[0].id,
      detail: {
        deleted: true,
        photo_deleted: Boolean(contact.photo_url)
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null
    });

    return sendOk(res, {
      id: result.rows[0].id
    });
  })
);

module.exports = router;