const { PROTOCOL_VERSION } = require('../protocol/version');
const config = require('../config');
const { isValidZoneId } = require('../zones/zone_id');

// --- Parse & validate C2S ---

function parseMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    if (!msg || typeof msg.t !== 'string') return null;
    return msg;
  } catch {
    return null;
  }
}

function validateHello(msg) {
  if (msg.t !== 'hello') return { ok: false, code: 'MESSAGE_INVALID' };
  if (msg.v !== PROTOCOL_VERSION) return { ok: false, code: 'VERSION_MISMATCH' };
  if (typeof msg.token !== 'string' || msg.token.length === 0) return { ok: false, code: 'AUTH_REQUIRED' };
  if (typeof msg.zone !== 'string' || !isValidZoneId(msg.zone)) return { ok: false, code: 'ZONE_INVALID' };
  return { ok: true };
}

const VALID_FACING = { n: 1, e: 1, s: 1, w: 1 };

function validateInput(msg) {
  return msg.t === 'input' &&
    Number.isInteger(msg.seq) &&
    msg.move != null &&
    Number.isInteger(msg.move.x) && msg.move.x >= -1 && msg.move.x <= 1 &&
    Number.isInteger(msg.move.y) && msg.move.y >= -1 && msg.move.y <= 1 &&
    (msg.facing == null || VALID_FACING[msg.facing] === 1);
}

function validateAction(msg) {
  return msg.t === 'action' &&
    Number.isInteger(msg.seq) &&
    typeof msg.action === 'string';
}

function validateUgcSubmit(msg) {
  return msg.t === 'ugc_submit' &&
    typeof msg.baseSpriteKey === 'string' &&
    typeof msg.width === 'number' &&
    typeof msg.height === 'number' &&
    Array.isArray(msg.rows);
}

// --- S2C message factories ---

function makeHelloOk(entityId, accountId, zoneId, resumeResult) {
  return JSON.stringify({
    t: 'hello_ok', v: PROTOCOL_VERSION,
    you: { entityId, accountId, zone: zoneId },
    resume: {
      applied: !!(resumeResult && resumeResult.resume),
      reason: (resumeResult && resumeResult.reason) || 'no_presence',
    },
    server: {
      tickHz: config.TICK_HZ,
      aoiCell: config.AOI_CELL_SIZE_TILES,
      resumeTtlSec: require('../zones/presence').RESUME_TTL_SECONDS,
    },
    dir: { ttlSec: 60 },
  });
}

function makeSnapshot(tick, zoneId, players, ackSeq, bounds, collision) {
  const obj = {
    t: 'snapshot', v: PROTOCOL_VERSION,
    zone: zoneId, tick,
    ack: { seq: ackSeq || 0 },
    players,
  };
  if (bounds) obj.bounds = bounds;
  if (collision) obj.collision = collision;
  return JSON.stringify(obj);
}

function makeDelta(tick, zoneId, upserts, removes, ackSeq) {
  return JSON.stringify({
    t: 'delta', v: PROTOCOL_VERSION,
    zone: zoneId, tick,
    ack: { seq: ackSeq || 0 },
    upserts, removes,
  });
}

// Compact position-only update: each entry is [id, px, py, facing].
function makePosUpdate(tick, zoneId, entries) {
  return JSON.stringify({
    t: 'pos_batch', v: PROTOCOL_VERSION,
    zone: zoneId, tick,
    p: entries,
  });
}

function makeEvent(tick, eventType, data) {
  return JSON.stringify({
    t: 'event', v: PROTOCOL_VERSION,
    tick, eventType, data,
  });
}

function makeUgcUpdate(zoneId, accountId, ugcId, baseSpriteKey, spriteRef) {
  return JSON.stringify({
    t: 'ugc_update', v: PROTOCOL_VERSION,
    zone: zoneId, accountId, ugcId, baseSpriteKey, spriteRef,
  });
}

function makeTransferBegin(fromZone, toZone, reason) {
  return JSON.stringify({
    t: 'transfer_begin', v: PROTOCOL_VERSION,
    from: fromZone, to: toZone, reason: reason || 'enter_region',
    fatal: false,
  });
}

function makeTransferCommit(zoneId, entityId, accountId) {
  return JSON.stringify({
    t: 'transfer_commit', v: PROTOCOL_VERSION,
    zone: zoneId,
    you: { entityId, accountId },
  });
}

function makeCollisionFull(zoneId, collision) {
  return JSON.stringify({
    t: 'event', v: PROTOCOL_VERSION,
    zone: zoneId,
    event: 'collision_full',
    collision,
  });
}

function makeError(code, msg, fatal) {
  return JSON.stringify({
    t: 'error', v: PROTOCOL_VERSION,
    code, msg, fatal: !!fatal,
  });
}

module.exports = {
  PROTOCOL_VERSION,
  parseMessage,
  validateHello, validateInput, validateAction, validateUgcSubmit,
  makeHelloOk, makeSnapshot, makeDelta, makePosUpdate, makeEvent,
  makeUgcUpdate, makeTransferBegin, makeTransferCommit,
  makeCollisionFull, makeError,
};
