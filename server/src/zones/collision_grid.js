// Collision grid: per-zone boolean matrix (1=blocked, 0=walkable).
// Generated from data files at zone creation. Never mutated at runtime in v1.
//
// Collision Derivation Rules v1 (locked):
//   Terrain classes: OCEAN(0)=blocked, COAST(1)=walkable, LAND(2)=walkable,
//                    MOUNTAIN(3)=blocked, RIVER(4)=blocked
//   Derivation order (4 passes): terrain → buildings → roads → sidewalks
//   Priority: terrain < building < road (sidewalk cannot override building)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseZoneId } = require('./zone_id');

const { getFootprintRect } = require('../../../js/shared/building_fp');
const DATA_DIR    = path.join(__dirname, '..', '..', '..', 'data');
const REGIONS_DIR = path.join(DATA_DIR, 'regions');
const LEVELS_DIR  = path.join(DATA_DIR, 'levels');

// v1 terrain class enum (integer values from terrainGrid)
const TERRAIN = Object.freeze({
  OCEAN: 0,
  COAST: 1,
  LAND: 2,
  MOUNTAIN: 3,
  RIVER: 4,
});

// v1 blocked decision: OCEAN, MOUNTAIN, RIVER blocked. COAST, LAND walkable.
const TERRAIN_BLOCKED = Object.freeze({
  [TERRAIN.OCEAN]: true,
  [TERRAIN.MOUNTAIN]: true,
  [TERRAIN.RIVER]: true,
});

// Terrain classes eligible for sidewalk clearing (4-neighbor adjacent to road).
const SIDEWALK_ELIGIBLE = Object.freeze({
  [TERRAIN.LAND]: true,
  [TERRAIN.COAST]: true,
});

const LEVEL_WALL = 1;

// Log-once sets to prevent spam.
const _warnedUnknownTerrain = new Set();
const _warnedBldOob = new Set();
const _warnedRoadOob = new Set();

// --- Grid generation per zone type ---

function generateGrid(zoneId, w, h) {
  const parsed = parseZoneId(zoneId);
  if (!parsed) return emptyGrid(w, h);

  if (parsed.type === 'world' || parsed.type === 'region') {
    return generateRegionGrid(parsed.regionKey, w, h, zoneId);
  }
  if (parsed.type === 'level') {
    return generateLevelGrid(parsed.levelId, w, h);
  }
  return emptyGrid(w, h);
}

function generateRegionGrid(regionKey, w, h, zoneId) {
  const filePath = path.join(REGIONS_DIR, regionKey + '.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    console.warn(`[collision] ${zoneId}: region data not found, empty grid`);
    return emptyGrid(w, h);
  }

  const grid = emptyGrid(w, h);

  // ── Pass 1: Base blocked grid from terrain ──
  if (Array.isArray(data.terrainGrid)) {
    for (let y = 0; y < h && y < data.terrainGrid.length; y++) {
      const row = data.terrainGrid[y];
      if (!Array.isArray(row)) continue;
      for (let x = 0; x < w && x < row.length; x++) {
        const tv = row[x];
        if (tv === undefined || tv === null) continue;
        if (TERRAIN_BLOCKED[tv]) {
          grid[y][x] = 1;
        } else if (tv !== TERRAIN.COAST && tv !== TERRAIN.LAND &&
                   tv !== TERRAIN.MOUNTAIN && tv !== TERRAIN.OCEAN &&
                   tv !== TERRAIN.RIVER) {
          if (!_warnedUnknownTerrain.has(zoneId)) {
            _warnedUnknownTerrain.add(zoneId);
            console.warn(`[collision] ${zoneId}: unknown terrain value ${tv}, treating as LAND`);
          }
        }
      }
    }
  }

  // ── Pass 2: Apply bgBuildings (footprint rectangles, SW anchor) ──
  if (Array.isArray(data.bgBuildings)) {
    for (const b of data.bgBuildings) {
      const rect = getFootprintRect(b);
      for (let yy = rect.y0; yy < rect.y0 + rect.h; yy++) {
        for (let xx = rect.x0; xx < rect.x0 + rect.w; xx++) {
          if (xx >= 0 && xx < w && yy >= 0 && yy < h) {
            grid[yy][xx] = 1;
          }
        }
      }
      if (rect.x0 < 0 || rect.x0 + rect.w > w || rect.y0 < 0 || rect.y0 + rect.h > h) {
        if (!_warnedBldOob.has(zoneId)) {
          _warnedBldOob.add(zoneId);
          console.warn(`[collision] ${zoneId}: bgBuilding footprint partially out of bounds (${b.x},${b.y} fp:${rect.w}x${rect.h})`);
        }
      }
    }
  }

  // ── Pass 3: Apply roads (carve blocked → walkable) ──
  if (Array.isArray(data.roadTiles)) {
    for (const rt of data.roadTiles) {
      if (rt.x >= 0 && rt.x < w && rt.y >= 0 && rt.y < h) {
        grid[rt.y][rt.x] = 0;
      } else if (!_warnedRoadOob.has(zoneId)) {
        _warnedRoadOob.add(zoneId);
        console.warn(`[collision] ${zoneId}: roadTile out of bounds (${rt.x},${rt.y})`);
      }
    }
  }

  // ── Pass 4: Apply sidewalks (derived, not stored) ──
  // Definition: LAND or COAST tile, NOT a building tile, 4-neighbor adjacent
  // to a road tile → set walkable. Does NOT clear ocean/river/mountain.
  if (Array.isArray(data.terrainGrid) && Array.isArray(data.roadTiles)) {
    const roadSet = new Set();
    for (const rt of data.roadTiles) {
      if (rt.x >= 0 && rt.x < w && rt.y >= 0 && rt.y < h) {
        roadSet.add(rt.y * w + rt.x);
      }
    }

    const buildingSet = new Set();
    if (Array.isArray(data.bgBuildings)) {
      for (const b of data.bgBuildings) {
        const rect = getFootprintRect(b);
        for (let yy = rect.y0; yy < rect.y0 + rect.h; yy++) {
          for (let xx = rect.x0; xx < rect.x0 + rect.w; xx++) {
            if (xx >= 0 && xx < w && yy >= 0 && yy < h) {
              buildingSet.add(yy * w + xx);
            }
          }
        }
      }
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (grid[y][x] === 0) continue;
        const terrain = data.terrainGrid[y] && data.terrainGrid[y][x];
        if (!SIDEWALK_ELIGIBLE[terrain]) continue;
        const k = y * w + x;
        if (buildingSet.has(k)) continue;
        if ((x > 0     && roadSet.has(k - 1)) ||
            (x < w - 1 && roadSet.has(k + 1)) ||
            (y > 0     && roadSet.has(k - w)) ||
            (y < h - 1 && roadSet.has(k + w))) {
          grid[y][x] = 0;
        }
      }
    }
  }

  return grid;
}

function generateLevelGrid(levelId, w, h) {
  const filePath = path.join(LEVELS_DIR, levelId + '.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    console.warn(`[collision] level ${levelId}: data not found, empty grid`);
    return emptyGrid(w, h);
  }

  const grid = emptyGrid(w, h);
  const tilemap = data.tilemap;
  if (!Array.isArray(tilemap)) return grid;

  for (let y = 0; y < h && y < tilemap.length; y++) {
    const row = tilemap[y];
    if (!Array.isArray(row)) continue;
    for (let x = 0; x < w && x < row.length; x++) {
      if (row[x] === LEVEL_WALL) grid[y][x] = 1;
    }
  }

  return grid;
}

function emptyGrid(w, h) {
  const grid = new Array(h);
  for (let y = 0; y < h; y++) grid[y] = new Uint8Array(w);
  return grid;
}

// --- blocked() ---

function isBlocked(grid, x, y, w, h) {
  if (x < 0 || y < 0 || x >= w || y >= h) return true;
  return grid[y][x] === 1;
}

// --- Bitset RLE encoding ---
// Standard base64 (not URL-safe). Hash computed over exact base64 string bytes.

function encodeBitsetRle(grid, w, h) {
  if (w === 0 || h === 0) return '';

  let prev = grid[0][0] ? 1 : 0;
  let count = 0;
  const runs = [];
  const startBit = prev;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bit = grid[y][x] ? 1 : 0;
      if (bit === prev) {
        count++;
      } else {
        runs.push(count);
        prev = bit;
        count = 1;
      }
    }
  }
  runs.push(count);

  const bytes = [startBit & 1];
  for (const run of runs) {
    pushVarint(bytes, run);
  }

  return Buffer.from(bytes).toString('base64');
}

function pushVarint(bytes, value) {
  while (value >= 0x80) {
    bytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7F);
}

function decodeBitsetRle(base64, w, h) {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0) return emptyGrid(w, h);

  let pos = 0;
  const startBit = buf[pos++] & 1;
  const total = w * h;
  const grid = emptyGrid(w, h);

  let bitIdx = 0;
  let currentBit = startBit;

  while (bitIdx < total && pos < buf.length) {
    let runLen = 0;
    let shift = 0;
    let b;
    do {
      b = buf[pos++];
      runLen |= (b & 0x7F) << shift;
      shift += 7;
    } while ((b & 0x80) && pos < buf.length);

    const end = Math.min(bitIdx + runLen, total);
    if (currentBit === 1) {
      for (let i = bitIdx; i < end; i++) {
        const y = (i / w) | 0;
        const x = i % w;
        grid[y][x] = 1;
      }
    }
    bitIdx = end;
    currentBit ^= 1;
  }

  return grid;
}

// --- Hashing ---

function hashGrid(base64Data) {
  const full = crypto.createHash('sha256').update(base64Data).digest('hex');
  return 'sha256:' + full.substring(0, 16);
}

// --- Build full collision descriptor for a zone ---

function buildCollisionDescriptor(zoneId, w, h) {
  const grid = generateGrid(zoneId, w, h);
  const data = encodeBitsetRle(grid, w, h);
  const hash = hashGrid(data);
  return {
    grid,
    descriptor: {
      mode: 'grid',
      ver: 1,
      hash,
      format: 'bitset_rle',
      data,
    },
  };
}

module.exports = {
  generateGrid,
  isBlocked,
  encodeBitsetRle,
  decodeBitsetRle,
  hashGrid,
  buildCollisionDescriptor,
  emptyGrid,
  TERRAIN, TERRAIN_BLOCKED, SIDEWALK_ELIGIBLE,
};
