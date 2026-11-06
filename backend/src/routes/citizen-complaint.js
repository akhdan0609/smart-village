'use strict';

const express = require('express');
const { query } = require('../db');
const { authRequired, admin1Only } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { sendOk, sendError } = require('../utils/http');
const { uploadComplaintAttachment } = require('../middleware/upload');

const router = express.Router();

/**
 * POST /api/citizen-complaints
 * Public / warga
 *
 * Warga dapat mengirim pengaduan tanpa login.
 */
router.post(
  '/',
  uploadComplaintAttachment.single('attachment'),
  asyncHandler(async (req, res) => {
   const {
  name,
  phone,
  category,
  subject,
  content
} = req.body;

const attachment_url = req.file
  ? `/uploads/complaints/${req.file.filename}`
  : null;

    if (!name || !category || !subject || !content) {
  return sendError(
    res,
    'name, category, subject, dan content wajib diisi',
    400
  );
}

if (name.length > 150) {
  return sendError(res, 'Nama maksimal 150 karakter', 400);
}

if (phone && phone.length > 50) {
  return sendError(res, 'Nomor telepon maksimal 50 karakter', 400);
}

if (category.length > 100) {
  return sendError(res, 'Kategori maksimal 100 karakter', 400);
}

if (subject.length > 200) {
  return sendError(res, 'Judul pengaduan maksimal 200 karakter', 400);
}

if (content.length > 10000) {
  return sendError(
    res,
    'Isi pengaduan maksimal 10.000 karakter',
    400
  );
}

    const result = await query(
      `INSERT INTO citizen_complaint (
        name,
        phone,
        category,
        subject,
        content,
        attachment_url
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING
        id,
        name,
        phone,
        category,
        subject,
        content,
        attachment_url,
        status,
        response,
        handled_by,
        created_at,
        updated_at`,
      [
        name,
        phone || null,
        category,
        subject,
        content,
        attachment_url || null
      ]
    );

    return sendOk(res, result.rows[0], 201);
  })
);

/**
 * GET /api/admin/citizen-complaints
 * Admin 1 only
 */
router.get(
  '/admin',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT
        c.id,
        c.name,
        c.phone,
        c.category,
        c.subject,
        c.content,
        c.attachment_url,
        c.status,
        c.response,
        c.handled_by,
        c.created_at,
        c.updated_at,
        a.username AS handled_by_username
      FROM citizen_complaint c
      LEFT JOIN admin_user a
        ON a.id = c.handled_by
      ORDER BY c.created_at DESC`
    );

    return sendOk(res, result.rows);
  })
);

/**
 * GET /api/admin/citizen-complaints/:id
 * Admin 1 only
 */
router.get(
  '/admin/:id',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT
        c.id,
        c.name,
        c.phone,
        c.category,
        c.subject,
        c.content,
        c.attachment_url,
        c.status,
        c.response,
        c.handled_by,
        c.created_at,
        c.updated_at,
        a.username AS handled_by_username
      FROM citizen_complaint c
      LEFT JOIN admin_user a
        ON a.id = c.handled_by
      WHERE c.id = $1`,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return sendError(res, 'Complaint not found', 404);
    }

    return sendOk(res, result.rows[0]);
  })
);

/**
 * PATCH /api/admin/citizen-complaints/:id
 * Admin 1 only
 *
 * Admin dapat:
 * - mengubah status
 * - memberikan response
 */
router.patch(
  '/admin/:id',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const { status, response } = req.body;

    if (
      status !== undefined &&
      ![
        'submitted',
        'processing',
        'resolved',
        'rejected'
      ].includes(status)
    ) {
      return sendError(res, 'Invalid complaint status', 400);
    }

    if (status === undefined && response === undefined) {
      return sendError(
        res,
        'status atau response wajib diisi',
        400
      );
    }

    const result = await query(
      `UPDATE citizen_complaint
       SET
         status = COALESCE($1, status),
         response = COALESCE($2, response),
         handled_by = $3,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING
         id,
         name,
         phone,
         category,
         subject,
         content,
         attachment_url,
         status,
         response,
         handled_by,
         created_at,
         updated_at`,
      [
        status ?? null,
        response ?? null,
        req.user.sub,
        req.params.id
      ]
    );

    if (result.rowCount === 0) {
      return sendError(res, 'Complaint not found', 404);
    }

    const complaint = result.rows[0];

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
        req.user.sub,
        'update',
        'citizen_complaint',
        complaint.id,
        JSON.stringify({
          status: complaint.status,
          response_updated: response !== undefined
        }),
        req.ip,
        req.get('user-agent') || null
      ]
    );

    return sendOk(res, complaint);
  })
);

module.exports = router;