const express = require('express');
const { pool, query } = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const {
  authRequired,
  populationAccess,
  admin2Only
} = require('../middleware/auth');

const { sendOk, sendError } = require('../utils/http');

const router = express.Router();

async function logActivity(
  req,
  action,
  entityType,
  entityId,
  detail = {}
) {
  await query(`
    INSERT INTO activity_log
      (
        admin_user_id,
        action,
        entity_type,
        entity_id,
        detail,
        ip_address,
        user_agent
      )
    VALUES
      ($1, $2, $3, $4, $5::jsonb, $6, $7)
  `, [
    req.user.sub,
    action,
    entityType,
    entityId,
    JSON.stringify(detail),
    req.ip,
    req.get('user-agent') || null
  ]);
}

const AGE_GROUPS = [
  '0-4 Tahun',
  '5-9 Tahun',
  '10-14 Tahun',
  '15-19 Tahun',
  '20-24 Tahun',
  '25-29 Tahun',
  '30-34 Tahun',
  '35-39 Tahun',
  '40-44 Tahun',
  '45-49 Tahun',
  '50-54 Tahun',
  '55-59 Tahun',
  '60-64 Tahun',
  '65-69 Tahun',
  '70-74 Tahun',
  '75+ Tahun'
];

const EDUCATION_LEVELS = [
  'Tidak/Belum Sekolah',
  'Belum Tamat SD',
  'SD/Sederajat',
  'SMP/Sederajat',
  'SMA/Sederajat',
  'Diploma I',
  'Diploma II',
  'Diploma III',
  'Diploma IV',
  'Sarjana',
  'Magister',
  'Doktor'
];

const RELIGIONS = [
  'Islam',
  'Kristen Protestan',
  'Kristen Katolik',
  'Hindu',
  'Buddha',
  'Konghucu',
  'Lainnya'
];

const BUILDING_TYPES = [
  'Layak Huni',
  'Tidak Layak Huni',
  'Bangunan Ruko'
];

async function getOrCreateReport(year) {
  let result = await query(
    `SELECT *
     FROM population_report
     WHERE report_year = $1
     LIMIT 1`,
    [year]
  );

  if (result.rowCount) {
    return result.rows[0];
  }

  result = await query(
    `INSERT INTO population_report (report_year)
     VALUES ($1)
     RETURNING *`,
    [year]
  );

  const report = result.rows[0];

  await seedRows(
    'population_age',
    'age_group',
    AGE_GROUPS,
    report.id
  );

  await seedRows(
    'population_education',
    'education_level',
    EDUCATION_LEVELS,
    report.id
  );

  await seedRows(
    'population_religion',
    'religion',
    RELIGIONS,
    report.id
  );

  await seedRows(
    'building_report',
    'building_type',
    BUILDING_TYPES,
    report.id
  );

  return report;
}

async function seedRows(
  table,
  labelColumn,
  labels,
  reportId
) {
  for (let i = 0; i < labels.length; i++) {
    await query(
      `INSERT INTO ${table}
       (report_id, ${labelColumn}, total, sort_order)
       VALUES ($1, $2, 0, $3)
       ON CONFLICT (report_id, ${labelColumn})
       DO NOTHING`,
      [reportId, labels[i], i]
    );
  }
}

const LABEL_MATCH = {
  'Dokter': 'Doktor',
  'Hunian Layak': 'Layak Huni',
  'Hunian Tidak Layak': 'Tidak Layak Huni',
  'Bangunan Ruko/Usaha': 'Bangunan Ruko'
};

const normLabel = label =>
  (LABEL_MATCH[label] || label || '').toLowerCase().replace(/[^a-z0-9]+/gi, '');

const SECTION_CONFIG = {
  umur: { table: 'population_age', labelCol: 'age_group' },
  pendidikan: { table: 'population_education', labelCol: 'education_level' },
  agama: { table: 'population_religion', labelCol: 'religion' },
  bangunan: { table: 'building_report', labelCol: 'building_type' }
};

async function recomputeAggregates(client, reportId) {
  for (const cfg of Object.values(SECTION_CONFIG)) {
    await client.query(
      `UPDATE ${cfg.table}
       SET total = 0, updated_at = CURRENT_TIMESTAMP
       WHERE report_id = $1`,
      [reportId]
    );
  }

  const agg = await client.query(
    `SELECT kategori, label, SUM(total)::int AS total
     FROM population_data
     WHERE report_id = $1
     GROUP BY kategori, label`,
    [reportId]
  );

  const byKategori = { umur: [], pendidikan: [], agama: [], bangunan: [] };
  for (const row of agg.rows) {
    if (byKategori[row.kategori]) byKategori[row.kategori].push(row);
  }

  for (const [kategori, cfg] of Object.entries(SECTION_CONFIG)) {
    const existing = await client.query(
      `SELECT id, ${cfg.labelCol} AS label
       FROM ${cfg.table}
       WHERE report_id = $1`,
      [reportId]
    );
    const map = new Map();
    for (const r of existing.rows) map.set(normLabel(r.label), r.id);
    for (const row of byKategori[kategori]) {
      const id = map.get(normLabel(row.label));
      if (!id) continue;
      await client.query(
        `UPDATE ${cfg.table}
         SET total = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [Number(row.total), id]
      );
    }
  }
}

// ============================================================
// GET REPORT
// ADMIN 1 + ADMIN 2
// ============================================================

router.get(
  '/',
  authRequired,
  populationAccess,
  asyncHandler(async (req, res) => {
    const year = Number(
      req.query.year || new Date().getFullYear()
    );

    if (!Number.isInteger(year) || year < 2000) {
      return sendError(res, 'Invalid report year', 422);
    }

    const report = await getOrCreateReport(year);

    const [
      age,
      education,
      religion,
      buildings
    ] = await Promise.all([
      query(`
        SELECT *
        FROM population_age
        WHERE report_id = $1
        ORDER BY sort_order, id
      `, [report.id]),

      query(`
        SELECT *
        FROM population_education
        WHERE report_id = $1
        ORDER BY sort_order, id
      `, [report.id]),

      query(`
        SELECT *
        FROM population_religion
        WHERE report_id = $1
        ORDER BY sort_order, id
      `, [report.id]),

      query(`
        SELECT *
        FROM building_report
        WHERE report_id = $1
        ORDER BY sort_order, id
      `, [report.id])
    ]);

    return sendOk(res, {
      report,
      age: age.rows,
      education: education.rows,
      religion: religion.rows,
      buildings: buildings.rows
    });
  })
);

// ============================================================
// GET TOTAL PENDUDUK (PUBLIK)
// Digunakan halaman Beranda publik (QuickStats) tanpa login.
// Total = jumlah penduduk dari tabel umur pada laporan terbaru.
// ============================================================

router.get(
  '/total',
  asyncHandler(async (req, res) => {
    const result = await query(`
      SELECT
        pr.id,
        pr.report_year,
        COALESCE(
          (SELECT SUM(pa.total)
           FROM population_age pa
           WHERE pa.report_id = pr.id),
          0
        ) AS total
      FROM population_report pr
      ORDER BY pr.report_year DESC
      LIMIT 1
    `);

    if (!result.rowCount) {
      return sendOk(res, { total: 0, year: null });
    }

    const row = result.rows[0];
    return sendOk(res, {
      total: Number(row.total || 0),
      year: row.report_year
    });
  })
);

// ============================================================
// GET LAPORAN PENDUDUK (PUBLIK)
// Dipakai halaman Statistik Demografi publik tanpa login.
// Membaca laporan tahun yang diminta; bila kosong mengembalikan
// daftar kosong (tidak membuat laporan baru).
// ============================================================

router.get(
  '/report',
  asyncHandler(async (req, res) => {
    const year = Number(req.query.year || new Date().getFullYear());

    if (!Number.isInteger(year) || year < 2000) {
      return sendError(res, 'Invalid report year', 422);
    }

    const result = await query(
      `SELECT *
       FROM population_report
       WHERE report_year = $1
       LIMIT 1`,
      [year]
    );

    if (!result.rowCount) {
      return sendOk(res, {
        report: null,
        age: [],
        education: [],
        religion: [],
        buildings: []
      });
    }

    const report = result.rows[0];

    const [
      age,
      education,
      religion,
      buildings
    ] = await Promise.all([
      query(`
        SELECT *
        FROM population_age
        WHERE report_id = $1
        ORDER BY sort_order, id
      `, [report.id]),

      query(`
        SELECT *
        FROM population_education
        WHERE report_id = $1
        ORDER BY sort_order, id
      `, [report.id]),

      query(`
        SELECT *
        FROM population_religion
        WHERE report_id = $1
        ORDER BY sort_order, id
      `, [report.id]),

      query(`
        SELECT *
        FROM building_report
        WHERE report_id = $1
        ORDER BY sort_order, id
      `, [report.id])
    ]);

    return sendOk(res, {
      report,
      age: age.rows,
      education: education.rows,
      religion: religion.rows,
      buildings: buildings.rows
    });
  })
);

// ============================================================
// GET ENTRIES PER RW (ADMIN 1 + ADMIN 2)
// Data kependudukan per-RW yang disimpan di database.
// ============================================================

router.get(
  '/entries',
  authRequired,
  populationAccess,
  asyncHandler(async (req, res) => {
    const year = Number(req.query.year || new Date().getFullYear());

    if (!Number.isInteger(year) || year < 2000) {
      return sendError(res, 'Invalid report year', 422);
    }

    const report = await getOrCreateReport(year);

    const result = await query(
      `SELECT *
       FROM population_data
       WHERE report_id = $1
       ORDER BY rw, kategori, id`,
      [report.id]
    );

    return sendOk(res, { report, rows: result.rows });
  })
);

// ============================================================
// PUT ENTRIES PER RW (ADMIN 2)
// Mengganti seluruh data per-RW tahun berjalan, lalu menghitung
// ulang agregat (population_age/education/religion/building_report)
// agar dashboard & statistik publik selalu sinkron.
// ============================================================

router.put(
  '/entries',
  authRequired,
  admin2Only,
  asyncHandler(async (req, res) => {
    const year = Number(req.body?.year || new Date().getFullYear());

    if (!Number.isInteger(year) || year < 2000) {
      return sendError(res, 'Invalid report year', 422);
    }

    const rows = req.body?.rows;
    if (!Array.isArray(rows)) {
      return sendError(res, 'rows array is required', 422);
    }

    const report = await getOrCreateReport(year);

    const ALLOWED = new Set(['umur', 'pendidikan', 'agama', 'bangunan']);
    const entries = [];

    for (const r of rows) {
      const rw = String(r.rw || '').trim();
      const kategori = String(r.kategori || '');
      const label = String(r.label || '').trim();
      if (!rw || !ALLOWED.has(kategori) || !label) continue;
      const laki = Math.max(0, Math.floor(Number(r.lakiLaki) || 0));
      const perempuan = Math.max(0, Math.floor(Number(r.perempuan) || 0));
      entries.push({ rw, kategori, label, lakiLaki: laki, perempuan, total: laki + perempuan });
    }

    const rwStats = new Map();
    for (const e of entries) {
      const st = rwStats.get(e.rw) || { umurL: 0, umurP: 0, pendL: 0, pendP: 0, agL: 0, agP: 0 };
      if (e.kategori === 'umur') {
        st.umurL += e.lakiLaki;
        st.umurP += e.perempuan;
      } else if (e.kategori === 'pendidikan') {
        st.pendL += e.lakiLaki;
        st.pendP += e.perempuan;
      } else if (e.kategori === 'agama') {
        st.agL += e.lakiLaki;
        st.agP += e.perempuan;
      }
      rwStats.set(e.rw, st);
    }
    for (const [rw, st] of rwStats) {
      if (st.agL !== st.umurL || st.agP !== st.umurP) {
        return sendError(
          res,
          `Total agama ${rw} harus SAMA dengan total penduduk ${rw} (laki-laki ${st.umurL}, perempuan ${st.umurP}). Saat ini laki-laki ${st.agL}, perempuan ${st.agP}.`,
          422
        );
      }
      if (st.pendL !== st.umurL || st.pendP !== st.umurP) {
        return sendError(
          res,
          `Total pendidikan ${rw} harus SAMA dengan total penduduk ${rw} (laki-laki ${st.umurL}, perempuan ${st.umurP}). Saat ini laki-laki ${st.pendL}, perempuan ${st.pendP}.`,
          422
        );
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM population_data WHERE report_id = $1',
        [report.id]
      );
      for (const e of entries) {
        await client.query(
          `INSERT INTO population_data
             (report_id, rw, kategori, label, laki_laki, perempuan, total)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [report.id, e.rw, e.kategori, e.label, e.lakiLaki, e.perempuan, e.total]
        );
      }
      await recomputeAggregates(client, report.id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const result = await query(
      `SELECT *
       FROM population_data
       WHERE report_id = $1
       ORDER BY rw, kategori, id`,
      [report.id]
    );

    console.log('PUT /entries saved rows:', result.rows.length);

    return sendOk(res, { report, rows: result.rows });
  })
);

// ============================================================
// CREATE REPORT YEAR
// ADMIN 2
// ============================================================

router.post(
  '/',
  authRequired,
  admin2Only,
  asyncHandler(async (req, res) => {
    const year = Number(req.body?.report_year);
    const notes = req.body?.notes ?? null;

    if (!Number.isInteger(year) || year < 2000) {
      return sendError(res, 'Valid report_year is required', 422);
    }

    const exists = await query(
      `SELECT id
       FROM population_report
       WHERE report_year = $1`,
      [year]
    );

    if (exists.rowCount) {
      return sendError(res, 'Report year already exists', 409);
    }

    const result = await query(`
      INSERT INTO population_report
      (report_year, notes)
      VALUES ($1, $2)
      RETURNING *
    `, [year, notes]);

    const report = result.rows[0];

    await seedRows(
      'population_age',
      'age_group',
      AGE_GROUPS,
      report.id
    );

    await seedRows(
      'population_education',
      'education_level',
      EDUCATION_LEVELS,
      report.id
    );

    await seedRows(
      'population_religion',
      'religion',
      RELIGIONS,
      report.id
    );

    await seedRows(
      'building_report',
      'building_type',
      BUILDING_TYPES,
      report.id
    );

// CATAT AKTIVITAS ADMIN 2
await logActivity(
  req,
  'create',
  'population_report',
  report.id,
  {
    report_year: report.report_year,
    notes: report.notes
  }
);

    return sendOk(res, report, 201);
  })
);

// ============================================================
// UPDATE REPORT
// ADMIN 2
// ============================================================

router.put(
  '/:id',
  authRequired,
  admin2Only,
  asyncHandler(async (req, res) => {
    const {
      report_year,
      notes
    } = req.body || {};

    if (
      report_year !== undefined &&
      (!Number.isInteger(Number(report_year)) ||
       Number(report_year) < 2000)
    ) {
      return sendError(res, 'Invalid report_year', 422);
    }

    const result = await query(`
      UPDATE population_report
      SET
        report_year = COALESCE($1, report_year),
        notes = COALESCE($2, notes),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [
      report_year !== undefined
        ? Number(report_year)
        : null,
      notes ?? null,
      req.params.id
    ]);

    if (!result.rowCount) {
      return sendError(res, 'Population report not found', 404);
    }

    await logActivity(
  req,
  'update',
  'population_report',
  result.rows[0].id,
  {
    report_year: result.rows[0].report_year,
    notes: result.rows[0].notes
  }
);

    return sendOk(res, result.rows[0]);
  })
);

// ============================================================
// DELETE REPORT
// ADMIN 2
// ============================================================

router.delete(
  '/:id',
  authRequired,
  admin2Only,
  asyncHandler(async (req, res) => {

    console.log('DELETE POPULATION ID:', req.params.id);

    const result = await query(`
      DELETE FROM population_report
      WHERE id = $1
      RETURNING id, report_year
    `, [req.params.id]);

    console.log('DELETE RESULT:', result.rows);

    if (!result.rowCount) {
      return sendError(res, 'Population report not found', 404);
    }

    console.log('BEFORE LOG ACTIVITY');

    await logActivity(
      req,
      'delete',
      'population_report',
      result.rows[0].id,
      {
        report_year: result.rows[0].report_year
      }
    );

    console.log('AFTER LOG ACTIVITY');

    return sendOk(res, {
      id: result.rows[0].id,
      report_year: result.rows[0].report_year
    });
  })
);

// ============================================================
// UPDATE AGE
// ADMIN 2
// ============================================================

router.put(
  '/:reportId/age/:id',
  authRequired,
  admin2Only,
  asyncHandler(async (req, res) => {
    const total = Number(req.body?.total);

    if (!Number.isInteger(total) || total < 0) {
      return sendError(res, 'total must be a non-negative integer', 422);
    }

    const result = await query(`
      UPDATE population_age
      SET
        total = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
        AND report_id = $3
      RETURNING *
    `, [
      total,
      req.params.id,
      req.params.reportId
    ]);

    if (!result.rowCount) {
      return sendError(res, 'Age data not found', 404);
    }

    await logActivity(
  req,
  'update',
  'population_age',
  result.rows[0].id,
  {
    report_id: result.rows[0].report_id,
    age_group: result.rows[0].age_group,
    total: result.rows[0].total
  }
);

    return sendOk(res, result.rows[0]);
  })
);

// ============================================================
// UPDATE EDUCATION
// ADMIN 2
// ============================================================

router.put(
  '/:reportId/education/:id',
  authRequired,
  admin2Only,
  asyncHandler(async (req, res) => {
    const total = Number(req.body?.total);

    if (!Number.isInteger(total) || total < 0) {
      return sendError(res, 'total must be a non-negative integer', 422);
    }

    const result = await query(`
      UPDATE population_education
      SET
        total = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
        AND report_id = $3
      RETURNING *
    `, [
      total,
      req.params.id,
      req.params.reportId
    ]);

    if (!result.rowCount) {
      return sendError(res, 'Education data not found', 404);
    }
    
    await logActivity(
  req,
  'update',
  'population_education',
  result.rows[0].id,
  {
    report_id: result.rows[0].report_id,
    education_level: result.rows[0].education_level,
    total: result.rows[0].total
  }
);

    return sendOk(res, result.rows[0]);
  })
);

// ============================================================
// UPDATE RELIGION
// ADMIN 2
// ============================================================

router.put(
  '/:reportId/religion/:id',
  authRequired,
  admin2Only,
  asyncHandler(async (req, res) => {
    const total = Number(req.body?.total);

    if (!Number.isInteger(total) || total < 0) {
      return sendError(res, 'total must be a non-negative integer', 422);
    }

    const result = await query(`
      UPDATE population_religion
      SET
        total = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
        AND report_id = $3
      RETURNING *
    `, [
      total,
      req.params.id,
      req.params.reportId
    ]);

    if (!result.rowCount) {
      return sendError(res, 'Religion data not found', 404);
    }
    
    await logActivity(
  req,
  'update',
  'population_religion',
  result.rows[0].id,
  {
    report_id: result.rows[0].report_id,
    religion: result.rows[0].religion,
    total: result.rows[0].total
  }
);

    return sendOk(res, result.rows[0]);
  })
);

// ============================================================
// UPDATE BUILDING
// ADMIN 2
// ============================================================

router.put(
  '/:reportId/buildings/:id',
  authRequired,
  admin2Only,
  asyncHandler(async (req, res) => {
    const total = Number(req.body?.total);

    if (!Number.isInteger(total) || total < 0) {
      return sendError(res, 'total must be a non-negative integer', 422);
    }

    const result = await query(`
      UPDATE building_report
      SET
        total = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
        AND report_id = $3
      RETURNING *
    `, [
      total,
      req.params.id,
      req.params.reportId
    ]);

    if (!result.rowCount) {
      return sendError(res, 'Building data not found', 404);
    }
    
    await logActivity(
  req,
  'update',
  'building_report',
  result.rows[0].id,
  {
    report_id: result.rows[0].report_id,
    building_type: result.rows[0].building_type,
    total: result.rows[0].total
  }
);

    return sendOk(res, result.rows[0]);
  })
);

module.exports = router;