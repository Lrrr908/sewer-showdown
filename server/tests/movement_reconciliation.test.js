#!/usr/bin/env node
// Movement Reconciliation + Anti-Jitter — Spec Invariant Tests.
// Run: node server/tests/movement_reconciliation.test.js

const ZoneManager = require('../src/zones/zone_manager');
const { wireSnapshot } = require('../src/zones/zone');
const { makeSnapshot, makeDelta } = require('../src/realtime/messages');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}`); }
}

function makeEntity(id, accountId) {
  return {
    id, accountId, zoneId: null,
    x: 10, y: 10, facing: 's', spriteRef: 'base:van',
    lastSeq: 0, intent: null,
    hitbox: { x: 0, y: 0, w: 1, h: 1 },
    ownership: { type: 'account', id: accountId },
  };
}

function mockWs(label) {
  const ws = {
    label, readyState: 1, sent: [],
    send(data) { ws.sent.push(typeof data === 'string' ? JSON.parse(data) : data); },
    close() { ws.readyState = 3; },
  };
  return ws;
}

// ===========================================================================
// SECTION A: Server ack tests
// ===========================================================================

function testA1_ackEqualsLastSeq() {
  console.log('\nTest A1: ack.seq equals entity.lastSeq in snapshot');
  const snap = JSON.parse(makeSnapshot(1, 'world:na', [], 10));
  assert(snap.ack !== undefined, 'snapshot has ack field');
  assert(snap.ack.seq === 10, 'ack.seq equals passed lastSeq');

  const snap0 = JSON.parse(makeSnapshot(1, 'world:na', []));
  assert(snap0.ack.seq === 0, 'ack.seq defaults to 0 when omitted');
}

function testA2_ackInDelta() {
  console.log('\nTest A2: ack.seq in delta');
  const delta = JSON.parse(makeDelta(1, 'world:na', [], [], 42));
  assert(delta.ack !== undefined, 'delta has ack field');
  assert(delta.ack.seq === 42, 'ack.seq equals passed lastSeq');

  const delta0 = JSON.parse(makeDelta(1, 'world:na', [], []));
  assert(delta0.ack.seq === 0, 'delta ack.seq defaults to 0');
}

function testA3_ackMonotonicViaBroadcast() {
  console.log('\nTest A3: ack monotonic — lastSeq advances, never decreases in outgoing deltas');
  const zm = new ZoneManager();
  const ws1 = mockWs('player');
  const ws2 = mockWs('observer');
  const zone = zm.getOrCreate('world:na');

  const e1 = makeEntity('p_a3_1', 'acct_a3_1');
  const e2 = makeEntity('p_a3_2', 'acct_a3_2');
  zone.addEntity(e1, ws1);
  zone.addEntity(e2, ws2);

  zone.applyInput('acct_a3_1', { seq: 1, move: { x: 1, y: 0 }, facing: 'e' });
  zone.tick();
  zone.broadcastDeltas(1);

  zone.applyInput('acct_a3_1', { seq: 2, move: { x: 1, y: 0 }, facing: 'e' });
  zone.tick();
  zone.broadcastDeltas(2);

  zone.applyInput('acct_a3_1', { seq: 3, move: { x: 1, y: 0 }, facing: 'e' });
  zone.tick();
  zone.broadcastDeltas(3);

  // ws1 receives its own deltas (in own AOI). Check ack monotonic.
  const acks = ws1.sent.filter(m => m.t === 'delta').map(m => m.ack.seq);
  assert(acks.length >= 3, 'player received at least 3 deltas');
  let mono = true;
  for (let i = 1; i < acks.length; i++) {
    if (acks[i] < acks[i - 1]) mono = false;
  }
  assert(mono, 'ack.seq is monotonic non-decreasing: [' + acks.join(',') + ']');
  assert(acks[acks.length - 1] === 3, 'final ack.seq reaches 3');
}

function testA4_boundsInSnapshot() {
  console.log('\nTest A4: bounds included in snapshot when provided');
  const snap = JSON.parse(makeSnapshot(1, 'world:na', [], 0, { w: 160, h: 220 }));
  assert(snap.bounds !== undefined, 'snapshot has bounds');
  assert(snap.bounds.w === 160, 'bounds.w = 160');
  assert(snap.bounds.h === 220, 'bounds.h = 220');

  const snapNoBounds = JSON.parse(makeSnapshot(1, 'world:na', [], 0));
  assert(snapNoBounds.bounds === undefined, 'no bounds when not provided');
}

function testA5_facingChangeBroadcast() {
  console.log('\nTest A5: facing-only change produces dirty upsert');
  const zm = new ZoneManager();
  const ws = mockWs('player');
  const zone = zm.getOrCreate('world:na');
  const entity = makeEntity('p_a5', 'acct_a5');
  entity.facing = 's';
  zone.addEntity(entity, ws);

  zone.applyInput('acct_a5', { seq: 1, move: { x: 0, y: 0 }, facing: 'n' });
  zone.tick();

  assert(entity.facing === 'n', 'facing updated to n');
  assert(zone.dirtyUpserts.has('p_a5'), 'entity is dirty on facing-only change');
}

// ===========================================================================
// SECTION B: Client prediction tests (pure logic, no DOM/WS)
// ===========================================================================

// Minimal client prediction harness mirroring multiplayer.js internals.
function createPredictionHarness(boundsW, boundsH) {
  const h = {
    pendingInputs: [],
    lastAckSeq: 0,
    predTile: { x: 0, y: 0 },
    authTile: { x: 0, y: 0 },
    zoneBounds: { w: boundsW || 100, h: boundsH || 100 },
  };

  h.clampTile = function (val, bound) {
    if (val < 0) return 0;
    if (val >= bound) return bound - 1;
    return val;
  };

  h.processAck = function (ackSeq) {
    if (typeof ackSeq !== 'number') return;
    if (ackSeq <= h.lastAckSeq) return;
    h.lastAckSeq = ackSeq;
    while (h.pendingInputs.length > 0 && h.pendingInputs[0].seq <= h.lastAckSeq) {
      h.pendingInputs.shift();
    }
  };

  h.replayPending = function () {
    h.predTile.x = h.authTile.x;
    h.predTile.y = h.authTile.y;
    for (let i = 0; i < h.pendingInputs.length; i++) {
      const inp = h.pendingInputs[i];
      h.predTile.x = h.clampTile(h.predTile.x + inp.dx, h.zoneBounds.w);
      h.predTile.y = h.clampTile(h.predTile.y + inp.dy, h.zoneBounds.h);
    }
  };

  h.reconcile = function (authX, authY, ackSeq) {
    h.authTile.x = authX;
    h.authTile.y = authY;
    h.processAck(ackSeq);
    h.replayPending();
  };

  h.applyInput = function (seq, dx, dy) {
    h.pendingInputs.push({ seq, dx, dy });
    h.predTile.x = h.clampTile(h.predTile.x + dx, h.zoneBounds.w);
    h.predTile.y = h.clampTile(h.predTile.y + dy, h.zoneBounds.h);
  };

  return h;
}

function testB1_replayDeterminism() {
  console.log('\nTest B1: Replay determinism — auth (10,10), pending [11 east, 12 east], pred=(12,10)');
  const h = createPredictionHarness();
  h.authTile = { x: 10, y: 10 };
  h.predTile = { x: 10, y: 10 };
  h.applyInput(11, 1, 0);
  h.applyInput(12, 1, 0);
  assert(h.predTile.x === 12 && h.predTile.y === 10, 'predicted (12,10) after 2 east inputs');

  h.reconcile(10, 10, 10);
  assert(h.predTile.x === 12 && h.predTile.y === 10, 'after reconcile with ack=10, pred still (12,10)');
}

function testB2_dropAckedInputs() {
  console.log('\nTest B2: Drop acked inputs — pending [11 east, 12 east, 13 north], ack=12');
  const h = createPredictionHarness();
  h.authTile = { x: 10, y: 10 };
  h.predTile = { x: 10, y: 10 };
  h.applyInput(11, 1, 0);
  h.applyInput(12, 1, 0);
  h.applyInput(13, 0, -1);

  h.processAck(12);
  assert(h.pendingInputs.length === 1, 'only 1 pending input remains after ack=12');
  assert(h.pendingInputs[0].seq === 13, 'remaining input is seq 13');
}

function testB3_lateServerCorrection() {
  console.log('\nTest B3: Late server correction — pred (12,10), server says auth (11,10) ack=11');
  const h = createPredictionHarness();
  h.authTile = { x: 10, y: 10 };
  h.predTile = { x: 10, y: 10 };
  h.applyInput(11, 1, 0);
  h.applyInput(12, 1, 0);
  assert(h.predTile.x === 12, 'predicted x=12 before correction');

  h.reconcile(11, 10, 11);
  assert(h.pendingInputs.length === 1, '1 pending after ack=11');
  assert(h.predTile.x === 12, 'pred x=12 after replay (11 + east = 12)');
  assert(h.predTile.y === 10, 'pred y=10');
}

function testB4_staleAckIgnored() {
  console.log('\nTest B4: Stale ack ignored — lastAckSeq=20, receive ack=19');
  const h = createPredictionHarness();
  h.lastAckSeq = 20;
  h.pendingInputs = [{ seq: 21, dx: 1, dy: 0 }];

  h.processAck(19);
  assert(h.lastAckSeq === 20, 'lastAckSeq stays 20');
  assert(h.pendingInputs.length === 1, 'pending not pruned by stale ack');
}

function testB5_boundsClamp() {
  console.log('\nTest B5: Prediction clamps to bounds');
  const h = createPredictionHarness(20, 20);
  h.authTile = { x: 19, y: 0 };
  h.predTile = { x: 19, y: 0 };
  h.applyInput(1, 1, 0);
  assert(h.predTile.x === 19, 'clamped at east bound (19)');

  h.predTile = { x: 0, y: 0 };
  h.applyInput(2, -1, 0);
  assert(h.predTile.x === 0, 'clamped at west bound (0)');
}

// ===========================================================================
// SECTION C: Rendering tests
// ===========================================================================

function interpolateToward(renderPx, targetX, targetY, snapDist, smoothFactor) {
  const dx = targetX - renderPx.x;
  const dy = targetY - renderPx.y;
  const dist = Math.max(Math.abs(dx), Math.abs(dy));
  if (dist >= snapDist) {
    renderPx.x = targetX;
    renderPx.y = targetY;
  } else if (dist > 0.5) {
    renderPx.x += dx * smoothFactor;
    renderPx.y += dy * smoothFactor;
  }
}

function testC1_snapThreshold() {
  console.log('\nTest C1: Snap when dist >= SNAP_DIST_PX (64)');
  const SNAP = 64;
  const SMOOTH = 0.35;
  const rpx = { x: 0, y: 0 };
  interpolateToward(rpx, 96, 0, SNAP, SMOOTH);
  assert(rpx.x === 96, 'snapped x to 96 (dist 96 >= 64)');
  assert(rpx.y === 0, 'y unchanged');
}

function testC2_smoothBelowThreshold() {
  console.log('\nTest C2: Smooth when dist < SNAP_DIST_PX');
  const SNAP = 64;
  const SMOOTH = 0.35;
  const rpx = { x: 0, y: 0 };
  interpolateToward(rpx, 32, 0, SNAP, SMOOTH);
  const expected = 32 * 0.35;
  assert(Math.abs(rpx.x - expected) < 0.01, 'smooth x = ' + rpx.x.toFixed(2) + ' ≈ ' + expected.toFixed(2));
}

function testC3_smoothConverges() {
  console.log('\nTest C3: Smooth converges to target over multiple frames');
  const SNAP = 64;
  const SMOOTH = 0.35;
  const rpx = { x: 0, y: 0 };
  for (let i = 0; i < 30; i++) {
    interpolateToward(rpx, 32, 0, SNAP, SMOOTH);
  }
  assert(Math.abs(rpx.x - 32) < 0.5, 'converged to target after 30 frames: x=' + rpx.x.toFixed(2));
}

function testC4_noMovementWhenAtTarget() {
  console.log('\nTest C4: No movement when already at target');
  const rpx = { x: 32, y: 64 };
  interpolateToward(rpx, 32, 64, 64, 0.35);
  assert(rpx.x === 32 && rpx.y === 64, 'stays at target');
}

// ===========================================================================
// Run all
// ===========================================================================

console.log('=== Movement Reconciliation + Anti-Jitter — Spec Tests ===');
testA1_ackEqualsLastSeq();
testA2_ackInDelta();
testA3_ackMonotonicViaBroadcast();
testA4_boundsInSnapshot();
testA5_facingChangeBroadcast();
testB1_replayDeterminism();
testB2_dropAckedInputs();
testB3_lateServerCorrection();
testB4_staleAckIgnored();
testB5_boundsClamp();
testC1_snapThreshold();
testC2_smoothBelowThreshold();
testC3_smoothConverges();
testC4_noMovementWhenAtTarget();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
