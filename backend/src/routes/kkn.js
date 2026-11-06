const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const { authRequired, requireRole } = require('../middleware/auth');
const {
  uploadKknSilabus,
  KKN_SILABUS_DIR,
  KKN_SILABUS_FILENAME,
  KKN_SILABUS_MAX_FILES
} = require('../middleware/upload');
const { sendOk, sendError } = require('../utils/http');

const router = express.Router();

const LEGACY_SILABUS_PATH = path.join(KKN_SILABUS_DIR, KKN_SILABUS_FILENAME);

// Metadata disimpan sebagai dotfile di folder induk sehingga tidak ikut dilayani
// oleh express.static sebagai file publik.
const META_PATH = path.join(path.dirname(KKN_SILABUS_DIR), '.kkn-silabus.json');

const PDF_HEADER = Buffer.from('%PDF-');
const PDF_MIN_SIZE = 100;
const PDF_TAIL_WINDOW = 4096;
const MAX_NAME_LENGTH = 120;

// Nama file asli dari browser dibersihkan agar aman dipakai sebagai nama file
// di server, lalu dipaksa ber ekstensi .pdf.
function sanitizeName(originalName) {
  const base = path
    .basename(String(originalName || ''))
    .replace(/[\\/]+/g, '-')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');

  const stem = path.extname(base) ? base.slice(0, base.length - path.extname(base).length) : base;
  const safeStem = (stem || 'silabus').slice(0, MAX_NAME_LENGTH).trim() || 'silabus';

  return `${safeStem}.pdf`;
}

// Hindari menimpa file lama ketika dua file asli punya nama yang sama.
function uniqueStoredName(baseName, taken) {
  const ext = path.extname(baseName) || '.pdf';
  const stem = baseName.slice(0, baseName.length - ext.length);
  const takenSet = new Set(taken);

  let candidate = baseName;
  let counter = 2;

  while (fs.existsSync(path.join(KKN_SILABUS_DIR, candidate)) || takenSet.has(candidate)) {
    candidate = `${stem} (${counter})${ext}`;
    counter += 1;
  }

  return candidate;
}

function writeMeta(entries) {
  fs.writeFileSync(META_PATH, JSON.stringify(entries, null, 2), 'utf8');
}

function readMeta() {
  let entries = [];

  try {
    if (fs.existsSync(META_PATH)) {
      const raw = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
      if (Array.isArray(raw)) entries = raw;
    }
  } catch {
    entries = [];
  }

  // Migrasi file tunggal lama agar tidak hilang saat fitur multi-file aktif.
  if (entries.length === 0 && fs.existsSync(LEGACY_SILABUS_PATH)) {
    const stat = fs.statSync(LEGACY_SILABUS_PATH);
    entries = [
      {
        id: `legacy-${Date.now()}`,
        filename: KKN_SILABUS_FILENAME,
        storedName: KKN_SILABUS_FILENAME,
        size: stat.size,
        uploadedAt: stat.mtime.toISOString()
      }
    ];
    writeMeta(entries);
  }

  // Buang entri yang file fisiknya sudah tidak ada.
  const alive = entries.filter(
    (entry) => entry && entry.storedName && fs.existsSync(path.join(KKN_SILABUS_DIR, entry.storedName))
  );

  if (alive.length !== entries.length) {
    writeMeta(alive);
  }

  return alive.map((entry) => ({
    id: String(entry.id),
    filename: entry.filename || entry.storedName,
    storedName: entry.storedName,
    size: typeof entry.size === 'number' ? entry.size : null,
    uploadedAt: entry.uploadedAt || null
  }));
}

function silabusInfo() {
  const files = readMeta().map((entry) => ({
    id: entry.id,
    filename: entry.filename,
    url: `/uploads/kkn/${encodeURIComponent(entry.storedName)}`,
    size: entry.size,
    uploadedAt: entry.uploadedAt
  }));

  return {
    available: files.length > 0,
    count: files.length,
    files
  };
}

function isValidPdf(filePath) {
  let stat = null;
  let handle = null;

  try {
    stat = fs.statSync(filePath);

    if (!stat.isFile() || stat.size < PDF_MIN_SIZE) {
      return false;
    }

    handle = fs.openSync(filePath, 'r');

    const header = Buffer.alloc(PDF_HEADER.length);
    fs.readSync(handle, header, 0, header.length, 0);

    if (!header.equals(PDF_HEADER)) {
      return false;
    }

    const tailLength = Math.min(PDF_TAIL_WINDOW, stat.size);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(handle, tail, 0, tailLength, stat.size - tailLength);

    return tail.includes(Buffer.from('%%EOF'));
  } catch {
    return false;
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        // ignore
      }
    }
  }
}

function receiveSilabus(req, res, next) {
  uploadKknSilabus.any()(req, res, (err) => {
    if (!err) {
      return next();
    }

    if (err.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 'Ukuran file maksimal 15 MB per file', 422);
    }

    if (err.code === 'LIMIT_FILE_COUNT') {
      return sendError(res, `Maksimal ${KKN_SILABUS_MAX_FILES} file sekaligus`, 422);
    }

    return sendError(res, err.message || 'Upload gagal', 422);
  });
}

router.get(
  '/silabus',
  asyncHandler(async (req, res) => sendOk(res, silabusInfo()))
);

router.post(
  '/silabus',
  authRequired,
  requireRole('admin_1', 'admin_2'),
  receiveSilabus,
  asyncHandler(async (req, res) => {
    const uploaded = Array.isArray(req.files) ? req.files : [];

    if (uploaded.length === 0) {
      return sendError(res, 'file is required', 422);
    }

    const entries = readMeta();
    const taken = entries.map((entry) => entry.storedName);
    const rejected = [];
    let accepted = 0;

    for (const item of uploaded) {
      const tempPath = item.path;

      if (!isValidPdf(tempPath)) {
        fs.unlink(tempPath, () => {});
        rejected.push(item.originalname);
        continue;
      }

      const baseName = sanitizeName(item.originalname);
      const storedName = uniqueStoredName(baseName, taken);
      const targetPath = path.join(KKN_SILABUS_DIR, storedName);

      try {
        fs.renameSync(tempPath, targetPath);
      } catch (error) {
        fs.unlink(tempPath, () => {});
        rejected.push(item.originalname);
        continue;
      }

      taken.push(storedName);
      accepted += 1;

      let size = null;
      try {
        size = fs.statSync(targetPath).size;
      } catch {
        size = null;
      }

      entries.push({
        id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `silabus-${Date.now()}`,
        filename: baseName,
        storedName,
        size,
        uploadedAt: new Date().toISOString()
      });
    }

    if (accepted === 0) {
      return sendError(res, 'File bukan PDF yang valid', 422);
    }

    writeMeta(entries);

    const info = silabusInfo();

    if (rejected.length > 0) {
      return sendOk(res, { ...info, rejected }, 201);
    }

    return sendOk(res, info, 201);
  })
);

router.delete(
  '/silabus/:id',
  authRequired,
  requireRole('admin_1', 'admin_2'),
  asyncHandler(async (req, res) => {
    const entries = readMeta();
    const target = entries.find((entry) => entry.id === String(req.params.id));

    if (!target) {
      return sendError(res, 'File tidak ditemukan', 404);
    }

    fs.unlink(path.join(KKN_SILABUS_DIR, target.storedName), () => {});

    writeMeta(entries.filter((entry) => entry.id !== target.id));

    return sendOk(res, silabusInfo());
  })
);

module.exports = router;
