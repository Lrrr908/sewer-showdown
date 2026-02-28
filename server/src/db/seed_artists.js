const fs = require('fs');
const path = require('path');
const pool = require('./pool');

function extractHandle(igUrl) {
  if (!igUrl) return null;
  try {
    const u = new URL(igUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[0] || null;
  } catch { return null; }
}

async function seed() {
  const raw = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'data', 'artists.json'), 'utf8'
  ));
  const artists = raw.artists || [];
  console.log(`[seed] found ${artists.length} artists in artists.json`);

  let inserted = 0, updated = 0;
  for (let i = 0; i < artists.length; i++) {
    const a = artists[i];
    const handle = extractHandle(a.instagram);
    const res = await pool.query(`
      INSERT INTO artists (id, display_name, ig_handle, is_active, sort_order, created_at, updated_at)
      VALUES ($1, $2, $3, TRUE, $4, now(), now())
      ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        ig_handle    = COALESCE(EXCLUDED.ig_handle, artists.ig_handle),
        updated_at   = now()
      RETURNING (xmax = 0) AS is_insert
    `, [a.id, a.name, handle, i]);
    if (res.rows[0].is_insert) inserted++; else updated++;
  }
  console.log(`[seed] done: ${inserted} inserted, ${updated} updated`);
}

if (require.main === module) {
  require('dotenv').config();
  seed()
    .then(() => pool.end())
    .catch(err => { console.error('[seed] failed:', err); process.exit(1); });
}

module.exports = seed;
