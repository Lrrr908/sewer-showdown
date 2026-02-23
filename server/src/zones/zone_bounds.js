// Loads zone bounds from data files.
// world:<rk> and region:<rk>:<inst> -> data/regions/<rk>.json terrainGrid
// level:<levelId>                   -> data/levels/<levelId>.json tilemap
// Always returns frozen { w, h }. Never null.

const fs = require('fs');
const path = require('path');
const { parseZoneId } = require('./zone_id');

const DATA_DIR    = path.join(__dirname, '..', '..', '..', 'data');
const REGIONS_DIR = path.join(DATA_DIR, 'regions');
const LEVELS_DIR  = path.join(DATA_DIR, 'levels');

const FALLBACK_BOUNDS = Object.freeze({ w: 200, h: 120 });
const cache = new Map();

function loadBounds(zoneId) {
  if (cache.has(zoneId)) return cache.get(zoneId);

  const parsed = parseZoneId(zoneId);
  if (!parsed) {
    cache.set(zoneId, FALLBACK_BOUNDS);
    return FALLBACK_BOUNDS;
  }

  let bounds;
  if (parsed.type === 'world' || parsed.type === 'region') {
    bounds = loadRegionBounds(parsed.regionKey, zoneId);
  } else if (parsed.type === 'level') {
    bounds = loadLevelBounds(parsed.levelId, zoneId);
  } else {
    bounds = FALLBACK_BOUNDS;
  }

  cache.set(zoneId, bounds);
  return bounds;
}

function loadRegionBounds(regionKey, zoneId) {
  const filePath = path.join(REGIONS_DIR, regionKey + '.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn(`[bounds] ${zoneId}: region file not found (${e.code || e.message}), using fallback`);
    return FALLBACK_BOUNDS;
  }
  return extractGridBounds(data.terrainGrid, 'terrainGrid', zoneId);
}

function loadLevelBounds(levelId, zoneId) {
  const filePath = path.join(LEVELS_DIR, levelId + '.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn(`[bounds] ${zoneId}: level file not found (${e.code || e.message}), using fallback`);
    return FALLBACK_BOUNDS;
  }
  return extractGridBounds(data.tilemap, 'tilemap', zoneId);
}

// Shared rectangular grid validation for terrainGrid and tilemap.
function extractGridBounds(grid, fieldName, zoneId) {
  if (!Array.isArray(grid) || grid.length === 0) {
    console.warn(`[bounds] ${zoneId}: ${fieldName} missing or empty, using fallback`);
    return FALLBACK_BOUNDS;
  }

  const h = grid.length;
  const w = Array.isArray(grid[0]) ? grid[0].length : 0;
  if (w === 0) {
    console.warn(`[bounds] ${zoneId}: ${fieldName} row 0 empty, using fallback`);
    return FALLBACK_BOUNDS;
  }

  for (let r = 1; r < h; r++) {
    if (!Array.isArray(grid[r]) || grid[r].length !== w) {
      console.warn(`[bounds] ${zoneId}: non-rectangular ${fieldName} (row ${r} has ${
        Array.isArray(grid[r]) ? grid[r].length : 0
      } cols, expected ${w}), using fallback`);
      return FALLBACK_BOUNDS;
    }
  }

  const bounds = Object.freeze({ w, h });
  console.log(`[bounds] ${zoneId}: ${w}x${h} tiles`);
  return bounds;
}

module.exports = { loadBounds, FALLBACK_BOUNDS };
