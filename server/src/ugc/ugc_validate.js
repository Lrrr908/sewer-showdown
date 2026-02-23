const crypto = require('crypto');
const pool = require('../db/pool');
const config = require('../config');
const { limiter } = require('../auth/ratelimit');

const { SEVERITY, err } = require('../../../js/shared/errors');
const { validateDimensions, validatePatternChars, computeMass } = require('../../../js/shared/pattern_core');

// Canonical base sprites: locked dimensions + precomputed base mass.
// baseMass should ideally be computed from canonical base pattern rows.
const BASE_SPRITES = {
  van:         { w: 32, h: 24, baseMass: 480 },
  turtle_leo:  { w: 18, h: 17, baseMass: 200 },
  turtle_raph: { w: 18, h: 17, baseMass: 200 },
  turtle_don:  { w: 18, h: 17, baseMass: 200 },
  turtle_mike: { w: 18, h: 17, baseMass: 200 },
};

function hashSubmission(baseSpriteKey, w, h, rows) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ baseSpriteKey, w, h, rows }))
    .digest('hex');
}

function makeSpriteRef(accountId, ugcId) {
  return `ugc:${accountId}:${ugcId}`;
}

function validateSubmission(baseSpriteKey, width, height, rows) {
  const errors = [];

  const base = BASE_SPRITES[baseSpriteKey];
  if (!base) {
    errors.push(err('UGC_UNKNOWN_BASE', SEVERITY.error, '/baseSpriteKey', 'unknown base sprite: ' + baseSpriteKey));
    return { ok: false, errors };
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    errors.push(err('UGC_ROWS_MISSING', SEVERITY.error, '/rows', 'rows must be a non-empty array'));
    return { ok: false, errors };
  }

  if (width !== base.w || height !== base.h) {
    errors.push(err('UGC_DIM_LOCKED', SEVERITY.error, '/width',
      `dimensions must be ${base.w}x${base.h}, got ${width}x${height}`));
    return { ok: false, errors };
  }

  if (width > config.UGC_MAX_WIDTH || height > config.UGC_MAX_HEIGHT) {
    errors.push(err('UGC_DIM_EXCEEDS_CAP', SEVERITY.error, '/width',
      `exceeds max ${config.UGC_MAX_WIDTH}x${config.UGC_MAX_HEIGHT}`));
    return { ok: false, errors };
  }

  const dimErrs = validateDimensions(rows, width, height, '');
  const charErrs = validatePatternChars(rows, '');
  errors.push(...dimErrs, ...charErrs);

  const mass = computeMass(rows);
  if (mass === 0) {
    errors.push(err('UGC_EMPTY', SEVERITY.error, '/rows', 'sprite must contain at least 1 non-transparent pixel'));
  }

  const massFloor = Math.floor(base.baseMass * config.UGC_MASS_TOLERANCE);
  if (mass < massFloor) {
    errors.push(err('UGC_MASS_TOO_LOW', SEVERITY.error, '/rows',
      `mass ${mass} < required ${massFloor} (${Math.round(config.UGC_MASS_TOLERANCE * 100)}% of base ${base.baseMass})`));
  }

  const blocking = errors.filter(e => e.severity === SEVERITY.error);
  if (blocking.length > 0) return { ok: false, errors: blocking };

  return { ok: true, errors: [], mass, baseMass: base.baseMass, w: width, h: height };
}

async function handleSubmission(accountId, msg) {
  const rl = limiter.consume('acct:ugc:' + accountId);
  if (!rl.ok) {
    return { ok: false, error: 'Rate limit exceeded', retryAfterMs: rl.retryAfterMs };
  }

  const { baseSpriteKey, width, height, rows } = msg;
  const validation = validateSubmission(baseSpriteKey, width, height, rows);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  const { mass, baseMass, w, h } = validation;
  const hash = hashSubmission(baseSpriteKey, w, h, rows);

  try {
    // Dedupe: same hash returns existing ugcId
    const existing = await pool.query(
      `SELECT ugc_id, account_id FROM ugc_sprites WHERE hash = $1`,
      [hash]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      return {
        ok: true,
        ugcId: row.ugc_id,
        spriteRef: makeSpriteRef(row.account_id, row.ugc_id),
        baseSpriteKey,
        deduped: true,
      };
    }

    const result = await pool.query(`
      INSERT INTO ugc_sprites (account_id, base_sprite_key, width, height, rows, mass, base_mass, hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING ugc_id
    `, [accountId, baseSpriteKey, w, h, JSON.stringify(rows), mass, baseMass, hash]);

    const ugcId = result.rows[0].ugc_id;
    return {
      ok: true,
      ugcId,
      spriteRef: makeSpriteRef(accountId, ugcId),
      baseSpriteKey,
      deduped: false,
    };
  } catch (e) {
    if (e.code === '23505') {
      const existing = await pool.query(`SELECT ugc_id, account_id FROM ugc_sprites WHERE hash = $1`, [hash]);
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        return {
          ok: true,
          ugcId: row.ugc_id,
          spriteRef: makeSpriteRef(row.account_id, row.ugc_id),
          baseSpriteKey,
          deduped: true,
        };
      }
    }
    console.error('[ugc] store error:', e.message);
    return { ok: false, error: 'Failed to store sprite' };
  }
}

module.exports = { validateSubmission, handleSubmission, BASE_SPRITES, makeSpriteRef };
