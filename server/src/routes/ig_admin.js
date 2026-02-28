const { Router } = require('express');
const pool = require('../db/pool');
const { refreshOEmbedAll, refreshOEmbedForArtist, refreshOne } = require('../ig/refresh_job');
const config = require('../config');

const router = Router();

router.use((req, res, next) => {
  const key = req.header('x-admin-key');
  if (!key || key !== config.IG_ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
});

router.get('/list', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.id, p.artist_id AS "artistId",
        a.display_name AS "artistName",
        p.post_url AS "postUrl",
        p.is_active, p.is_pinned, p.sort_order,
        c.status AS cache_status,
        c.cached_thumb_path,
        c.thumbnail_url,
        c.fetched_at,
        c.expires_at,
        c.error
      FROM ig_posts p
      JOIN artists a ON a.id = p.artist_id
      LEFT JOIN ig_oembed_cache c ON c.post_url = p.post_url
      ORDER BY a.sort_order ASC, a.display_name ASC,
               p.is_pinned DESC, p.sort_order ASC, p.id ASC
    `);
    res.json({ items: rows });
  } catch (e) {
    console.error('[ig-admin] list error:', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/artist', async (req, res) => {
  try {
    const { id, display_name, ig_handle, sort_order } = req.body;
    if (!id || !display_name) return res.status(400).json({ error: 'id and display_name required' });
    await pool.query(`
      INSERT INTO artists (id, display_name, ig_handle, is_active, sort_order, created_at, updated_at)
      VALUES ($1, $2, $3, TRUE, $4, now(), now())
      ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        ig_handle    = EXCLUDED.ig_handle,
        sort_order   = EXCLUDED.sort_order,
        is_active    = TRUE,
        updated_at   = now()
    `, [id.trim(), display_name.trim(), ig_handle?.trim() || null,
       Number.isFinite(sort_order) ? sort_order : 0]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[ig-admin] upsert artist error:', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

function normalizeIgUrl(raw) {
  let parsed;
  try { parsed = new URL(raw.trim()); } catch { return null; }
  if (parsed.hostname !== 'www.instagram.com' && parsed.hostname !== 'instagram.com') return null;
  const pathOk = /^\/(p|reel|tv)\/[^/]+\/?$/.test(parsed.pathname);
  if (!pathOk) return null;
  return `https://www.instagram.com${parsed.pathname.replace(/\/?$/, '/')}`;
}

router.post('/artist/:id/post', async (req, res) => {
  try {
    const { postUrl, manualThumbUrl } = req.body;
    if (!postUrl) return res.status(400).json({ error: 'postUrl required' });
    const normalized = normalizeIgUrl(postUrl);
    if (!normalized) return res.status(400).json({
      error: 'invalid_url',
      detail: 'Must be https://www.instagram.com/p/CODE/, /reel/CODE/, or /tv/CODE/'
    });
    await pool.query(`
      INSERT INTO ig_posts (artist_id, post_url, manual_thumb_url, created_at, updated_at)
      VALUES ($1, $2, $3, now(), now())
      ON CONFLICT (post_url) DO UPDATE SET
        manual_thumb_url = COALESCE(EXCLUDED.manual_thumb_url, ig_posts.manual_thumb_url),
        updated_at = now()
    `, [req.params.id, normalized, manualThumbUrl || null]);
    res.json({ ok: true, normalized });
  } catch (e) {
    console.error('[ig-admin] add post error:', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/post/set-thumb', async (req, res) => {
  try {
    const { id, manualThumbUrl } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    await pool.query(
      `UPDATE ig_posts SET manual_thumb_url = $1, updated_at = now() WHERE id = $2`,
      [manualThumbUrl || null, id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'internal' }); }
});

router.post('/post/toggle', async (req, res) => {
  try {
    await pool.query(
      `UPDATE ig_posts SET is_active = NOT is_active, updated_at = now() WHERE id = $1`,
      [req.body.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'internal' }); }
});

router.post('/post/pin', async (req, res) => {
  try {
    await pool.query(
      `UPDATE ig_posts SET is_pinned = NOT is_pinned, updated_at = now() WHERE id = $1`,
      [req.body.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'internal' }); }
});

router.post('/refresh-oembed', async (req, res) => {
  try {
    const { artistId } = req.body || {};
    const result = artistId
      ? await refreshOEmbedForArtist(artistId)
      : await refreshOEmbedAll();
    res.json(result);
  } catch (e) {
    console.error('[ig-admin] refresh error:', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/refresh-one', async (req, res) => {
  try {
    const { postUrl } = req.body;
    if (!postUrl) return res.status(400).json({ error: 'postUrl required' });
    const normalized = normalizeIgUrl(postUrl);
    if (!normalized) return res.status(400).json({
      error: 'invalid_url',
      detail: 'Must be https://www.instagram.com/p/CODE/, /reel/CODE/, or /tv/CODE/'
    });
    const result = await refreshOne(normalized);
    res.json({ normalized, ...result });
  } catch (e) { res.status(500).json({ error: 'internal' }); }
});

module.exports = router;
