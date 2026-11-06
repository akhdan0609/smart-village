const { query } = require('../db');

const DEFAULT_TEMPLATES = {
  submitted:
    'Terima kasih telah menggunakan layanan persuratan online Website kami, pengajuan surat anda sudah masuk ke sistem kami',
  processing: 'Surat anda sedang diproses',
  completed:
    'Pengajuan surat anda telah selesai, silakan mengambil di kantor balai desa',
  rejected: 'Pengajuan surat anda ditolak, berikut rinciannya : {catatan}'
};

// Status 'approved' (Siap Diambil) dipetakan ke template 'completed' (Selesai)
function templateKeyForStatus(status) {
  return status === 'approved' ? 'completed' : status;
}

async function getWaSettings() {
  let gateway = {};
  let templates = { ...DEFAULT_TEMPLATES };

  try {
    const g = await query(`SELECT value FROM site_setting WHERE key = 'wa_gateway'`);
    if (g.rowCount && g.rows[0].value) gateway = g.rows[0].value;

    const t = await query(`SELECT value FROM site_setting WHERE key = 'wa_templates'`);
    if (t.rowCount && t.rows[0].value) {
      templates = { ...DEFAULT_TEMPLATES, ...t.rows[0].value };
    }
  } catch {
    // fallback ke default
  }

  return { gateway, templates };
}

function fillTemplate(text, vars) {
  return String(text || '').replace(/\{(\w+)\}/g, (match, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function normalizeTarget(whatsapp) {
  const digits = String(whatsapp || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('62')) return digits;
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  return `62${digits}`;
}

async function sendWhatsApp(to, message) {
  const { gateway } = await getWaSettings();
  if (!gateway || !gateway.token) return false;

  const target = normalizeTarget(to);
  if (!target) return false;

  try {
    const body = new URLSearchParams();
    body.append('target', target);
    body.append('message', message);

    const response = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: {
        Authorization: gateway.token,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });

    return response.ok;
  } catch {
    return false;
  }
}

// Kirim notifikasi berdasarkan status. Dipanggil secara fire-and-forget
// agar tidak memperlambat respons HTTP.
function notifyByStatus({ whatsapp, applicantName, status, officerNotes }) {
  return (async () => {
    try {
      if (!whatsapp) return;
      const { templates } = await getWaSettings();
      const key = templateKeyForStatus(status);
      const template = templates[key];
      if (!template) return;

      const message = fillTemplate(template, {
        nama: applicantName || '',
        catatan: officerNotes || '-'
      });

      await sendWhatsApp(whatsapp, message);
    } catch {
      // abaikan error notifikasi agar tidak menggagalkan proses utama
    }
  })();
}

module.exports = {
  DEFAULT_TEMPLATES,
  getWaSettings,
  fillTemplate,
  sendWhatsApp,
  notifyByStatus,
  templateKeyForStatus,
  normalizeTarget
};
