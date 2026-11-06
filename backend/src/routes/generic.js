const express = require('express');
const { query } = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { authRequired, admin1Only } = require('../middleware/auth');
const { sendOk, sendError } = require('../utils/http');

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

function createCrudRouter({
  table,
  orderBy = 'id',
  writableFields = []
}) {
  const router = express.Router();

  // PUBLIC
  router.get('/', asyncHandler(async (req, res) => {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || '20', 10), 1),
      100
    );

    const offset = (page - 1) * limit;

    const total = await query(
      `SELECT COUNT(*)::int AS count FROM ${table}`
    );

    const rows = await query(
      `SELECT * FROM ${table}
       ORDER BY ${orderBy}
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return sendOk(res, {
      items: rows.rows,
      pagination: {
        page,
        limit,
        total: total.rows[0].count
      }
    });
  }));

  // PUBLIC
  router.get('/:id', asyncHandler(async (req, res) => {
    const result = await query(
      `SELECT * FROM ${table} WHERE id = $1`,
      [req.params.id]
    );

    if (!result.rowCount) {
      return sendError(res, 'Data not found', 404);
    }

    return sendOk(res, result.rows[0]);
  }));

  // ADMIN 1 ONLY
  router.post(
    '/',
    authRequired,
    admin1Only,
    asyncHandler(async (req, res) => {
      const entries = writableFields
        .map((field) => [field, req.body?.[field]])
        .filter(([, value]) => value !== undefined);

      if (!entries.length) {
        return sendError(res, 'No writable fields supplied', 422);
      }

      const columns = entries
        .map(([field]) => field)
        .join(', ');

      const values = entries.map(([, value]) => value);

      const placeholders = values
        .map((_, i) => `$${i + 1}`)
        .join(', ');

      const result = await query(
        `INSERT INTO ${table} (${columns})
         VALUES (${placeholders})
         RETURNING *`,
        values
      );

      await logActivity({
  adminUserId: req.user.sub,
  action: 'create',
  entityType: table,
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

  // ADMIN 1 ONLY
  router.put(
    '/:id',
    authRequired,
    admin1Only,
    asyncHandler(async (req, res) => {
      if (!/^\d+$/.test(req.params.id)) {
        return sendError(res, 'Data not found', 404);
      }

      const entries = writableFields
        .map((field) => [field, req.body?.[field]])
        .filter(([, value]) => value !== undefined);

      if (!entries.length) {
        return sendError(res, 'No writable fields supplied', 422);
      }

      const values = entries.map(([, value]) => value);

      const sets = entries
        .map(([field], i) => `${field} = $${i + 1}`)
        .join(', ');

      values.push(req.params.id);

      const result = await query(
        `UPDATE ${table}
         SET ${sets}
         WHERE id = $${values.length}
         RETURNING *`,
        values
      );

      if (!result.rowCount) {
        return sendError(res, 'Data not found', 404);
      }

      await logActivity({
  adminUserId: req.user.sub,
  action: 'update',
  entityType: table,
  entityId: result.rows[0].id,
  detail: {
    updated: true
  },
  ipAddress: req.ip,
  userAgent: req.get('user-agent') || null
});

      return sendOk(res, result.rows[0]);
    })
  );

  // ADMIN 1 ONLY
  router.delete(
    '/:id',
    authRequired,
    admin1Only,
    asyncHandler(async (req, res) => {
      if (!/^\d+$/.test(req.params.id)) {
        return sendError(res, 'Data not found', 404);
      }

      const result = await query(
        `DELETE FROM ${table}
         WHERE id = $1
         RETURNING id`,
        [req.params.id]
      );

      if (!result.rowCount) {
        return sendError(res, 'Data not found', 404);
      }
      
      await logActivity({
  adminUserId: req.user.sub,
  action: 'delete',
  entityType: table,
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

  return router;
}

module.exports = createCrudRouter;