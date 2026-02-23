// Zone ID grammar: parse, validate, derive type.
// No normalization — wrong casing is invalid.

const WORLD_RE  = /^world:([a-z]{2,8})$/;
const REGION_RE = /^region:([a-z]{2,8}):([a-z0-9_]{1,32})$/;
const LEVEL_RE  = /^level:(level_[a-z0-9_]{1,64})$/;

function parseZoneId(zoneId) {
  if (typeof zoneId !== 'string') return null;
  let m;
  m = WORLD_RE.exec(zoneId);
  if (m) return { type: 'world', regionKey: m[1], zoneId };
  m = REGION_RE.exec(zoneId);
  if (m) return { type: 'region', regionKey: m[1], instanceId: m[2], zoneId };
  m = LEVEL_RE.exec(zoneId);
  if (m) return { type: 'level', levelId: m[1], zoneId };
  return null;
}

function isValidZoneId(zoneId) {
  return parseZoneId(zoneId) !== null;
}

module.exports = { parseZoneId, isValidZoneId, WORLD_RE, REGION_RE, LEVEL_RE };
