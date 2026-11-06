const express = require('express');
const { query } = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const {
  authRequired,
  admin1Only
} = require('../middleware/auth');
const { sendOk, sendError } = require('../utils/http');
const {
  notifyByStatus,
  getWaSettings,
  DEFAULT_TEMPLATES
} = require('../utils/whatsapp');

const router = express.Router();

const VALID_STATUSES = new Set([
  'submitted',
  'processing',
  'approved',
  'rejected',
  'completed'
]);

const COMMENT_STATUSES = new Set([
  'pending',
  'approved',
  'rejected'
]);

async function logActivity({
  adminUserId,
  action,
  entityType,
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
      entityType,
      entityId,
      JSON.stringify(detail),
      ipAddress,
      userAgent
    ]
  );
}

/* =========================================================
   CERTIFICATE REQUEST
   ========================================================= */

// PUBLIC - submit certificate request
router.post(
  '/certificate-requests',
  asyncHandler(async (req, res) => {
    const {
      certificate_type_id,
      applicant_name,
      nik,
      family_card_number = null,
      birth_place_date = null,
      gender = null,
      occupation = null,
      religion = null,
      full_address = null,
      rt = null,
      rw = null,
      hamlet = null,
      whatsapp = null,
      purpose = null
    } = req.body || {};

    if (!certificate_type_id) {
      return sendError(res, 'certificate_type_id is required', 422);
    }

    if (!applicant_name) {
      return sendError(res, 'applicant_name is required', 422);
    }

    if (!nik) {
      return sendError(res, 'nik is required', 422);
    }

    if (!/^[0-9]{16}$/.test(String(nik))) {
      return sendError(res, 'nik must contain exactly 16 digits', 422);
    }

    if (
      family_card_number !== null &&
      !/^[0-9]{16}$/.test(String(family_card_number))
    ) {
      return sendError(
        res,
        'family_card_number must contain exactly 16 digits',
        422
      );
    }

    const typeResult = await query(
      `SELECT id
       FROM certificate_type
       WHERE is_active = TRUE
         AND ((id::text = $1) OR (UPPER(code) = UPPER($1)))
       LIMIT 1`,
      [String(certificate_type_id)]
    );

    if (!typeResult.rowCount) {
      return sendError(res, 'Certificate type not found', 404);
    }

    const certificateTypeId = typeResult.rows[0].id;

    const registrationNumber =
      `SK-${Date.now()}-${Math.floor(Math.random() * 1000)
        .toString()
        .padStart(3, '0')}`;

    const result = await query(
      `INSERT INTO certificate_request (
        registration_number,
        certificate_type_id,
        applicant_name,
        nik,
        family_card_number,
        birth_place_date,
        gender,
        occupation,
        religion,
        full_address,
        rt,
        rw,
        hamlet,
        whatsapp,
        purpose
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15
      )
      RETURNING
        id,
        registration_number,
        applicant_name,
        status,
        submitted_at`,
      [
        registrationNumber,
        certificateTypeId,
        applicant_name,
        nik,
        family_card_number,
        birth_place_date,
        gender,
        occupation,
        religion,
        full_address,
        rt,
        rw,
        hamlet,
        whatsapp,
        purpose
      ]
    );

    // Kirim notifikasi WhatsApp "pengajuan masuk" (fire-and-forget)
    notifyByStatus({
      whatsapp,
      applicantName: applicant_name,
      status: 'submitted',
      officerNotes: null
    });

    return sendOk(res, result.rows[0], 201);
  })
);

// PUBLIC - check certificate request status
router.get(
  '/certificate-requests/:registration_number',
  asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT
        cr.registration_number,
        cr.applicant_name,
        ct.code AS certificate_code,
        ct.name AS certificate_name,
        cr.status,
        cr.officer_notes,
        cr.official_letter_number,
        cr.submitted_at,
        cr.completed_at
      FROM certificate_request cr
      JOIN certificate_type ct
        ON ct.id = cr.certificate_type_id
      WHERE cr.registration_number = $1
         OR cr.nik = $1
      ORDER BY cr.submitted_at DESC, cr.id DESC
      LIMIT 1`,
      [req.params.registration_number]
    );

    if (!result.rowCount) {
      return sendError(res, 'Certificate request not found', 404);
    }

    return sendOk(res, result.rows[0]);
  })
);

// ADMIN 1 - list certificate requests
router.get(
  '/certificate-requests',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT
        cr.*,
        ct.code AS certificate_code,
        ct.name AS certificate_name
      FROM certificate_request cr
      JOIN certificate_type ct
        ON ct.id = cr.certificate_type_id
      ORDER BY cr.submitted_at DESC, cr.id DESC`
    );

    return sendOk(res, result.rows);
  })
);

// ADMIN 1 - update certificate status
router.patch(
  '/certificate-requests/:id/status',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const { status, officer_notes, official_letter_number } =
      req.body || {};

    if (!/^\d+$/.test(String(req.params.id))) {
      return sendError(res, 'Certificate request not found', 404);
    }

    if (!status) {
      return sendError(res, 'status is required', 422);
    }

    if (!VALID_STATUSES.has(status)) {
      return sendError(res, 'Invalid certificate status', 422);
    }

    const result = await query(
      `UPDATE certificate_request
       SET
         status = $1::varchar(30),
         officer_notes = COALESCE($2, officer_notes),
         official_letter_number = COALESCE(
           $3,
           official_letter_number
         ),
         processed_by = $4,
         completed_at = CASE
             WHEN $1::varchar(30) = 'completed'
             THEN CURRENT_TIMESTAMP
           ELSE completed_at
         END
       WHERE id = $5
       RETURNING
         id,
         registration_number,
         applicant_name,
         whatsapp,
         status,
         officer_notes,
         official_letter_number,
         submitted_at,
         completed_at`,
      [
        status,
        officer_notes ?? null,
        official_letter_number ?? null,
        req.user.sub,
        req.params.id
      ]
    );

    if (!result.rowCount) {
      return sendError(res, 'Certificate request not found', 404);
    }

    // Kirim notifikasi WhatsApp sesuai status baru (fire-and-forget)
    notifyByStatus({
      whatsapp: result.rows[0].whatsapp,
      applicantName: result.rows[0].applicant_name,
      status: result.rows[0].status,
      officerNotes: result.rows[0].officer_notes
    });

    await logActivity({
      adminUserId: req.user.sub,
      action: 'update_status',
      entityType: 'certificate_request',
      entityId: req.params.id,
      detail: {
        status,
        registration_number: result.rows[0].registration_number
      },
            ipAddress: req.ip,
      userAgent: req.get('user-agent') || null
    });

    return sendOk(res, result.rows[0]);
  })
);

// ADMIN 1 - delete certificate request (hanya yang statusnya rejected)
router.delete(
  '/certificate-requests/:id',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    if (!/^\d+$/.test(String(req.params.id))) {
      return sendError(res, 'Certificate request not found', 404);
    }

    const result = await query(
      `DELETE FROM certificate_request
       WHERE id = $1
         AND status = $2::varchar(30)
       RETURNING id, registration_number, applicant_name, status`,
      [req.params.id, 'rejected']
    );

    if (!result.rowCount) {
      const current = await query(
        `SELECT status FROM certificate_request WHERE id = $1`,
        [req.params.id]
      );

      if (!current.rowCount) {
        return sendError(res, 'Pengajuan surat tidak ditemukan', 404);
      }

      return sendError(
        res,
        'Hanya pengajuan dengan status "Ditolak" yang bisa dihapus',
        409
      );
    }

    const deleted = result.rows[0];

    await logActivity({
      adminUserId: req.user.sub,
      action: 'delete',
      entityType: 'certificate_request',
      entityId: deleted.id,
      detail: {
        registration_number: deleted.registration_number,
        applicant_name: deleted.applicant_name,
        status: deleted.status
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null
    });

    return sendOk(res, { id: deleted.id });
  })
);

/* =========================================================
   MARRIAGE SERVICE
   ========================================================= */

// PUBLIC - submit marriage service
router.post(
  '/marriage-services',
  asyncHandler(async (req, res) => {
    const {
      groom_name,
      groom_nik,
      bride_name,
      bride_nik,
      marriage_date = null,
      marriage_place = null,
      whatsapp = null
    } = req.body || {};

    if (!groom_name) {
      return sendError(res, 'groom_name is required', 422);
    }

    if (!groom_nik) {
      return sendError(res, 'groom_nik is required', 422);
    }

    if (!bride_name) {
      return sendError(res, 'bride_name is required', 422);
    }

    if (!bride_nik) {
      return sendError(res, 'bride_nik is required', 422);
    }

    if (!/^[0-9]{16}$/.test(String(groom_nik))) {
      return sendError(
        res,
        'groom_nik must contain exactly 16 digits',
        422
      );
    }

    if (!/^[0-9]{16}$/.test(String(bride_nik))) {
      return sendError(
        res,
        'bride_nik must contain exactly 16 digits',
        422
      );
    }

    const registrationNumber =
      `NK-${Date.now()}-${Math.floor(Math.random() * 1000)
        .toString()
        .padStart(3, '0')}`;

    const result = await query(
      `INSERT INTO marriage_service (
        registration_number,
        groom_name,
        groom_nik,
        bride_name,
        bride_nik,
        marriage_date,
        marriage_place,
        whatsapp
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING
        id,
        registration_number,
        groom_name,
        bride_name,
        marriage_date,
        marriage_place,
        status,
        submitted_at`,
      [
        registrationNumber,
        groom_name,
        groom_nik,
        bride_name,
        bride_nik,
        marriage_date,
        marriage_place,
        whatsapp
      ]
    );

    // Kirim notifikasi WhatsApp "pengajuan masuk" (fire-and-forget)
    notifyByStatus({
      whatsapp,
      applicantName: [groom_name, bride_name].filter(Boolean).join(' & '),
      status: 'submitted',
      officerNotes: null
    });

    return sendOk(res, result.rows[0], 201);
  })
);

// PUBLIC - check marriage service status
router.get(
  '/marriage-services/:registration_number',
  asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT
        registration_number,
        groom_name,
        bride_name,
        marriage_date,
        marriage_place,
        status,
        officer_notes,
        submitted_at,
        completed_at
      FROM marriage_service
      WHERE registration_number = $1
      LIMIT 1`,
      [req.params.registration_number]
    );

    if (!result.rowCount) {
      return sendError(res, 'Marriage service not found', 404);
    }

    return sendOk(res, result.rows[0]);
  })
);

// ADMIN 1 - list marriage services
router.get(
  '/marriage-services',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT *
       FROM marriage_service
       ORDER BY submitted_at DESC, id DESC`
    );

    return sendOk(res, result.rows);
  })
);

// ADMIN 1 - update marriage status
router.patch(
  '/marriage-services/:id/status',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const { status, officer_notes, document_url } =
      req.body || {};

    if (!/^\d+$/.test(String(req.params.id))) {
      return sendError(res, 'Marriage service not found', 404);
    }

    if (!status) {
      return sendError(res, 'status is required', 422);
    }

    if (!VALID_STATUSES.has(status)) {
      return sendError(res, 'Invalid marriage status', 422);
    }

    const result = await query(
      `UPDATE marriage_service
       SET
         status = $1::varchar(30),
         officer_notes = COALESCE($2, officer_notes),
         document_url = COALESCE($3, document_url),
         processed_by = $4,
         completed_at = CASE
           WHEN $1::varchar(30) = 'completed'
             THEN CURRENT_TIMESTAMP
           ELSE completed_at
         END
       WHERE id = $5
       RETURNING
         id,
         registration_number,
         groom_name,
         bride_name,
         marriage_date,
         marriage_place,
         status,
         officer_notes,
         document_url,
         whatsapp,
         submitted_at,
         completed_at`,
      [
        status,
        officer_notes ?? null,
        document_url ?? null,
        req.user.sub,
        req.params.id
      ]
    );

    if (!result.rowCount) {
      return sendError(res, 'Marriage service not found', 404);
    }

    const updated = result.rows[0];

    // Kirim notifikasi WhatsApp perubahan status (fire-and-forget)
    notifyByStatus({
      whatsapp: updated.whatsapp,
      applicantName: [updated.groom_name, updated.bride_name]
        .filter(Boolean)
        .join(' & '),
      status: updated.status,
      officerNotes: updated.officer_notes
    });

    await logActivity({
      adminUserId: req.user.sub,
      action: 'update_status',
      entityType: 'marriage_service',
      entityId: req.params.id,
      detail: {
        status,
        registration_number: updated.registration_number
      },
            ipAddress: req.ip,
      userAgent: req.get('user-agent') || null
    });

    return sendOk(res, updated);
  })
);

/* =========================================================
   COMMENTS
   ========================================================= */

// PUBLIC - submit comment
router.post(
  '/comments',
  asyncHandler(async (req, res) => {
    const {
      press_release_id = null,
      name,
      content
    } = req.body || {};

    if (!name) {
      return sendError(res, 'name is required', 422);
    }

    if (!content) {
      return sendError(res, 'content is required', 422);
    }

    if (press_release_id) {
      const pressRelease = await query(
        `SELECT id
         FROM press_release
         WHERE id = $1
         LIMIT 1`,
        [press_release_id]
      );

      if (!pressRelease.rowCount) {
        return sendError(res, 'Press release not found', 404);
      }
    }

    const result = await query(
      `INSERT INTO comment (
        press_release_id,
        name,
        content
      )
      VALUES ($1, $2, $3)
      RETURNING
        id,
        press_release_id,
        name,
        content,
        status,
        created_at`,
      [
        press_release_id,
        name,
        content
      ]
    );

    return sendOk(res, result.rows[0], 201);
  })
);

// PUBLIC - approved comments only
router.get(
  '/comments',
  asyncHandler(async (req, res) => {
    const { press_release_id } = req.query;

    let sql = `
      SELECT
        c.id,
        c.press_release_id,
        c.name,
        c.content,
        c.status,
        c.admin_reply,
        c.replied_at,
        c.created_at,
        c.moderated_by,
        a.name as moderated_by_name
      FROM comment c
      LEFT JOIN admin_user a ON c.moderated_by = a.id
      WHERE c.status = 'approved'
    `;

    const params = [];

    if (press_release_id) {
      params.push(press_release_id);
      sql += ` AND c.press_release_id = $1`;
    }

    sql += ` ORDER BY c.created_at DESC, c.id DESC`;

    const result = await query(sql, params);

    return sendOk(res, result.rows);
  })
);

// ADMIN 1 - all comments
router.get(
  '/admin/comments',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT
         c.*,
         a.name as moderated_by_name
       FROM comment c
       LEFT JOIN admin_user a ON c.moderated_by = a.id
       ORDER BY c.created_at DESC, c.id DESC`
    );

    return sendOk(res, result.rows);
  })
);

// ADMIN 1 - moderate comment
router.patch(
  '/admin/comments/:id/status',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    console.log('PATCH /admin/comments/:id/status body:', JSON.stringify(req.body));
    console.log('req.user:', req.user);
    const { status, admin_reply } = req.body || {};

    if (status && !COMMENT_STATUSES.has(status)) {
      return sendError(res, 'Invalid comment status', 422);
    }

    if (admin_reply !== undefined && admin_reply === '') {
      return sendError(res, 'admin_reply cannot be empty', 422);
    }

    const adminReplyValue = admin_reply !== undefined && admin_reply !== null && admin_reply !== '' ? admin_reply : '';
    const hasReply = admin_reply !== undefined && admin_reply !== null && admin_reply !== '';
    const now = new Date();

    const result = await query(
      `UPDATE comment
       SET
         status = COALESCE($1, status),
         moderated_by = $2::bigint,
         admin_reply = $3::text,
         replied_at = $4::timestamptz,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $5::bigint
       RETURNING *`,
      [
        status,
        req.user.sub,
        adminReplyValue,
        hasReply ? now : null,
        req.params.id
      ]
    );

    if (!result.rowCount) {
      return sendError(res, 'Comment not found', 404);
    }

    await logActivity({
      adminUserId: req.user.sub,
      action: 'moderate',
      entityType: 'comment',
      entityId: req.params.id,
      detail: {
        status: result.rows[0].status,
        replied: result.rows[0].admin_reply ? true : false
      }
    });

    return sendOk(res, result.rows[0]);
  })
);

// ADMIN 1 - delete comment (hapus pengaduan / kritik-saran)
router.delete(
  '/admin/comments/:id',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const result = await query(
      `DELETE FROM comment
       WHERE id = $1
       RETURNING id`,
      [req.params.id]
    );

    if (!result.rowCount) {
      return sendError(res, 'Comment not found', 404);
    }

    await logActivity({
      adminUserId: req.user.sub,
      action: 'delete',
      entityType: 'comment',
      entityId: result.rows[0].id,
      detail: {
        deleted: true
      }
    });

    return sendOk(res, {
      id: result.rows[0].id
    });
  })
);

/* =========================================================
   WHATSAPP GATEWAY & TEMPLATE (Admin 1 only)
   ========================================================= */

function maskToken(token) {
  if (!token) return null;
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

// GET /admin/wa-config — kembalikan konfigurasi gateway (token di-mask) + template
router.get(
  '/admin/wa-config',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const { gateway, templates } = await getWaSettings();
    return sendOk(res, {
      gateway: {
        provider: gateway.provider || 'fonnte',
        sender: gateway.sender || '',
        has_token: !!gateway.token,
        token_masked: maskToken(gateway.token)
      },
      templates
    });
  })
);

// PUT /admin/wa-config — simpan konfigurasi gateway + template
router.put(
  '/admin/wa-config',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const { gateway, templates } = req.body || {};
    const current = await getWaSettings();

    if (gateway) {
      const nextGateway = { ...(current.gateway || {}) };
      if (typeof gateway.provider === 'string' && gateway.provider) {
        nextGateway.provider = gateway.provider;
      }
      if (typeof gateway.sender === 'string') {
        nextGateway.sender = gateway.sender;
      }
      // Token hanya ditimpa bila dikirim nilai baru (tidak kosong)
      if (typeof gateway.token === 'string' && gateway.token.trim()) {
        nextGateway.token = gateway.token.trim();
      }

      await query(
        `INSERT INTO site_setting (key, value, updated_at)
         VALUES ('wa_gateway', $1::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [JSON.stringify(nextGateway)]
      );
    }

    if (templates && typeof templates === 'object' && !Array.isArray(templates)) {
      const nextTemplates = { ...DEFAULT_TEMPLATES, ...templates };
      await query(
        `INSERT INTO site_setting (key, value, updated_at)
         VALUES ('wa_templates', $1::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [JSON.stringify(nextTemplates)]
      );
    }

    const saved = await getWaSettings();
    return sendOk(res, {
      gateway: {
        provider: saved.gateway.provider || 'fonnte',
        sender: saved.gateway.sender || '',
        has_token: !!saved.gateway.token,
        token_masked: maskToken(saved.gateway.token)
      },
      templates: saved.templates
    });
  })
);

module.exports = router;
