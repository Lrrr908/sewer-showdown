#!/usr/bin/env node
// World Collision Authority — 8 spec invariant tests.
// Run: node server/tests/collision_authority.test.js

const { Zone, wireSnapshot } = require('../src/zones/zone');
const { ZoneManager } = { ZoneManager: require('../src/zones/zone_manager') };
const {
  encodeBitsetRle, decodeBitsetRle, isBlocked, emptyGrid, hashGrid,
} = require('../src/zones/collision_grid');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}`); }
}

function makeEntity(id, accountId, x, y) {
  return {
    id, accountId, zoneId: null,
    x: x || 0, y: y || 0, facing: 's', spriteRef: 'base:van',
    lastSeq: 0, intent: null,
    hitbox: { x: 0, y: 0, w: 1, h: 1 },
    ownership: { type: 'account', id: accountId },
  };
}

function mockWs() {
  const ws = {
    readyState: 1, sent: [],
    send(data) { ws.sent.push(typeof data === 'string' ? JSON.parse(data) : data); },
    close() { ws.readyState = 3; },
  };
  return ws;
}

// Create a zone with a custom collision grid for controlled testing.
function testZone() {
  const zm = new ZoneManager();
  const zone = zm.getOrCreate('world:na');
  // Inject a custom small collision overlay for tests.
  // The zone already loaded the real na.json grid. We'll override
  // specific tiles for deterministic testing.
  return zone;
}

// ===========================================================================
// S1: Deny movement into blocked tile
// ===========================================================================
function testS1_denyBlockedTile() {
  console.log('\nS1: Deny movement into blocked tile');
  const zone = testZone();

  // Place entity at a known walkable position.
  const entity = makeEntity('p_s1', 'acct_s1', 5, 5);
  const ws = mockWs();
  zone.addEntity(entity, ws);

  // Manually block (6,5) in the zone's collision grid for this test.
  zone._collisionGrid[5][6] = 1;

  zone.applyInput('acct_s1', { seq: 1, move: { x: 1, y: 0 }, facing: 'e' });
  zone.tick();

  assert(entity.x === 5, 'x unchanged (blocked east)');
  assert(entity.y === 5, 'y unchanged');
  assert(zone.dirtyUpserts.has('p_s1'), 'entity dirty (denial must trigger upsert for correction)');

  // Restore for other tests
  zone._collisionGrid[5][6] = 0;
}

// ===========================================================================
// S2: Allow movement into open tile
// ===========================================================================
function testS2_allowOpenTile() {
  console.log('\nS2: Allow movement into open tile');
  const zone = testZone();

  // Find a known walkable pair. We'll use spawn which is guaranteed walkable.
  const sx = zone.spawnX;
  const sy = zone.spawnY;
  const entity = makeEntity('p_s2', 'acct_s2', sx, sy);
  const ws = mockWs();
  zone.addEntity(entity, ws);

  // Ensure target tile is walkable for deterministic test.
  // Try moving south (usually safe from spawn).
  const targetY = Math.min(sy + 1, zone.boundsH - 1);
  zone._collisionGrid[targetY][sx] = 0;

  zone.applyInput('acct_s2', { seq: 1, move: { x: 0, y: 1 }, facing: 's' });
  zone.tick();

  if (targetY !== sy) {
    assert(entity.y === targetY, 'moved south to ' + targetY);
  } else {
    assert(entity.y === sy, 'at bounds edge, stayed');
  }
  assert(zone.dirtyUpserts.has('p_s2'), 'entity dirty after movement');
}

// ===========================================================================
// S3: Diagonal normalization — X wins
// ===========================================================================
function testS3_diagonalNormalization() {
  console.log('\nS3: Diagonal normalization — X wins, Y zeroed');
  const zone = testZone();

  const entity = makeEntity('p_s3', 'acct_s3', 10, 10);
  const ws = mockWs();
  zone.addEntity(entity, ws);

  // Ensure (11,10) is walkable, (10,11) is blocked.
  zone._collisionGrid[10][11] = 0;
  zone._collisionGrid[11][10] = 1;

  zone.applyInput('acct_s3', { seq: 1, move: { x: 1, y: 1 }, facing: 'e' });
  zone.tick();

  // X wins: entity moves to (11,10), Y is zeroed.
  assert(entity.x === 11, 'moved east (X axis wins diagonal)');
  assert(entity.y === 10, 'Y unchanged (diagonal normalized away)');

  zone._collisionGrid[11][10] = 0;
}

// ===========================================================================
// S4: Facing dirty without movement (wall + facing change)
// ===========================================================================
function testS4_facingDirtyWithoutMovement() {
  console.log('\nS4: Facing dirty without movement — intent into wall, facing changes');
  const zone = testZone();

  const entity = makeEntity('p_s4', 'acct_s4', 5, 5);
  entity.facing = 's';
  const ws = mockWs();
  zone.addEntity(entity, ws);

  zone._collisionGrid[5][6] = 1;

  zone.applyInput('acct_s4', { seq: 1, move: { x: 1, y: 0 }, facing: 'e' });
  zone.tick();

  assert(entity.x === 5, 'x unchanged (wall)');
  assert(entity.y === 5, 'y unchanged');
  assert(entity.facing === 'e', 'facing updated to east');
  assert(zone.dirtyUpserts.has('p_s4'), 'entity dirty (facing change + denial)');

  const snap = zone.dirtyUpserts.get('p_s4');
  assert(snap.x === 5 && snap.y === 5, 'dirty snapshot has same x,y');
  assert(snap.facing === 'e', 'dirty snapshot has new facing');

  zone._collisionGrid[5][6] = 0;
}

// ===========================================================================
// C1: Collision-aware prediction denies locally
// ===========================================================================
function testC1_collisionAwarePrediction() {
  console.log('\nC1: Collision-aware prediction — blocked tile denied locally');

  // Simulate client-side prediction with collision grid.
  var collisionGrid = [[0, 0, 0], [0, 0, 1], [0, 0, 0]];
  var zoneBounds = { w: 3, h: 3 };
  var predTile = { x: 1, y: 1 };

  function blockedAt(x, y) {
    if (x < 0 || y < 0 || x >= zoneBounds.w || y >= zoneBounds.h) return true;
    return collisionGrid[y] && collisionGrid[y][x] === 1;
  }
  function clampTile(val, bound) {
    return Math.max(0, Math.min(bound - 1, val));
  }
  function applyPredMove(dx, dy) {
    if (dx !== 0 && dy !== 0) dy = 0;
    var nx = clampTile(predTile.x + dx, zoneBounds.w);
    var ny = clampTile(predTile.y + dy, zoneBounds.h);
    if (!blockedAt(nx, ny)) { predTile.x = nx; predTile.y = ny; }
  }

  applyPredMove(1, 0);
  assert(predTile.x === 1, 'pred did not move east (blocked at 2,1)');
  assert(predTile.y === 1, 'pred y unchanged');

  applyPredMove(-1, 0);
  assert(predTile.x === 0, 'pred moved west (0,1 is open)');
}

// ===========================================================================
// C2: Blind prediction moves then gets corrected
// ===========================================================================
function testC2_blindPredictionCorrection() {
  console.log('\nC2: Blind prediction (no collision grid) — moves, then server corrects');

  var zoneBounds = { w: 20, h: 20 };
  var predTile = { x: 5, y: 5 };
  var authTile = { x: 5, y: 5 };
  var pendingInputs = [];
  var lastAckSeq = 0;

  // No collision grid — blind mode, client predicts freely.
  function clampTile(v, b) { return Math.max(0, Math.min(b - 1, v)); }
  function replayPending() {
    predTile.x = authTile.x; predTile.y = authTile.y;
    for (var i = 0; i < pendingInputs.length; i++) {
      var inp = pendingInputs[i];
      predTile.x = clampTile(predTile.x + inp.dx, zoneBounds.w);
      predTile.y = clampTile(predTile.y + inp.dy, zoneBounds.h);
    }
  }

  // Client predicts east (seq 1) — blind, moves.
  pendingInputs.push({ seq: 1, dx: 1, dy: 0 });
  predTile.x = clampTile(predTile.x + 1, zoneBounds.w);
  assert(predTile.x === 6, 'blind pred moved east to 6');

  // Server denies: auth stays at (5,5), ack=1.
  authTile.x = 5; authTile.y = 5;
  lastAckSeq = 1;
  while (pendingInputs.length > 0 && pendingInputs[0].seq <= lastAckSeq) pendingInputs.shift();
  replayPending();

  assert(predTile.x === 5, 'after reconcile, pred corrected back to auth (5)');
}

// ===========================================================================
// C3: Replay with collision matches server
// ===========================================================================
function testC3_replayWithCollision() {
  console.log('\nC3: Replay with collision — pending [east into wall, east into wall, north open]');

  var collisionGrid = [
    [0, 0, 0, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0, 0, 0],
  ];
  var zoneBounds = { w: 5, h: 3 };
  var authTile = { x: 1, y: 1 };
  var predTile = { x: 0, y: 0 };
  var pendingInputs = [
    { seq: 1, dx: 1, dy: 0 },   // east into wall at (2,1)
    { seq: 2, dx: 1, dy: 0 },   // east into wall again
    { seq: 3, dx: 0, dy: -1 },  // north to (1,0) — open
  ];

  function blockedAt(x, y) {
    if (x < 0 || y < 0 || x >= zoneBounds.w || y >= zoneBounds.h) return true;
    return collisionGrid[y] && collisionGrid[y][x] === 1;
  }
  function clampTile(v, b) { return Math.max(0, Math.min(b - 1, v)); }

  predTile.x = authTile.x;
  predTile.y = authTile.y;
  for (var i = 0; i < pendingInputs.length; i++) {
    var inp = pendingInputs[i];
    var dx = inp.dx, dy = inp.dy;
    if (dx !== 0 && dy !== 0) dy = 0;
    var nx = clampTile(predTile.x + dx, zoneBounds.w);
    var ny = clampTile(predTile.y + dy, zoneBounds.h);
    if (!blockedAt(nx, ny)) { predTile.x = nx; predTile.y = ny; }
  }

  assert(predTile.x === 1, 'pred x=1 (two east moves blocked by wall at 2,1)');
  assert(predTile.y === 0, 'pred y=0 (north move succeeded)');
}

// ===========================================================================
// C4: Rendering stable on repeated denials (no jitter loop)
// ===========================================================================
function testC4_noJitterOnDenials() {
  console.log('\nC4: Rendering stable on repeated denials — no oscillation');

  var SNAP = 64;
  var SMOOTH = 0.35;
  var TILE = 32;
  var predTile = { x: 5, y: 5 };
  var renderPx = { x: 5 * TILE, y: 5 * TILE };

  function interpolateToward(rpx, tx, ty) {
    var dx = tx - rpx.x, dy = ty - rpx.y;
    var dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist >= SNAP) { rpx.x = tx; rpx.y = ty; }
    else if (dist > 0.5) { rpx.x += dx * SMOOTH; rpx.y += dy * SMOOTH; }
  }

  // Simulate 10 frames where predTile doesn't change (repeated denials).
  for (var f = 0; f < 10; f++) {
    interpolateToward(renderPx, predTile.x * TILE, predTile.y * TILE);
  }

  assert(renderPx.x === 5 * TILE, 'renderPx.x stable at target');
  assert(renderPx.y === 5 * TILE, 'renderPx.y stable at target');

  // Now simulate one denial cycle: client tries to move, pred stays, render stays.
  // (predTile didn't change because blocked)
  for (var f2 = 0; f2 < 5; f2++) {
    interpolateToward(renderPx, predTile.x * TILE, predTile.y * TILE);
  }
  assert(renderPx.x === 5 * TILE, 'renderPx.x still stable after denial cycle');
  assert(renderPx.y === 5 * TILE, 'renderPx.y still stable after denial cycle');
}

// ===========================================================================
// Bonus: Bitset RLE encode/decode roundtrip
// ===========================================================================
function testBonus_rleRoundtrip() {
  console.log('\nBonus: Bitset RLE encode/decode roundtrip');
  const grid = [
    new Uint8Array([0, 0, 1, 1, 0]),
    new Uint8Array([1, 1, 1, 0, 0]),
    new Uint8Array([0, 0, 0, 0, 1]),
  ];
  const w = 5, h = 3;
  const encoded = encodeBitsetRle(grid, w, h);
  assert(typeof encoded === 'string' && encoded.length > 0, 'encoded is non-empty base64');

  const decoded = decodeBitsetRle(encoded, w, h);
  let match = true;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (decoded[y][x] !== grid[y][x]) { match = false; break; }
    }
    if (!match) break;
  }
  assert(match, 'decoded grid matches original');

  const hash = hashGrid(encoded);
  assert(hash.startsWith('sha256:'), 'hash format is sha256:...');
  assert(hash.length > 10, 'hash is non-trivial');
}

// ===========================================================================
// Run all
// ===========================================================================
console.log('=== World Collision Authority — Spec Tests ===');
testS1_denyBlockedTile();
testS2_allowOpenTile();
testS3_diagonalNormalization();
testS4_facingDirtyWithoutMovement();
testC1_collisionAwarePrediction();
testC2_blindPredictionCorrection();
testC3_replayWithCollision();
testC4_noJitterOnDenials();
testBonus_rleRoundtrip();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
