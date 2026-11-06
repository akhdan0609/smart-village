const express = require('express');
const { pool, query } = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const {
  authRequired,
  admin1Only
} = require('../middleware/auth');
const { sendOk, sendError } = require('../utils/http');

const router = express.Router();

const BACKUP_FORMAT = 'smartvillage-db-backup';
const BACKUP_VERSION = 1;
const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Daftar seluruh tabel base (bukan view) pada schema public.
 */
async function listTables() {
  const result = await query(
    `SELECT c.relname AS name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
     ORDER BY c.relname`
  );
  return result.rows.map((r) => r.name);
}

/**
 * Kolom yang aman ditulis saat restore.
 *
 * Kolom STORED GENERATED tidak dapat di-INSERT sehingga dikecualikan.
 * Kolom IDENTITY ALWAYS tetap disertakan (mirip pg_dump) karena id perlu
 * dipertahankan agar relasi foreign key tetap konsisten; saat penulisan
 * diperlukan klausa OVERRIDING SYSTEM VALUE.
 */
async function listWritableColumns(table) {
  const result = await query(
    `SELECT a.attname AS name
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attgenerated = ''
     ORDER BY a.attnum`,
    [table]
  );
  return result.rows.map((r) => r.name);
}

/**
 * Semua kolom diekspor sebagai text (gaya COPY text format).
 * Pendekatan ini lossless untuk date/timestamp tanpa pergeseran timezone,
 * json/jsonb, array, boolean, dan numeric sekaligus.
 */
async function exportTable(table, columns) {
  const selectList = columns
    .map((c) => `"${c}"::text`)
    .join(', ');
  const result = await query(
    `SELECT ${selectList} FROM "${table}"`
  );
  return result.rows;
}

/**
 * Peta dependensi foreign key antar tabel pada schema public.
 * Mengembalikan daftar { parent, child }.
 */
async function getForeignKeyEdges() {
  const result = await query(
    `SELECT parent.relname AS parent, child.relname AS child
     FROM pg_constraint con
     JOIN pg_class child ON child.oid = con.conrelid
     JOIN pg_class parent ON parent.oid = con.confrelid
     JOIN pg_namespace n ON n.oid = child.relnamespace
     WHERE con.contype = 'f'
       AND n.nspname = 'public'`
  );
  return result.rows;
}

/**
 * Urutkan tabel agar parent (tabel yang direferensikan) selalu
 * di-INSERT lebih dulu daripada child-nya, sehingga tidak ada
 * pelanggaran foreign key saat restore.
 */
function sortTablesByDependency(tables, edges) {
  const tableSet = new Set(tables);
  const parents = new Map();
  for (const table of tables) parents.set(table, new Set());

  for (const { parent, child } of edges) {
    if (tableSet.has(child) && tableSet.has(parent)) {
      parents.get(child).add(parent);
    }
  }

  const sorted = [];
  const remaining = new Set(tables);

  while (remaining.size > 0) {
    let picked = null;
    for (const table of remaining) {
      const blocking = [...parents.get(table)].filter((p) =>
        remaining.has(p)
      );
      if (blocking.length === 0) {
        picked = table;
        break;
      }
    }
    // Siklus FK: ambil tabel pertama agar restore tetap berjalan
    if (!picked) picked = remaining.values().next().value;
    sorted.push(picked);
    remaining.delete(picked);
  }

  return sorted;
}

/**
 * Reset sequence identity setelah restore.
 *
 * TRUNCATE ... RESTART IDENTITY tidak dapat dipakai karena PostgreSQL
 * mensyaratkan kepemilikan sequence, sedangkan aplikasi berjalan memakai
 * role aplikasi (bukan pemilik tabel). Sebagai gantinya, sequence di-set
 * manual ke max(id) + 1 memakai setval (butuh privilege UPDATE).
 */
async function resetSequences(client, tables) {
  for (const table of tables) {
    const columns = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND (
           is_identity = 'YES'
           OR column_default LIKE 'nextval(%'
         )`,
      [table]
    );

    for (const { column_name: column } of columns.rows) {
      const seq = await client.query(
        'SELECT pg_get_serial_sequence($1, $2) AS name',
        [table, column]
      );
      const sequenceName = seq.rows[0].name;
      if (!sequenceName) continue;

      // Nama sequence dari katalog sudah ber-skema (mis. public.x_seq),
      // jadi harus dikirim sebagai parameter, bukan disisipkan ke SQL.
      await client.query(
        `SELECT setval(
           $1::regclass,
           coalesce((SELECT max("${column}") FROM "${table}"), 0) + 1,
           false
         )`,
        [sequenceName]
      );
    }
  }
}

/**
 * GET /api/admin/backup
 * ADMIN 1 - unduh backup seluruh database
 */
router.get(
  '/',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const tables = await listTables();
    const data = {};
    let totalRows = 0;

    for (const table of tables) {
      const columns = await listWritableColumns(table);
      if (columns.length === 0) continue;
      const rows = await exportTable(table, columns);
      data[table] = rows;
      totalRows += rows.length;
    }

    const backup = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      created_at: new Date().toISOString(),
      created_by: req.user.username,
      table_count: Object.keys(data).length,
      row_count: totalRows,
      tables: data
    };

    const filename = `smartvillage-backup-${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19)}.json`;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    );
    res.setHeader('X-Backup-Filename', filename);

    return res.status(200).send(JSON.stringify(backup, null, 2));
  })
);

/**
 * GET /api/admin/backup/summary
 * ADMIN 1 - ringkasan isi database (untuk preview sebelum restore)
 */
router.get(
  '/summary',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const tables = await listTables();
    const summary = [];

    for (const table of tables) {
      const result = await query(
        `SELECT count(*)::int AS row_count FROM "${table}"`
      );
      summary.push({ table, row_count: result.rows[0].row_count });
    }

    return sendOk(res, {
      table_count: tables.length,
      total_rows: summary.reduce((acc, s) => acc + s.row_count, 0),
      tables: summary
    });
  })
);

/**
 * POST /api/admin/backup
 * ADMIN 1 - restore database dari file backup
 *
 * Body: { confirm: true, backup: { format, version, tables: {...} } }
 * Seluruh proses dibungkus satu transaksi: bila ada error, database
 * dikembalikan ke kondisi sebelum restore.
 */
router.post(
  '/',
  authRequired,
  admin1Only,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const backup = body.backup;

    if (body.confirm !== true) {
      return sendError(
        res,
        'Konfirmasi restore diperlukan (confirm: true)',
        422
      );
    }

    if (!backup || typeof backup !== 'object') {
      return sendError(res, 'backup tidak ditemukan di body', 422);
    }

    if (backup.format !== BACKUP_FORMAT) {
      return sendError(
        res,
        'Format file bukan backup Smart Village',
        422
      );
    }

    if (!backup.tables || typeof backup.tables !== 'object') {
      return sendError(res, 'backup.tables tidak ditemukan', 422);
    }

    const existingTables = await listTables();
    const existingSet = new Set(existingTables);

    // Validasi nama tabel terhadap whitelist tabel yang benar-benar ada
    const requestedTables = Object.keys(backup.tables);
    for (const table of requestedTables) {
      if (!IDENTIFIER_RE.test(table) || !existingSet.has(table)) {
        return sendError(
          res,
          `Tabel tidak dikenal pada database: ${table}`,
          422
        );
      }
    }

    if (requestedTables.length === 0) {
      return sendError(res, 'Backup tidak berisi tabel', 422);
    }

    const client = await pool.connect();
    const restored = {};
    let totalRows = 0;

    try {
      await client.query('BEGIN');

      // 1) Kosongkan tabel yang ada di backup
      const truncateList = requestedTables
        .map((t) => `"${t}"`)
        .join(', ');
      await client.query(`TRUNCATE TABLE ${truncateList} CASCADE`);

      // 2) Isi kembali per tabel (urutan mengikuti dependensi foreign key)
      const edges = await getForeignKeyEdges();
      const insertOrder = sortTablesByDependency(requestedTables, edges);

      for (const table of insertOrder) {
        const rows = backup.tables[table];
        if (!Array.isArray(rows)) {
          throw new Error(`Data tabel ${table} bukan array`);
        }
        if (rows.length === 0) {
          restored[table] = 0;
          continue;
        }

        // Gabungkan seluruh key yang muncul di baris backup
        const columnSet = new Set();
        for (const row of rows) {
          for (const key of Object.keys(row)) columnSet.add(key);
        }
        const columns = [...columnSet].filter((c) =>
          IDENTIFIER_RE.test(c)
        );

        if (columns.length === 0) {
          restored[table] = 0;
          continue;
        }

        const columnList = columns.map((c) => `"${c}"`).join(', ');

        // Batasi jumlah parameter per statement (< 65535)
        const chunkSize = Math.max(1, Math.floor(50000 / columns.length));
        let inserted = 0;

        for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize);
          const values = [];
          const tuples = [];

          chunk.forEach((row, rowIndex) => {
            columns.forEach((col, colIndex) => {
              const value = row[col];
              // null/undefined harus jadi SQL NULL, bukan teks "null"
              values.push(
                value === null || value === undefined
                  ? null
                  : String(value)
              );
            });
            tuples.push(
              `(${columns
                .map((_, colIndex) => `$${rowIndex * columns.length + colIndex + 1}`)
                .join(', ')})`
            );
          });

          await client.query(
            `INSERT INTO "${table}" (${columnList})
             OVERRIDING SYSTEM VALUE
             VALUES ${tuples.join(', ')}`,
            values
          );
          inserted += chunk.length;
        }

        restored[table] = inserted;
        totalRows += inserted;
      }

      // 3) Lanjutkan nomor sequence di atas nilai id tertinggi
      await resetSequences(client, requestedTables);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[backup] restore gagal:', error.message);
      return sendError(
        res,
        `Restore gagal dan dibatalkan: ${error.message}`,
        500
      );
    } finally {
      client.release();
    }

    // Log dicatat setelah COMMIT agar tidak terhapus oleh truncate
    try {
      await query(
        `INSERT INTO activity_log (
          admin_user_id, action, entity_type, detail, ip_address, user_agent
        )
        VALUES ($1, 'restore_database', 'database', $2::jsonb, $3, $4)`,
        [
          req.user.sub,
          JSON.stringify({
            tables: Object.keys(restored).length,
            rows: totalRows,
            source_created_at: backup.created_at || null,
            source_created_by: backup.created_by || null
          }),
          req.ip,
          req.get('user-agent') || null
        ]
      );
    } catch (error) {
      console.error('[backup] log activity gagal:', error.message);
    }

    return sendOk(res, {
      tables_restored: Object.keys(restored).length,
      rows_restored: totalRows,
      detail: restored
    });
  })
);

module.exports = router;
