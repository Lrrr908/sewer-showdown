#!/usr/bin/env node
// Collision Derivation Rules v1 — Spec Tests + Golden Hash Fixtures.
// Run: node server/tests/collision_derivation.test.js

const {
  encodeBitsetRle, decodeBitsetRle, hashGrid, emptyGrid, isBlocked,
  TERRAIN, TERRAIN_BLOCKED, SIDEWALK_ELIGIBLE,
} = require('../src/zones/collision_grid');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}`); }
}

// ===== Helpers: simulate the 4 derivation passes for test fixtures =====

function deriveGrid(terrain, bgBuildings, roadTiles, w, h) {
  const grid = emptyGrid(w, h);

  // Pass 1: terrain
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tv = terrain[y][x];
      if (TERRAIN_BLOCKED[tv]) grid[y][x] = 1;
    }
  }

  // Pass 2: buildings
  for (const b of bgBuildings) {
    if (b.x >= 0 && b.x < w && b.y >= 0 && b.y < h) grid[b.y][b.x] = 1;
  }

  // Pass 3: roads
  for (const r of roadTiles) {
    if (r.x >= 0 && r.x < w && r.y >= 0 && r.y < h) grid[r.y][r.x] = 0;
  }

  // Pass 4: sidewalks
  const roadSet = new Set(roadTiles.filter(r => r.x >= 0 && r.x < w && r.y >= 0 && r.y < h)
    .map(r => r.y * w + r.x));
  const bldSet = new Set(bgBuildings.filter(b => b.x >= 0 && b.x < w && b.y >= 0 && b.y < h)
    .map(b => b.y * w + b.x));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y][x] === 0) continue;
      if (!SIDEWALK_ELIGIBLE[terrain[y][x]]) continue;
      const k = y * w + x;
      if (bldSet.has(k)) continue;
      if ((x > 0 && roadSet.has(k - 1)) || (x < w - 1 && roadSet.has(k + 1)) ||
          (y > 0 && roadSet.has(k - w)) || (y < h - 1 && roadSet.has(k + w))) {
        grid[y][x] = 0;
      }
    }
  }
  return grid;
}

// ===== Fixture: 8x8 region =====
// Terrain: river at y=3, mountains at (3-4,1-2), ocean at corners of y=6-7, coast at y=5 edges.
// Road: vertical at x=4. Buildings: (3,1) on mountain, (5,4) on land next to road.

const FIX_W = 8, FIX_H = 8;
const FIX_TERRAIN = [
  [2, 2, 2, 2, 2, 2, 2, 2],  // y=0: land
  [2, 2, 2, 3, 3, 2, 2, 2],  // y=1: land + mountain
  [2, 2, 2, 3, 3, 2, 2, 2],  // y=2: land + mountain
  [4, 4, 4, 4, 4, 4, 4, 4],  // y=3: river
  [2, 2, 2, 2, 2, 2, 2, 2],  // y=4: land
  [1, 1, 2, 2, 2, 2, 1, 1],  // y=5: coast + land
  [0, 0, 2, 2, 2, 2, 0, 0],  // y=6: ocean + land
  [0, 0, 0, 2, 2, 0, 0, 0],  // y=7: ocean + land
];
const FIX_ROADS = [
  {x:4,y:0},{x:4,y:1},{x:4,y:2},{x:4,y:3},{x:4,y:4},{x:4,y:5},{x:4,y:6},{x:4,y:7},
];
const FIX_BLDS = [
  {x:3, y:1},
  {x:5, y:4},
];

const GOLDEN_BASE64 = 'AAsBBwEEBAEDBQEKAgQFAgM=';
const GOLDEN_HASH   = 'sha256:1aa240b2e38f1e8d';

// ===========================================================================
// Tests
// ===========================================================================

function test_terrainClasses() {
  console.log('\nT1: Terrain class definitions locked');
  assert(TERRAIN.OCEAN === 0, 'OCEAN = 0');
  assert(TERRAIN.COAST === 1, 'COAST = 1');
  assert(TERRAIN.LAND === 2, 'LAND = 2');
  assert(TERRAIN.MOUNTAIN === 3, 'MOUNTAIN = 3');
  assert(TERRAIN.RIVER === 4, 'RIVER = 4');

  assert(TERRAIN_BLOCKED[TERRAIN.OCEAN] === true, 'OCEAN blocked');
  assert(TERRAIN_BLOCKED[TERRAIN.MOUNTAIN] === true, 'MOUNTAIN blocked');
  assert(TERRAIN_BLOCKED[TERRAIN.RIVER] === true, 'RIVER blocked');
  assert(!TERRAIN_BLOCKED[TERRAIN.COAST], 'COAST walkable');
  assert(!TERRAIN_BLOCKED[TERRAIN.LAND], 'LAND walkable');

  assert(SIDEWALK_ELIGIBLE[TERRAIN.LAND] === true, 'LAND eligible for sidewalk');
  assert(SIDEWALK_ELIGIBLE[TERRAIN.COAST] === true, 'COAST eligible for sidewalk');
  assert(!SIDEWALK_ELIGIBLE[TERRAIN.OCEAN], 'OCEAN not eligible for sidewalk');
  assert(!SIDEWALK_ELIGIBLE[TERRAIN.MOUNTAIN], 'MOUNTAIN not eligible for sidewalk');
  assert(!SIDEWALK_ELIGIBLE[TERRAIN.RIVER], 'RIVER not eligible for sidewalk');
}

function test_pass1_terrain() {
  console.log('\nT2: Pass 1 — base blocked from terrain');
  const grid = emptyGrid(FIX_W, FIX_H);
  for (let y = 0; y < FIX_H; y++) {
    for (let x = 0; x < FIX_W; x++) {
      if (TERRAIN_BLOCKED[FIX_TERRAIN[y][x]]) grid[y][x] = 1;
    }
  }

  assert(grid[0][0] === 0, '(0,0) land = walkable');
  assert(grid[1][3] === 1, '(3,1) mountain = blocked');
  assert(grid[3][0] === 1, '(0,3) river = blocked');
  assert(grid[5][0] === 0, '(0,5) coast = walkable');
  assert(grid[6][0] === 1, '(0,6) ocean = blocked');
  assert(grid[7][3] === 0, '(3,7) land = walkable');
}

function test_pass2_buildings() {
  console.log('\nT3: Pass 2 — buildings add blocks');
  const grid = deriveGrid(FIX_TERRAIN, FIX_BLDS, [], FIX_W, FIX_H);
  assert(grid[1][3] === 1, '(3,1) building on mountain = blocked');
  assert(grid[4][5] === 1, '(5,4) building on land = blocked');
}

function test_pass3_roadCarve() {
  console.log('\nT4: Pass 3 — roads carve blocked tiles');
  const grid = deriveGrid(FIX_TERRAIN, FIX_BLDS, FIX_ROADS, FIX_W, FIX_H);
  assert(grid[3][4] === 0, '(4,3) road over river = walkable (road wins)');
  assert(grid[1][4] === 0, '(4,1) road over mountain = walkable (road wins)');
  assert(grid[3][3] === 1, '(3,3) river no road = blocked');
  assert(grid[3][5] === 1, '(5,3) river no road = blocked');
}

function test_pass4_sidewalks() {
  console.log('\nT5: Pass 4 — sidewalk rules');
  const grid = deriveGrid(FIX_TERRAIN, FIX_BLDS, FIX_ROADS, FIX_W, FIX_H);

  // Building at (5,4) is adjacent to road (4,4) but must NOT be cleared.
  assert(grid[4][5] === 1, '(5,4) building adjacent to road stays blocked (sidewalk cannot clear building)');

  // Mountain at (3,2) is adjacent to road (4,2) but mountain is not SIDEWALK_ELIGIBLE.
  assert(grid[2][3] === 1, '(3,2) mountain adjacent to road stays blocked (mountain not eligible)');

  // River at (3,3) is adjacent to road (4,3) but river is not SIDEWALK_ELIGIBLE.
  assert(grid[3][3] === 1, '(3,3) river adjacent to road stays blocked (river not eligible)');

  // Ocean at (0,6) stays blocked even if near road.
  assert(grid[6][0] === 1, '(0,6) ocean stays blocked (not eligible)');
}

function test_sidewalk_clears_land() {
  console.log('\nT6: Sidewalk clears blocked LAND tile adjacent to road');

  // Synthetic: LAND tile blocked by... well, LAND isn't blocked by terrain.
  // The only time sidewalk clearing matters is if a future terrain type
  // maps to LAND-class but is blocked. For v1, verify the logic works
  // with a manually crafted grid.
  const w = 4, h = 3;
  const terrain = [
    [2, 2, 2, 2],
    [2, 2, 2, 2],
    [2, 2, 2, 2],
  ];
  const grid = emptyGrid(w, h);
  // Manually block (1,1) as if some rule blocked it.
  grid[1][1] = 1;
  // Road at (2,1).
  const roadSet = new Set([1 * w + 2]);
  const bldSet = new Set();
  // Apply sidewalk pass manually.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y][x] === 0) continue;
      if (!SIDEWALK_ELIGIBLE[terrain[y][x]]) continue;
      const k = y * w + x;
      if (bldSet.has(k)) continue;
      if ((x > 0 && roadSet.has(k - 1)) || (x < w - 1 && roadSet.has(k + 1)) ||
          (y > 0 && roadSet.has(k - w)) || (y < h - 1 && roadSet.has(k + w))) {
        grid[y][x] = 0;
      }
    }
  }
  assert(grid[1][1] === 0, 'LAND tile (1,1) cleared by sidewalk (adjacent to road at 2,1)');
}

function test_sidewalk_does_not_clear_building() {
  console.log('\nT7: Sidewalk does NOT clear building tile even if LAND + adjacent to road');
  const w = 4, h = 3;
  const terrain = [
    [2, 2, 2, 2],
    [2, 2, 2, 2],
    [2, 2, 2, 2],
  ];
  const grid = emptyGrid(w, h);
  grid[1][1] = 1; // Building at (1,1)
  const roadSet = new Set([1 * w + 2]);
  const bldSet = new Set([1 * w + 1]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y][x] === 0) continue;
      if (!SIDEWALK_ELIGIBLE[terrain[y][x]]) continue;
      const k = y * w + x;
      if (bldSet.has(k)) continue;
      if ((x > 0 && roadSet.has(k - 1)) || (x < w - 1 && roadSet.has(k + 1)) ||
          (y > 0 && roadSet.has(k - w)) || (y < h - 1 && roadSet.has(k + w))) {
        grid[y][x] = 0;
      }
    }
  }
  assert(grid[1][1] === 1, 'building at (1,1) stays blocked despite road adjacency');
}

function test_goldenHash() {
  console.log('\nT8: Golden hash — 8x8 fixture encode + hash matches locked values');
  const grid = deriveGrid(FIX_TERRAIN, FIX_BLDS, FIX_ROADS, FIX_W, FIX_H);
  const encoded = encodeBitsetRle(grid, FIX_W, FIX_H);
  const hash = hashGrid(encoded);

  assert(encoded === GOLDEN_BASE64, 'base64 matches golden: ' + encoded);
  assert(hash === GOLDEN_HASH, 'hash matches golden: ' + hash);
}

function test_goldenRoundtrip() {
  console.log('\nT9: Golden roundtrip — decode then re-encode produces same base64');
  const decoded = decodeBitsetRle(GOLDEN_BASE64, FIX_W, FIX_H);
  const reencoded = encodeBitsetRle(decoded, FIX_W, FIX_H);
  assert(reencoded === GOLDEN_BASE64, 'roundtrip base64 matches');

  const rehash = hashGrid(reencoded);
  assert(rehash === GOLDEN_HASH, 'roundtrip hash matches');
}

function test_unknownTerrainTreatedAsLand() {
  console.log('\nT10: Unknown terrain value treated as LAND (walkable)');
  const grid = emptyGrid(4, 1);
  const terrain = [[2, 99, 2, 2]];
  // Pass 1: value 99 is unknown, should be walkable.
  for (let x = 0; x < 4; x++) {
    if (TERRAIN_BLOCKED[terrain[0][x]]) grid[0][x] = 1;
  }
  assert(grid[0][1] === 0, 'unknown terrain(99) at (1,0) is walkable');
}

function test_passPriorityOrder() {
  console.log('\nT11: Pass priority — building on road tile: road wins, building loses');
  const w = 4, h = 1;
  const terrain = [[2, 2, 2, 2]];
  const blds = [{x: 2, y: 0}];
  const roads = [{x: 2, y: 0}];
  const grid = deriveGrid(terrain, blds, roads, w, h);
  assert(grid[0][2] === 0, 'road at (2,0) wins over building at same tile');
}

function test_roadOverRiver() {
  console.log('\nT12: Road over river creates bridge (walkable)');
  const w = 5, h = 1;
  const terrain = [[4, 4, 4, 4, 4]]; // all river
  const roads = [{x: 2, y: 0}];
  const grid = deriveGrid(terrain, [], roads, w, h);
  assert(grid[0][0] === 1, 'river without road: blocked');
  assert(grid[0][2] === 0, 'river with road: walkable (bridge)');
  assert(grid[0][4] === 1, 'river without road: blocked');
}

// ===========================================================================
// Run all
// ===========================================================================
console.log('=== Collision Derivation Rules v1 — Spec Tests ===');
test_terrainClasses();
test_pass1_terrain();
test_pass2_buildings();
test_pass3_roadCarve();
test_pass4_sidewalks();
test_sidewalk_clears_land();
test_sidewalk_does_not_clear_building();
test_goldenHash();
test_goldenRoundtrip();
test_unknownTerrainTreatedAsLand();
test_passPriorityOrder();
test_roadOverRiver();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
