const { Router } = require('express');
const pool = require('../db/pool');

const router = Router();

router.get('/artists', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, display_name, ig_handle, sort_order
      FROM artists WHERE is_active = TRUE
      ORDER BY sort_order ASC, display_name ASC
    `);
    res.json({ items: rows });
  } catch (e) {
    console.error('[ig] artists error:', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/artist/:id/feed', async (req, res) => {
  try {
    const { rows: artistRows } = await pool.query(
      `SELECT id, display_name, ig_handle FROM artists WHERE id=$1 AND is_active=TRUE`,
      [req.params.id]
    );
    if (!artistRows.length) return res.status(404).json({ error: 'artist_not_found' });
    const artist = artistRows[0];

    const { rows } = await pool.query(`
      SELECT
        p.post_url          AS "postUrl",
        p.manual_thumb_url  AS "manualThumbUrl",
        c.author_name       AS "authorName",
        c.author_url        AS "authorUrl",
        c.title,
        c.thumbnail_url     AS "thumbnailUrl",
        c.cached_thumb_path AS "cachedThumbPath",
        c.fetched_at        AS "fetchedAt",
        c.status
      FROM ig_posts p
      LEFT JOIN ig_oembed_cache c ON c.post_url = p.post_url
      WHERE p.artist_id = $1 AND p.is_active = TRUE
      ORDER BY p.is_pinned DESC, p.sort_order ASC, p.id ASC
    `, [artist.id]);

    const items = rows.map(it => ({
      postUrl:    it.postUrl,
      authorName: it.authorName || artist.display_name,
      authorUrl:  it.authorUrl  || (artist.ig_handle
                    ? `https://www.instagram.com/${artist.ig_handle}/`
                    : null),
      title:      it.title      || null,
      imageUrl:   it.manualThumbUrl
                    || (it.cachedThumbPath ? `/ig-thumbs/${it.cachedThumbPath}` : null)
                    || it.thumbnailUrl
                    || null,
      openUrl:    it.postUrl,
      status:     it.manualThumbUrl ? 'manual' : (it.status || 'missing_cache'),
      fetchedAt:  it.fetchedAt || null,
    }));

    res.json({
      artistId:   artist.id,
      artistName: artist.display_name,
      updatedAt:  new Date().toISOString(),
      items,
    });
  } catch (e) {
    console.error('[ig] feed error:', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
