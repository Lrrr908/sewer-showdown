// Presence cache: in-memory resume state keyed by accountId.
// Used for reconnect-with-TTL. Not persisted in v1.

const RESUME_TTL_SECONDS = 30;

const cache = new Map();

function update(accountId, entity) {
  cache.set(accountId, {
    zoneId: entity.zoneId,
    x: entity.x,
    y: entity.y,
    facing: entity.facing,
    spriteRef: entity.spriteRef,
    lastSeenAtMs: Date.now(),
    disconnectedAtMs: null,
    resumeUntilMs: null,
  });
}

function markDisconnected(accountId) {
  const entry = cache.get(accountId);
  if (!entry) return;
  const now = Date.now();
  entry.disconnectedAtMs = now;
  entry.resumeUntilMs = now + RESUME_TTL_SECONDS * 1000;
}

// Returns resume data if within TTL, else null.
function getResume(accountId) {
  const entry = cache.get(accountId);
  if (!entry) return null;
  if (entry.disconnectedAtMs === null) return entry;
  if (Date.now() <= entry.resumeUntilMs) return entry;
  return null;
}

// Resolve what zone and position to use on reconnect.
// Returns { zoneId, resume, reason, [x, y, facing, spriteRef] }.
function resolveReconnect(accountId, clientZone, clientResume) {
  if (clientResume === false) {
    return { zoneId: clientZone, resume: false, reason: 'client_forced_fresh' };
  }

  const entry = cache.get(accountId);
  if (!entry) {
    return { zoneId: clientZone, resume: false, reason: 'no_presence' };
  }

  if (entry.disconnectedAtMs !== null && Date.now() > entry.resumeUntilMs) {
    return { zoneId: clientZone, resume: false, reason: 'ttl_expired' };
  }

  const actualZone = entry.zoneId;
  const reason = (actualZone !== clientZone) ? 'zone_mismatch_forced_transfer' : 'within_ttl';

  return {
    zoneId: actualZone,
    resume: true,
    reason,
    x: entry.x,
    y: entry.y,
    facing: entry.facing,
    spriteRef: entry.spriteRef,
  };
}

function remove(accountId) {
  cache.delete(accountId);
}

// Remove entries where TTL has expired and player is disconnected.
function cleanup() {
  const now = Date.now();
  for (const [accountId, entry] of cache) {
    if (entry.disconnectedAtMs !== null && now > entry.resumeUntilMs) {
      cache.delete(accountId);
    }
  }
}

function size() { return cache.size; }

function has(accountId) { return cache.has(accountId); }

module.exports = {
  RESUME_TTL_SECONDS,
  update, markDisconnected, getResume, resolveReconnect,
  remove, cleanup, size, has,
};
