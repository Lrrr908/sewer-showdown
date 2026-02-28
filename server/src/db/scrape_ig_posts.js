#!/usr/bin/env node
// Fetches recent public posts from each artist's Instagram profile
// and inserts them with manual_thumb_url into the database.

require('dotenv').config();
const pool = require('./pool');

const IG_APP_ID = '936619743392459';
const DELAY_MS = 1500;
const MAX_POSTS_PER_ARTIST = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchProfile(handle) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-IG-App-ID': IG_APP_ID,
      'Accept': 'application/json',
    },
  });
  if (!resp.ok) return { ok: false, status: resp.status };
  const data = await resp.json();
  const user = data?.data?.user;
  if (!user) return { ok: false, error: 'no user' };

  const edges = user.edge_owner_to_timeline_media?.edges || [];
  const posts = edges.slice(0, MAX_POSTS_PER_ARTIST).map(e => {
    const n = e.node;
    return {
      shortcode: n.shortcode,
      postUrl: `https://www.instagram.com/p/${n.shortcode}/`,
      thumbUrl: n.thumbnail_src || n.display_url || null,
      caption: (n.edge_media_to_caption?.edges?.[0]?.node?.text || '').slice(0, 200),
    };
  });
  return { ok: true, posts };
}

async function run() {
  const { rows: artists } = await pool.query(
    `SELECT id, ig_handle FROM artists WHERE is_active = TRUE AND ig_handle IS NOT NULL ORDER BY sort_order, id`
  );
  console.log(`[scrape] ${artists.length} artists to process`);

  let total = 0, failed = 0;
  for (const a of artists) {
    process.stdout.write(`[scrape] ${a.id} (@${a.ig_handle})... `);
    try {
      const result = await fetchProfile(a.ig_handle);
      if (!result.ok) {
        console.log(`SKIP (${result.status || result.error})`);
        failed++;
        await sleep(DELAY_MS);
        continue;
      }
      if (result.posts.length === 0) {
        console.log('0 posts');
        await sleep(DELAY_MS);
        continue;
      }
      for (const p of result.posts) {
        await pool.query(`
          INSERT INTO ig_posts (artist_id, post_url, manual_thumb_url, created_at, updated_at)
          VALUES ($1, $2, $3, now(), now())
          ON CONFLICT (post_url) DO UPDATE SET
            manual_thumb_url = COALESCE(EXCLUDED.manual_thumb_url, ig_posts.manual_thumb_url),
            updated_at = now()
        `, [a.id, p.postUrl, p.thumbUrl]);
        total++;
      }
      console.log(`${result.posts.length} posts`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      failed++;
    }
    await sleep(DELAY_MS);
  }
  console.log(`[scrape] done: ${total} posts inserted/updated, ${failed} artists failed`);
}

run()
  .then(() => pool.end())
  .catch(err => { console.error('[scrape] fatal:', err); process.exit(1); });
