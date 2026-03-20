const { Pool } = require('pg');
const config = require('../config');

const sslNeeded = config.DATABASE_URL && config.DATABASE_URL.includes('render.com');
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ...(sslNeeded ? { ssl: { rejectUnauthorized: false } } : {}),
});

pool.on('error', (err) => {
  console.error('[db] unexpected pool error:', err.message);
});

module.exports = pool;
