require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { query } = require('./db');
const { notFound, errorHandler } = require('./middleware/error');

const authRoutes = require('./routes/auth');
const contentRoutes = require('./routes/content');
const specialRoutes = require('./routes/special');
const populationRoutes = require('./routes/population');
const siteSettingRoutes = require('./routes/site-setting');
const emergencyRoutes = require('./routes/emergency');
const adminUserRoutes = require('./routes/admin-users');
const citizenComplaintRoutes = require('./routes/citizen-complaint');
const kknRoutes = require('./routes/kkn');
const backupRoutes = require('./routes/backup');


const createCrudRouter = require('./routes/generic');
const { authRequired } = require('./middleware/auth');
const { uploadGeneric, uploadDocument } = require('./middleware/upload');
const { sendOk, sendError } = require('./utils/http');
const asyncHandler = require('./utils/asyncHandler');

const app = express();
const port = Number(process.env.PORT || 4000);
const path = require('path');

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((v) => v.trim()) : true,
  credentials: true
}));
app.use(express.json({ limit: '32mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'))
);
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ success: true, data: { status: 'ok', database: 'connected', timestamp: new Date().toISOString() } });
  } catch (error) {
    res.status(503).json({ success: false, error: 'Database unavailable' });
  }
});

// Generic image upload (cover berita/galeri, foto potensi, dll.)
app.post(
  '/api/uploads',
  authRequired,
  uploadGeneric.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return sendError(res, 'file is required', 422);
    }
    return sendOk(res, {
      url: `/uploads/general/${req.file.filename}`,
      filename: req.file.filename
    });
  })
);

// Dokumen upload (PDF untuk kelengkapan, mis. dokumen anggaran desa)
app.post(
  '/api/uploads/document',
  authRequired,
  uploadDocument.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return sendError(res, 'file is required', 422);
    }
    return sendOk(res, {
      url: `/uploads/general/${req.file.filename}`,
      filename: req.file.filename
    });
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/site-settings', siteSettingRoutes);
app.use('/api/emergency-contacts', emergencyRoutes);
app.use('/api/admin/users', adminUserRoutes);
app.use('/api', specialRoutes);
app.use('/api/admin/population', populationRoutes);
app.use('/api/citizen-complaints', citizenComplaintRoutes);
app.use('/api/kkn', kknRoutes);
app.use('/api/admin/backup', backupRoutes);

// Public/admin CRUD modules.
app.use('/api/accommodations', createCrudRouter({
  table: 'accommodation',
  orderBy: 'name',
  writableFields: ['name','category','location','opening_hours','price_info','description','facilities','photo_url','photo_url_2','photo_url_3','contact','latitude','longitude','maps_url','is_active']
}));

app.use('/api/umkm', createCrudRouter({
  table: 'umkm',
  orderBy: 'name',
  writableFields: ['name','category','owner_name','address','opening_hours','price_info','description','whatsapp','photo_url','photo_url_2','photo_url_3','rating','is_featured','maps_url','is_active']
}));

app.use('/api/cultures', createCrudRouter({
  table: 'culture',
  orderBy: 'name',
  writableFields: ['name','description','full_detail','photo_url','photo_url_2','photo_url_3','implementation_time','participants','contact','is_active']
}));

app.use('/api/cultivations', createCrudRouter({
  table: 'cultivation',
  orderBy: 'name',
  writableFields: ['name','description','full_detail','photo_url','photo_url_2','photo_url_3','commodity','capacity','group_name','contact','location','jenis_kolam','is_active']
}));

app.use('/api/officials', createCrudRouter({
  table: 'village_official',
  orderBy: 'sort_order, name',
  writableFields: ['name','position','photo_url','description','period_start','period_end','sort_order','is_active']
}));

app.use('/api/village-chiefs', createCrudRouter({
  table: 'village_chief',
  orderBy: 'sort_order, id',
  writableFields: ['name','period_start','period_end','photo_url','description','sort_order','is_active']
}));

app.use('/api/budgets', createCrudRouter({
  table: 'village_budget',
  orderBy: 'year DESC, category, item_name',
  writableFields: ['year','category','item_name','description','amount','funding_source','document_url']
}));

app.use('/api/certificate-types', createCrudRouter({
  table: 'certificate_type',
  orderBy: 'name',
  writableFields: ['code','name','description','requirements','is_active']
}));

app.use('/api/press-releases', createCrudRouter({
  table: 'press_release',
  orderBy: 'COALESCE(published_at, created_at) DESC, id DESC',
  writableFields: ['title','slug','category','summary','content','cover_image_url','letter_number','valid_until','author','status','published_at','view_count']
}));

// PUBLIC - increment view count for a press release
app.post('/api/press-releases/:id/view', asyncHandler(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return sendError(res, 'Data not found', 404);
  await query(
    `UPDATE press_release SET view_count = COALESCE(view_count, 0) + 1 WHERE id = $1`,
    [req.params.id]
  );
  return sendOk(res, { ok: true });
}));

app.use('/api/galleries', createCrudRouter({
  table: 'gallery',
  orderBy: 'sort_order, created_at DESC',
  writableFields: ['title','description','image_url','kategori','sort_order']
}));

app.use('/api/village-profile', createCrudRouter({
  table: 'village_profile',
  orderBy: 'id',
  writableFields: ['nama_desa','ringkasan','sambutan_judul','sambutan_teks','sambutan_photo_url','jumlah_penduduk','luas_wilayah','ketinggian','jumlah_rw','jumlah_rt','latitude','longitude','map_embed_url']
}));

app.use('/api/lembaga-desa', createCrudRouter({
  table: 'lembaga_desa',
  orderBy: 'sort_order, name',
  writableFields: ['name','category','leader_name','address','description','contact','photo_url','sort_order','is_active']
}));

app.use('/api/produk-lokal', createCrudRouter({
  table: 'produk_lokal',
  orderBy: 'name',
  writableFields: ['name','category','owner_name','price_info','description','whatsapp','photo_url','is_active']
}));

app.use('/api/potensi-situs', createCrudRouter({
  table: 'potensi_situs',
  orderBy: 'sort_order, name',
  writableFields: ['name','category','location','summary','description','historical_period','photo_url','sort_order','is_active']
}));

app.use('/api/program-desa', createCrudRouter({
  table: 'program_desa',
  orderBy: 'sort_order, created_at DESC',
  writableFields: ['title','category','summary','description','cover_image_url','period','status','sort_order']
}));

app.use('/api/video-profile', createCrudRouter({
  table: 'video_profil',
  orderBy: 'sort_order, id',
  writableFields: ['title','youtube_id','description','cover_image_url','sort_order','is_active']
}));

app.use('/api/download-dokumen', createCrudRouter({
  table: 'download_dokumen',
  orderBy: 'sort_order, title',
  writableFields: ['title','category','description','file_url','sort_order','is_active']
}));

app.use('/api/layanan-desa', createCrudRouter({
  table: 'layanan_desa',
  orderBy: 'sort_order, title',
  writableFields: ['title','description','icon_name','route_key','cover_image_url','sort_order','is_active']
}));

// Activity Log
// Admin 1 -> melihat semua aktivitas
// Admin 2 -> hanya melihat aktivitas miliknya sendiri
app.get('/api/admin/activity-log', authRequired, async (req, res, next) => {
  try {
    let result;

    if (req.user.role === 'admin_1') {
      result = await query(`
        SELECT
          al.*,
          au.username,
          au.name,
          au.role
        FROM activity_log al
        LEFT JOIN admin_user au
          ON au.id = al.admin_user_id
        ORDER BY al.created_at DESC
        LIMIT 200
      `);
    } else if (req.user.role === 'admin_2') {
      result = await query(`
        SELECT
          al.*,
          au.username,
          au.name,
          au.role
        FROM activity_log al
        LEFT JOIN admin_user au
          ON au.id = al.admin_user_id
        WHERE al.admin_user_id = $1
        ORDER BY al.created_at DESC
        LIMIT 200
      `, [req.user.sub]);
    } else {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to access activity logs'
      });
    }

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    next(error);
  }
});

app.use(notFound);
app.use(errorHandler);

app.listen(port, () => {
  console.log(`Smart Village API running on http://localhost:${port}`);
});

