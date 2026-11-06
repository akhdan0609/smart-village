const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('[postgres pool]', err);
});

async function query(text, params = []) {
  const started = Date.now();
  const result = await pool.query(text, params);
  const elapsed = Date.now() - started;
  if (elapsed > 1000) console.warn(`[slow query] ${elapsed}ms`);
  return result;
}

module.exports = { pool, query };
