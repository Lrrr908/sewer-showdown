// Zone Directory: authoritative registry of which zones exist and are joinable.
// Scans data/regions/ and data/levels/ on boot and every DIR_REFRESH_SEC.
// Transfer validation checks target against this directory.

const fs = require('fs');
const path = require('path');
const { parseZoneId } = require('./zone_id');
const { buildCollisionDescriptor } = require('./collision_grid');
const config = require('../config');

const DATA_DIR    = path.join(__dirname, '..', '..', '..', 'data');
const REGIONS_DIR = path.join(DATA_DIR, 'regions');
const LEVELS_DIR  = path.join(DATA_DIR, 'levels');

const DIR_REFRESH_SEC = 60;
const TOWN_KEY_RE = /^[a-z0-9_]+$/;
const ENTRANCE_ID_RE = /^[a-z0-9_]+$/;
const VALID_FACING = { n: 1, e: 1, s: 1, w: 1 };

let _snapshot = null;
let _stale = false;
let _timer = null;

const _warnedTowns     = new Set();
const _warnedLevels    = new Set();
const _warnedEntrances = new Set();

// ---------------------------------------------------------------------------
// Build directory snapshot by scanning data files
// ---------------------------------------------------------------------------

function buildSnapshot() {
  const world  = [];
  const region = [];
  const level  = [];
  const zoneSet = new Set();

  // Cache region data for entrance processing after levels are known.
  const regionDataCache = new Map();

  // ── Pass 1: Scan region files ──
  let regionFiles = [];
  try {
    regionFiles = fs.readdirSync(REGIONS_DIR).filter(f => f.endsWith('.json'));
  } catch { /* no regions dir */ }

  for (const file of regionFiles) {
    const regionKey = file.replace('.json', '');
    const filePath = path.join(REGIONS_DIR, file);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { continue; }

    const bounds = extractRectBounds(data.terrainGrid);
    if (!bounds) continue;

    regionDataCache.set(regionKey, { data, bounds });

    const worldId = 'world:' + regionKey;
    const coll = buildCollisionDescriptor(worldId, bounds.w, bounds.h);
    world.push({
      id: worldId,
      bounds: { w: bounds.w, h: bounds.h },
      collision: { ver: coll.descriptor.ver, hash: coll.descriptor.hash },
    });
    zoneSet.add(worldId);

    if (Array.isArray(data.towns)) {
      for (const town of data.towns) {
        const warnKey = regionKey + ':' + (town.id || '?');
        if (!town.id || typeof town.id !== 'string' || !TOWN_KEY_RE.test(town.id)) {
          warnTown(warnKey, 'bad townKey format');
          continue;
        }
        if (!Number.isInteger(town.x) || !Number.isInteger(town.y)) {
          warnTown(warnKey, 'non-integer coords');
          continue;
        }
        if (town.x < 0 || town.x >= bounds.w || town.y < 0 || town.y >= bounds.h) {
          warnTown(warnKey, 'out of bounds');
          continue;
        }
        const regionId = `region:${regionKey}:${town.id}`;
        region.push({
          id: regionId,
          world: worldId,
          townKey: town.id,
          name: town.label || town.name || town.id,
          spawn: { x: town.x, y: town.y },
        });
        zoneSet.add(regionId);
      }
    }
  }

  // ── Pass 2: Scan level files ──
  let levelFiles = [];
  try {
    levelFiles = fs.readdirSync(LEVELS_DIR).filter(f => f.endsWith('.json') && f !== 'index.json');
  } catch { /* no levels dir */ }

  for (const file of levelFiles) {
    const filePath = path.join(LEVELS_DIR, file);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { continue; }

    if (!data.id || typeof data.id !== 'string') {
      warnLevel(file, 'missing id');
      continue;
    }

    const levelZoneId = 'level:' + data.id;
    if (!parseZoneId(levelZoneId)) {
      warnLevel(data.id, 'id fails zone grammar');
      continue;
    }

    const lbounds = extractRectBounds(data.tilemap);
    if (!lbounds) {
      warnLevel(data.id, 'missing/non-rectangular tilemap');
      continue;
    }

    if (!data.spawns || !data.spawns.player ||
        !Number.isInteger(data.spawns.player.x) || !Number.isInteger(data.spawns.player.y)) {
      warnLevel(data.id, 'missing/invalid spawns.player');
      continue;
    }
    if (data.spawns.player.x < 0 || data.spawns.player.x >= lbounds.w ||
        data.spawns.player.y < 0 || data.spawns.player.y >= lbounds.h) {
      warnLevel(data.id, 'spawns.player out of bounds');
      continue;
    }

    const lcoll = buildCollisionDescriptor(levelZoneId, lbounds.w, lbounds.h);
    level.push({
      id: levelZoneId,
      bounds: { w: lbounds.w, h: lbounds.h },
      collision: { ver: lcoll.descriptor.ver, hash: lcoll.descriptor.hash },
    });
    zoneSet.add(levelZoneId);
  }

  // ── Pass 3: Process level entrances (requires level zoneSet) ──
  // _entrances: Map(regionKey -> Map(toLevelId -> [{x, y, facing}]))
  const entrances = new Map();

  for (const [regionKey, { data, bounds }] of regionDataCache) {
    if (!Array.isArray(data.levelEntrances)) continue;
    const regionEntrances = new Map();

    for (const ent of data.levelEntrances) {
      const wKey = regionKey + ':' + (ent.id || '?');

      if (!ent.id || typeof ent.id !== 'string' || !ENTRANCE_ID_RE.test(ent.id)) {
        warnEntrance(wKey, 'bad id format');
        continue;
      }
      if (!Number.isInteger(ent.x) || !Number.isInteger(ent.y)) {
        warnEntrance(wKey, 'non-integer coords');
        continue;
      }
      if (ent.x < 0 || ent.x >= bounds.w || ent.y < 0 || ent.y >= bounds.h) {
        warnEntrance(wKey, 'out of bounds');
        continue;
      }
      if (!ent.toLevelId || typeof ent.toLevelId !== 'string') {
        warnEntrance(wKey, 'missing toLevelId');
        continue;
      }
      if (!zoneSet.has(ent.toLevelId)) {
        warnEntrance(wKey, 'toLevelId not in directory: ' + ent.toLevelId);
        continue;
      }
      const parsed = parseZoneId(ent.toLevelId);
      if (!parsed || parsed.type !== 'level') {
        warnEntrance(wKey, 'toLevelId not a level zone');
        continue;
      }

      if (!regionEntrances.has(ent.toLevelId)) {
        regionEntrances.set(ent.toLevelId, []);
      }
      regionEntrances.get(ent.toLevelId).push({
        x: ent.x,
        y: ent.y,
        facing: VALID_FACING[ent.facing] ? ent.facing : null,
      });
    }

    if (regionEntrances.size > 0) {
      entrances.set(regionKey, regionEntrances);
    }
  }

  return { world, region, level, _zoneSet: zoneSet, _entrances: entrances, _builtAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractRectBounds(grid) {
  if (!Array.isArray(grid) || grid.length === 0) return null;
  const h = grid.length;
  const first = grid[0];
  if (!Array.isArray(first) || first.length === 0) return null;
  const w = first.length;
  for (let r = 1; r < h; r++) {
    if (!Array.isArray(grid[r]) || grid[r].length !== w) return null;
  }
  return { w, h };
}

function warnTown(key, reason) {
  if (_warnedTowns.has(key)) return;
  _warnedTowns.add(key);
  console.warn(`[zone_dir] ZONE_DIR_TOWN_INVALID: ${key} (${reason})`);
}

function warnLevel(id, reason) {
  if (_warnedLevels.has(id)) return;
  _warnedLevels.add(id);
  console.warn(`[zone_dir] ZONE_DIR_LEVEL_INVALID: ${id} (${reason})`);
}

function warnEntrance(key, reason) {
  if (_warnedEntrances.has(key)) return;
  _warnedEntrances.add(key);
  console.warn(`[zone_dir] ZONE_DIR_ENTRANCE_INVALID: ${key} (${reason})`);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function refresh() {
  try {
    _snapshot = buildSnapshot();
    _stale = false;
    console.log(`[zone_dir] refreshed: ${_snapshot.world.length} world, ${_snapshot.region.length} region, ${_snapshot.level.length} level`);
  } catch (e) {
    _stale = true;
    console.error(`[zone_dir] ZONE_DIR_UNAVAILABLE: refresh failed (${e.message})`);
  }
}

function start() {
  refresh();
  _timer = setInterval(refresh, DIR_REFRESH_SEC * 1000);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

function getSnapshot() { return _snapshot; }
function isStale() { return _stale; }

function exists(zoneId) {
  if (!_snapshot) return false;
  return _snapshot._zoneSet.has(zoneId);
}

// Routing rules for transfer validation.
// Returns { ok: true } or { ok: false, code, msg }.
function validateTransferRoute(fromZoneId, toZoneId) {
  if (!exists(toZoneId)) {
    return { ok: false, code: 'TRANSFER_INVALID_ZONE', msg: 'zone not in directory' };
  }

  const from = parseZoneId(fromZoneId);
  const to   = parseZoneId(toZoneId);
  if (!from || !to) {
    return { ok: false, code: 'TRANSFER_INVALID_ZONE', msg: 'invalid zone id' };
  }

  // world -> region: must share regionKey
  if (from.type === 'world' && to.type === 'region') {
    if (from.regionKey !== to.regionKey) {
      return { ok: false, code: 'TRANSFER_INVALID_ZONE', msg: 'cross-region transfer forbidden' };
    }
  }

  // region -> world: must share regionKey
  if (from.type === 'region' && to.type === 'world') {
    if (from.regionKey !== to.regionKey) {
      return { ok: false, code: 'TRANSFER_INVALID_ZONE', msg: 'cross-region transfer forbidden' };
    }
  }

  // world -> level: blocked in production unless ALLOW_WORLD_LEVEL_TELEPORT=true
  if (from.type === 'world' && to.type === 'level') {
    if (!config.ALLOW_WORLD_LEVEL_TELEPORT) {
      return { ok: false, code: 'TRANSFER_INVALID_ZONE', msg: 'world-to-level teleport disabled' };
    }
  }

  return { ok: true };
}

// Region → Level entrance gating.
// Only applies when from=region and to=level.
// Returns { ok:true, entrance } or { ok:false, code, msg }.
function checkEntranceEligibility(fromZoneId, toZoneId, entityX, entityY) {
  if (!_snapshot) {
    return { ok: false, code: 'TRANSFER_INVALID_ZONE', msg: 'directory not ready' };
  }

  const from = parseZoneId(fromZoneId);
  const to   = parseZoneId(toZoneId);

  if (!from || from.type !== 'region' || !to || to.type !== 'level') {
    return { ok: true };
  }

  const regionEntrances = _snapshot._entrances.get(from.regionKey);
  if (!regionEntrances) {
    return { ok: false, code: 'TRANSFER_INVALID_ZONE', msg: 'no entrances in region' };
  }

  const levelTiles = regionEntrances.get(toZoneId);
  if (!levelTiles || levelTiles.length === 0) {
    return { ok: false, code: 'TRANSFER_INVALID_ZONE', msg: 'no entrance to this level from region' };
  }

  const match = levelTiles.find(e => e.x === entityX && e.y === entityY);
  if (!match) {
    return { ok: false, code: 'TRANSFER_FAILED', msg: 'not_on_entrance' };
  }

  return { ok: true, entrance: match };
}

// For tests: allow injecting a snapshot without scanning files.
function _injectSnapshot(snap) {
  _snapshot = snap;
  _stale = false;
}

module.exports = {
  start, stop, refresh,
  getSnapshot, isStale, exists,
  validateTransferRoute,
  checkEntranceEligibility,
  buildSnapshot,
  DIR_REFRESH_SEC,
  _injectSnapshot,
};
