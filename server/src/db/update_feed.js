#!/usr/bin/env node
// Unified IG feed updater: scrape profiles, download images locally, export static JSON.
// Usage:
//   node server/src/db/update_feed.js                    # full update
//   node server/src/db/update_feed.js --artist whackonaut # single artist
//   node server/src/db/update_feed.js --clean --artist X  # wipe + re-scrape artist
//   node server/src/db/update_feed.js --export-only       # just re-export JSON from DB
//   node server/src/db/update_feed.js --skip-images       # scrape but don't download images

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pool = require('./pool');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const IG_APP_ID = '936619743392459';
const SCRAPE_DELAY_MS = 1500;
const IMAGE_DELAY_MS = 10000;
const MAX_POSTS_PER_ARTIST = 3;

const ROOT = path.resolve(__dirname, '../../../');
const THUMBS_DIR = path.join(ROOT, 'data/ig-thumbs');
const IG_JSON_DIR = path.join(ROOT, 'data/ig');

const args = process.argv.slice(2);
const FLAG_ARTIST = args.includes('--artist') ? args[args.indexOf('--artist') + 1] : null;
const FLAG_CLEAN = args.includes('--clean');
const FLAG_EXPORT_ONLY = args.includes('--export-only');
const FLAG_SKIP_IMAGES = args.includes('--skip-images');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function shortcodeFromUrl(postUrl) {
  const m = postUrl.match(/\/p\/([^/]+)/);
  return m ? m[1] : null;
}

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
    };
  });
  return { ok: true, posts };
}

function downloadImage(imageUrl, destPath) {
  return new Promise((resolve, reject) => {
    const mod = imageUrl.startsWith('https') ? https : http;
    const req = mod.get(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.instagram.com/',
      },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => resolve(true));
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Phase 1: Scrape IG profiles and upsert posts into DB ──

async function scrapeArtists(artists) {
  console.log(`\n[scrape] ${artists.length} artist(s) to scrape`);
  let total = 0, failed = 0;

  for (const a of artists) {
    process.stdout.write(`  ${a.id} (@${a.ig_handle})... `);

    if (FLAG_CLEAN) {
      await pool.query(`DELETE FROM ig_posts WHERE artist_id = $1`, [a.id]);
      process.stdout.write('(cleaned) ');
    }

    try {
      const result = await fetchProfile(a.ig_handle);
      if (!result.ok) {
        console.log(`SKIP (${result.status || result.error})`);
        failed++;
        await sleep(SCRAPE_DELAY_MS);
        continue;
      }
      if (result.posts.length === 0) {
        console.log('0 posts');
        await sleep(SCRAPE_DELAY_MS);
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
    await sleep(SCRAPE_DELAY_MS);
  }
  console.log(`[scrape] done: ${total} upserted, ${failed} failed`);
}

// ── Phase 2: Download images locally ──

async function downloadImages(artists) {
  fs.mkdirSync(THUMBS_DIR, { recursive: true });

  const artistFilter = artists.map(a => a.id);
  const { rows: posts } = await pool.query(`
    SELECT post_url, manual_thumb_url
    FROM ig_posts
    WHERE is_active = TRUE AND manual_thumb_url IS NOT NULL
      AND artist_id = ANY($1)
    ORDER BY artist_id, id
  `, [artistFilter]);

  let downloaded = 0, skipped = 0, failed = 0;
  console.log(`\n[download] ${posts.length} post(s) to check`);

  for (const p of posts) {
    const sc = shortcodeFromUrl(p.post_url);
    if (!sc) { skipped++; continue; }

    const dest = path.join(THUMBS_DIR, `${sc}.jpg`);
    if (fs.existsSync(dest)) {
      skipped++;
      continue;
    }

    process.stdout.write(`  ${sc}.jpg ... `);
    try {
      await downloadImage(p.manual_thumb_url, dest);
      downloaded++;
      console.log('OK');
    } catch (err) {
      console.log(`FAIL (${err.message})`);
      failed++;
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    }
    await sleep(IMAGE_DELAY_MS);
  }
  console.log(`[download] done: ${downloaded} new, ${skipped} existing, ${failed} failed`);
}

// ── Phase 3: Export static JSON files ──

async function exportFeeds(artists) {
  fs.mkdirSync(IG_JSON_DIR, { recursive: true });

  console.log(`\n[export] ${artists.length} artist(s)`);

  for (const a of artists) {
    const { rows } = await pool.query(`
      SELECT
        p.post_url,
        p.manual_thumb_url,
        p.is_pinned,
        p.sort_order
      FROM ig_posts p
      WHERE p.artist_id = $1 AND p.is_active = TRUE
      ORDER BY p.is_pinned DESC, p.sort_order ASC, p.id ASC
    `, [a.id]);

    const items = rows.map(r => {
      const sc = shortcodeFromUrl(r.post_url);
      const localThumb = sc && fs.existsSync(path.join(THUMBS_DIR, `${sc}.jpg`))
        ? `data/ig-thumbs/${sc}.jpg`
        : null;

      return {
        postUrl: r.post_url,
        authorName: a.display_name,
        authorUrl: a.ig_handle ? `https://www.instagram.com/${a.ig_handle}/` : null,
        title: null,
        imageUrl: localThumb || r.manual_thumb_url || null,
        openUrl: r.post_url,
        status: localThumb ? 'local' : 'cdn',
        fetchedAt: new Date().toISOString(),
      };
    });

    const feed = {
      artistId: a.id,
      artistName: a.display_name,
      updatedAt: new Date().toISOString(),
      items,
    };

    const dest = path.join(IG_JSON_DIR, `${a.id}.json`);
    fs.writeFileSync(dest, JSON.stringify(feed));
    process.stdout.write('.');
  }
  console.log(`\n[export] done: ${artists.length} JSON files written to data/ig/`);
}

// ── Main ──

async function run() {
  console.log('=== IG Feed Update ===');
  if (FLAG_ARTIST) console.log(`Artist filter: ${FLAG_ARTIST}`);
  if (FLAG_CLEAN) console.log('Mode: clean (delete existing posts first)');
  if (FLAG_EXPORT_ONLY) console.log('Mode: export-only (skip scraping + images)');
  if (FLAG_SKIP_IMAGES) console.log('Mode: skip-images');

  const whereClause = FLAG_ARTIST
    ? `AND id = '${FLAG_ARTIST.replace(/'/g, "''")}'`
    : '';
  const { rows: artists } = await pool.query(`
    SELECT id, display_name, ig_handle
    FROM artists
    WHERE is_active = TRUE AND ig_handle IS NOT NULL ${whereClause}
    ORDER BY sort_order, id
  `);

  if (artists.length === 0) {
    console.log('No matching artists found.');
    return;
  }

  if (!FLAG_EXPORT_ONLY) {
    await scrapeArtists(artists);
  }

  if (!FLAG_EXPORT_ONLY && !FLAG_SKIP_IMAGES) {
    await downloadImages(artists);
  }

  await exportFeeds(artists);

  console.log('\n=== All done! ===');
  console.log('Next: git add data/ig/ data/ig-thumbs/ && git commit -m "Update feeds" && git push');
}

run()
  .then(() => pool.end())
  .catch(err => { console.error('[update-feed] fatal:', err); process.exit(1); });
