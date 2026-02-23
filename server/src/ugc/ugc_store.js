const pool = require('../db/pool');

async function getSprite(ugcId) {
  const result = await pool.query(
    `SELECT * FROM ugc_sprites WHERE ugc_id = $1`, [ugcId]
  );
  return result.rows[0] || null;
}

async function listByBase(baseSpriteKey) {
  const result = await pool.query(
    `SELECT account_id, ugc_id, hash, created_at FROM ugc_sprites WHERE base_sprite_key = $1 ORDER BY created_at DESC`,
    [baseSpriteKey]
  );
  return result.rows;
}

async function listByAccount(accountId) {
  const result = await pool.query(
    `SELECT ugc_id, base_sprite_key, width, height, mass, hash, created_at
     FROM ugc_sprites WHERE account_id = $1 ORDER BY created_at DESC`,
    [accountId]
  );
  return result.rows;
}

module.exports = { getSprite, listByBase, listByAccount };
