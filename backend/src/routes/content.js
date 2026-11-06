const express = require('express');
const { query } = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const {
  authRequired,
  admin1Only
} = require('../middleware/auth');
const { sendOk, sendError } = require('../utils/http');

const router = express.Router();

const VALID_TYPES = new Set([
  'tentang_desa',
  'sejarah_desa',
  'visi_misi',
  'geografis',
  'anggaran_desa'
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

// PUBLIC
router.get('/', asyncHandler(async (req, res) => {
  const {
    type
  } = req.query;

  const status = 'published';

  if (type && !VALID_TYPES.has(type)) {
    return sendError(res, 'Invalid content type', 422);
  }

  const params = [status];

  let sql = `
    SELECT
      id,
      content_type,
      title,
      slug,
      content,
      cover_image_url,
      metadata,
      status,
      created_by,
      created_at,
      updated_at
    FROM village_content
    WHERE status = $1
  `;

  if (type) {
    params.push(type);
    sql += ` AND content_type = $${params.length}`;
  }

  sql += ' ORDER BY id';

  return sendOk(
    res,
    (await query(sql, params)).rows
  );
}));

// PUBLIC
router.get('/:slug', asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT
      id,
      content_type,
      title,
      slug,
      content,
      cover_image_url,
      metadata,
      status,
      created_by,
      created_at,
      updated_at
    FROM village_content
    WHERE slug = $1
      AND status = 'published'
    LIMIT 1
  `, [req.params.slug]);

  if (!result.rowCount) {
    return sendError(res, 'Content not found', 404);
  }

  const content = result.rows[0];

  if (content.content_type === 'sejarah_desa') {
    const [timeline, sites] = await Promise.all([
      query(`
        SELECT *
        FROM history_timeline
        WHERE content_id = $1
        ORDER BY sort_order, step_number
      `, [content.id]),

      query(`
        SELECT *
        FROM heritage_site
        WHERE content_id = $1
        ORDER BY sort_order, id
      `, [content.id])
    ]);

    content.timeline = timeline.rows;
    content.heritage_sites = sites.rows;
  }

  return sendOk(res, content);
}));

// ADMIN 1 - GET HISTORY TIMELINE
router.get(
  '/:contentId/timeline',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT
        id,
        content_id,
        step_number,
        title,
        period,
        description,
        sort_order
      FROM history_timeline
      WHERE content_id = $1
      ORDER BY sort_order, step_number`,
      [req.params.contentId]
    );

    return sendOk(res, result.rows);
  })
);

// ADMIN 1 - CREATE HISTORY TIMELINE
router.post(
  '/:contentId/timeline',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const {
      step_number,
      title,
      period = null,
      description = null,
      sort_order = 0
    } = req.body || {};

    if (
      step_number === undefined ||
      !title
    ) {
      return sendError(
        res,
        'step_number dan title wajib diisi',
        422
      );
    }

    const result = await query(
      `INSERT INTO history_timeline (
        content_id,
        step_number,
        title,
        period,
        description,
        sort_order
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING
        id,
        content_id,
        step_number,
        title,
        period,
        description,
        sort_order`,
      [
        req.params.contentId,
        step_number,
        title,
        period,
        description,
        sort_order
      ]
    );

    await logActivity({
      adminUserId: req.user.sub,
      action: 'create',
      entityType: 'history_timeline',
      entityId: result.rows[0].id,
      detail: {
        content_id: result.rows[0].content_id,
        step_number: result.rows[0].step_number,
        title: result.rows[0].title
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null
    });

    return sendOk(res, result.rows[0], 201);
  })
);

// ADMIN 1
router.post(
  '/',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const {
      content_type,
      title,
      slug,
      content = '',
      cover_image_url = null,
      metadata = {},
      status = 'published'
    } = req.body || {};

    if (
      !VALID_TYPES.has(content_type) ||
      !title ||
      !slug
    ) {
      return sendError(
        res,
        'content_type, title and slug are required',
        422
      );
    }

    const result = await query(`
      INSERT INTO village_content
      (
        content_type,
        title,
        slug,
        content,
        cover_image_url,
        metadata,
        status,
        created_by
      )
      VALUES
      ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
      RETURNING *
    `, [
      content_type,
      title,
      slug,
      content,
      cover_image_url,
      JSON.stringify(metadata),
      status,
      req.user.sub
    ]);

    await logActivity({
  adminUserId: req.user.sub,
  action: 'create',
  entityType: 'village_content',
  entityId: result.rows[0].id,
  detail: {
    content_type: result.rows[0].content_type,
    title: result.rows[0].title,
    slug: result.rows[0].slug,
    status: result.rows[0].status
  },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null
});

    return sendOk(res, result.rows[0], 201);
  })
);

// ADMIN 1
router.put(
  '/:id',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const {
      content_type,
      title,
      slug,
      content = '',
      cover_image_url = null,
      metadata = {},
      status = 'published'
    } = req.body || {};

    if (
      !VALID_TYPES.has(content_type) ||
      !title ||
      !slug
    ) {
      return sendError(
        res,
        'content_type, title and slug are required',
        422
      );
    }

    const result = await query(`
      UPDATE village_content
      SET
        content_type = $1,
        title = $2,
        slug = $3,
        content = $4,
        cover_image_url = $5,
        metadata = $6::jsonb,
        status = $7,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
    `, [
      content_type,
      title,
      slug,
      content,
      cover_image_url,
      JSON.stringify(metadata),
      status,
      req.params.id
    ]);

    if (!result.rowCount) {
      return sendError(res, 'Content not found', 404);
    }
    
    await logActivity({
  adminUserId: req.user.sub,
  action: 'update',
  entityType: 'village_content',
  entityId: result.rows[0].id,
  detail: {
    content_type: result.rows[0].content_type,
    title: result.rows[0].title,
    slug: result.rows[0].slug,
    status: result.rows[0].status
  },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null
});

    return sendOk(res, result.rows[0]);
  })
);
// ADMIN 1 - UPDATE HISTORY TIMELINE
router.put(
  '/:contentId/timeline/:id',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const {
      step_number,
      title,
      period = null,
      description = null,
      sort_order = 0
    } = req.body || {};

    if (
      step_number === undefined ||
      !title
    ) {
      return sendError(
        res,
        'step_number dan title wajib diisi',
        422
      );
    }

    const result = await query(
      `UPDATE history_timeline
       SET
         step_number = $1,
         title = $2,
         period = $3,
         description = $4,
         sort_order = $5
       WHERE id = $6
         AND content_id = $7
       RETURNING
         id,
         content_id,
         step_number,
         title,
         period,
         description,
         sort_order`,
      [
        step_number,
        title,
        period,
        description,
        sort_order,
        req.params.id,
        req.params.contentId
      ]
    );

    if (result.rowCount === 0) {
      return sendError(res, 'Timeline not found', 404);
    }

    const timeline = result.rows[0];

    await logActivity({
      adminUserId: req.user.sub,
      action: 'update',
      entityType: 'history_timeline',
      entityId: timeline.id,
      detail: {
        content_id: timeline.content_id,
        step_number: timeline.step_number,
        title: timeline.title
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null
    });

    return sendOk(res, timeline);
  })
);
// ADMIN 1 - DELETE HISTORY TIMELINE
router.delete(
  '/:contentId/timeline/:id',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const result = await query(
      `DELETE FROM history_timeline
       WHERE id = $1
         AND content_id = $2
       RETURNING
         id,
         content_id,
         step_number,
         title`,
      [
        req.params.id,
        req.params.contentId
      ]
    );

    if (result.rowCount === 0) {
      return sendError(res, 'Timeline not found', 404);
    }

    const timeline = result.rows[0];

    await logActivity({
      adminUserId: req.user.sub,
      action: 'delete',
      entityType: 'history_timeline',
      entityId: timeline.id,
      detail: {
        content_id: timeline.content_id,
        step_number: timeline.step_number,
        title: timeline.title
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null
    });

    return sendOk(res, timeline);
  })
);
// ADMIN 1 - GET HERITAGE SITES
router.get(
  '/:contentId/heritage',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT
        id,
        content_id,
        name,
        summary,
        description,
        location,
        historical_period,
        category,
        photo_url,
        latitude,
        longitude,
        sort_order
      FROM heritage_site
      WHERE content_id = $1
      ORDER BY sort_order, id`,
      [req.params.contentId]
    );

    return sendOk(res, result.rows);
  })
);

// ADMIN 1 - CREATE HERITAGE SITE
router.post(
  '/:contentId/heritage',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const {
      name,
      summary = null,
      description = null,
      location = null,
      historical_period = null,
      category = null,
      photo_url = null,
      latitude = null,
      longitude = null,
      sort_order = 0
    } = req.body || {};

    if (!name) {
      return sendError(res, 'name wajib diisi', 422);
    }

    const result = await query(
      `INSERT INTO heritage_site (
        content_id,
        name,
        summary,
        description,
        location,
        historical_period,
        category,
        photo_url,
        latitude,
        longitude,
        sort_order
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING
        id,
        content_id,
        name,
        summary,
        description,
        location,
        historical_period,
        category,
        photo_url,
        latitude,
        longitude,
        sort_order`,
      [
        req.params.contentId,
        name,
        summary,
        description,
        location,
        historical_period,
        category,
        photo_url,
        latitude,
        longitude,
        sort_order
      ]
    );

    await logActivity({
      adminUserId: req.user.sub,
      action: 'create',
      entityType: 'heritage_site',
      entityId: result.rows[0].id,
      detail: {
        content_id: result.rows[0].content_id,
        name: result.rows[0].name
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null
    });

    return sendOk(res, result.rows[0], 201);
  })
);

// ADMIN 1 - UPDATE HERITAGE SITE
router.put(
  '/:contentId/heritage/:id',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const {
      name,
      summary,
      description,
      location,
      historical_period,
      category,
      photo_url,
      latitude,
      longitude,
      sort_order
    } = req.body || {};

    if (name !== undefined && !name) {
      return sendError(res, 'name wajib diisi', 422);
    }

    const result = await query(
      `UPDATE heritage_site
       SET
         name = COALESCE($1, name),
         summary = COALESCE($2, summary),
         description = COALESCE($3, description),
         location = COALESCE($4, location),
         historical_period = COALESCE($5, historical_period),
         category = COALESCE($6, category),
         photo_url = COALESCE($7, photo_url),
         latitude = COALESCE($8, latitude),
         longitude = COALESCE($9, longitude),
         sort_order = COALESCE($10, sort_order)
       WHERE id = $11
         AND content_id = $12
       RETURNING
         id,
         content_id,
         name,
         summary,
         description,
         location,
         historical_period,
         category,
         photo_url,
         latitude,
         longitude,
         sort_order`,
      [
        name ?? null,
        summary ?? null,
        description ?? null,
        location ?? null,
        historical_period ?? null,
        category ?? null,
        photo_url ?? null,
        latitude ?? null,
        longitude ?? null,
        sort_order ?? null,
        req.params.id,
        req.params.contentId
      ]
    );

    if (result.rowCount === 0) {
      return sendError(res, 'Heritage site not found', 404);
    }

    const site = result.rows[0];

    await logActivity({
      adminUserId: req.user.sub,
      action: 'update',
      entityType: 'heritage_site',
      entityId: site.id,
      detail: {
        content_id: site.content_id,
        name: site.name
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null
    });

    return sendOk(res, site);
  })
);

// ADMIN 1 - DELETE HERITAGE SITE
router.delete(
  '/:contentId/heritage/:id',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const result = await query(
      `DELETE FROM heritage_site
       WHERE id = $1
         AND content_id = $2
       RETURNING
         id,
         content_id,
         name`,
      [
        req.params.id,
        req.params.contentId
      ]
    );

    if (result.rowCount === 0) {
      return sendError(res, 'Heritage site not found', 404);
    }

    const site = result.rows[0];

    await logActivity({
      adminUserId: req.user.sub,
      action: 'delete',
      entityType: 'heritage_site',
      entityId: site.id,
      detail: {
        content_id: site.content_id,
        name: site.name
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null
    });

    return sendOk(res, site);
  })
);

// ADMIN 1
router.delete(
  '/:id',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const result = await query(
      `DELETE FROM village_content
       WHERE id = $1
       RETURNING id`,
      [req.params.id]
    );

    if (!result.rowCount) {
      return sendError(res, 'Content not found', 404);
    }
    
    await logActivity({
  adminUserId: req.user.sub,
  action: 'delete',
  entityType: 'village_content',
  entityId: result.rows[0].id,
  detail: {
    deleted: true
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