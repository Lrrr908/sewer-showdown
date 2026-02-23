const { Router } = require('express');
const pool = require('../db/pool');
const ugcValidate = require('./ugc_validate');

const router = Router();

router.post('/submit', async (req, res) => {
  try {
    const { baseSpriteKey, width, height, rows } = req.body;
    if (!baseSpriteKey || typeof width !== 'number' || typeof height !== 'number' || !Array.isArray(rows)) {
      return res.status(400).json({ error: 'baseSpriteKey, width, height, and rows[] are required' });
    }

    const result = await ugcValidate.handleSubmission(req.user.id, { baseSpriteKey, width, height, rows });
    if (!result.ok) {
      return res.status(422).json(result);
    }
    res.json(result);
  } catch (e) {
    console.error('[ugc] submit error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/sprite/:ugcId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ugc_id, account_id, base_sprite_key, width, height, rows, mass, base_mass, hash, meta
       FROM ugc_sprites WHERE ugc_id = $1`,
      [req.params.ugcId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sprite not found' });
    }
    const s = result.rows[0];
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({
      ugcId: s.ugc_id,
      accountId: s.account_id,
      baseSpriteKey: s.base_sprite_key,
      spriteRef: ugcValidate.makeSpriteRef(s.account_id, s.ugc_id),
      w: s.width,
      h: s.height,
      rows: s.rows,
      mass: s.mass,
      baseMass: s.base_mass,
      hash: s.hash,
      meta: s.meta,
    });
  } catch (e) {
    console.error('[ugc] get sprite error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/sprites/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ugc_id, base_sprite_key, width, height, mass, hash, created_at
       FROM ugc_sprites WHERE account_id = $1 ORDER BY created_at DESC`,
      [req.params.userId]
    );
    res.json({
      sprites: result.rows.map(s => ({
        ugcId: s.ugc_id,
        baseSpriteKey: s.base_sprite_key,
        spriteRef: ugcValidate.makeSpriteRef(req.params.userId, s.ugc_id),
        w: s.width,
        h: s.height,
        mass: s.mass,
        hash: s.hash,
      })),
    });
  } catch (e) {
    console.error('[ugc] list sprites error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
