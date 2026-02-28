const pool = require('../db/pool');
const { fetchInstagramOEmbed } = require('./oembed');
const { cacheThumbnail } = require('./thumb_cache');

const DELAY_MS    = Number(process.env.OEMBED_DELAY_MS    || 300);
const MAX_PER_RUN = Number(process.env.OEMBED_MAX_PER_RUN || 50);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function refreshOne(postUrl) {
  const res = await fetchInstagramOEmbed(postUrl);

  if (!res.ok) {
    await pool.query(`
      INSERT INTO ig_oembed_cache (post_url, fetched_at, expires_at, status, error)
      VALUES ($1, now(), now() + interval '6 hours', 'fail', $2)
      ON CONFLICT (post_url) DO UPDATE SET
        fetched_at = now(),
        expires_at = now() + interval '6 hours',
        status     = 'fail',
        error      = EXCLUDED.error
    `, [postUrl, res.error]);
    return { ok: false, postUrl, error: res.error };
  }

  const d = res.data;
  const cachedThumb = await cacheThumbnail(d.thumbnail_url);

  await pool.query(`
    INSERT INTO ig_oembed_cache
      (post_url, provider, author_name, author_url, title,
       thumbnail_url, thumbnail_width, thumbnail_height, html,
       cached_thumb_path, fetched_at, expires_at, status, error)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now() + interval '24 hours', 'ok', NULL)
    ON CONFLICT (post_url) DO UPDATE SET
      provider          = EXCLUDED.provider,
      author_name       = EXCLUDED.author_name,
      author_url        = EXCLUDED.author_url,
      title             = EXCLUDED.title,
      thumbnail_url     = EXCLUDED.thumbnail_url,
      thumbnail_width   = EXCLUDED.thumbnail_width,
      thumbnail_height  = EXCLUDED.thumbnail_height,
      html              = EXCLUDED.html,
      cached_thumb_path = EXCLUDED.cached_thumb_path,
      fetched_at        = now(),
      expires_at        = now() + interval '24 hours',
      status            = 'ok',
      error             = NULL
  `, [
    postUrl, d.provider, d.author_name, d.author_url, d.title,
    d.thumbnail_url, d.thumbnail_width, d.thumbnail_height, d.html,
    cachedThumb
  ]);

  return { ok: true, postUrl, cachedThumb };
}

function summarize(results) {
  return {
    refreshed: results.length,
    ok:   results.filter(r => r.ok).length,
    fail: results.filter(r => !r.ok).length,
    results,
  };
}

async function getStaleUrls(artistId) {
  const base = `
    SELECT p.post_url AS "postUrl"
    FROM ig_posts p
    LEFT JOIN ig_oembed_cache c ON c.post_url = p.post_url
    WHERE p.is_active = TRUE
      AND (c.post_url IS NULL OR c.expires_at <= now() OR c.status != 'ok')
    ORDER BY
      CASE WHEN c.post_url IS NULL THEN 0 ELSE 1 END,
      c.fetched_at ASC NULLS FIRST
    LIMIT $1
  `;
  const withArtist = `
    SELECT p.post_url AS "postUrl"
    FROM ig_posts p
    LEFT JOIN ig_oembed_cache c ON c.post_url = p.post_url
    WHERE p.is_active = TRUE AND p.artist_id = $2
      AND (c.post_url IS NULL OR c.expires_at <= now() OR c.status != 'ok')
    ORDER BY
      CASE WHEN c.post_url IS NULL THEN 0 ELSE 1 END,
      c.fetched_at ASC NULLS FIRST
    LIMIT $1
  `;
  const { rows } = artistId
    ? await pool.query(withArtist, [MAX_PER_RUN, artistId])
    : await pool.query(base, [MAX_PER_RUN]);
  return rows;
}

let _running = false;

async function refreshOEmbedAll() {
  if (_running) return { refreshed: 0, ok: 0, fail: 0, results: [], skipped: 'already_running' };
  _running = true;
  try {
    const urls = await getStaleUrls();
    const results = [];
    for (const u of urls) {
      results.push(await refreshOne(u.postUrl));
      await sleep(DELAY_MS);
    }
    return summarize(results);
  } finally {
    _running = false;
  }
}

async function refreshOEmbedForArtist(artistId) {
  if (_running) return { artistId, refreshed: 0, ok: 0, fail: 0, results: [], skipped: 'already_running' };
  _running = true;
  try {
    const urls = await getStaleUrls(artistId);
    const results = [];
    for (const u of urls) {
      results.push(await refreshOne(u.postUrl));
      await sleep(DELAY_MS);
    }
    return { artistId, ...summarize(results) };
  } finally {
    _running = false;
  }
}

module.exports = { refreshOEmbedAll, refreshOEmbedForArtist, refreshOne };
