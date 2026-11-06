require('dotenv').config();

const bcrypt = require('bcryptjs');
const { query, pool } = require('../db');

(async () => {
  try {
    const username = process.argv[2];
    const password = process.argv[3];
    const name = process.argv[4] || 'Administrator';
    const role = process.argv[5] || 'admin_1';

    const allowedRoles = [
      'admin_1',
      'admin_2'
    ];

    if (!username || !password) {
      throw new Error(
        'Usage: node src/utils/createAdmin.js <username> <password> [name] [role]'
      );
    }

    if (!allowedRoles.includes(role)) {
      throw new Error(
        `Invalid role. Use: ${allowedRoles.join(', ')}`
      );
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await query(`
      INSERT INTO admin_user
      (
        username,
        password_hash,
        name,
        role
      )
      VALUES
      ($1, $2, $3, $4)
      RETURNING
        id,
        username,
        name,
        role
    `, [
      username,
      hash,
      name,
      role
    ]);

    console.log(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();