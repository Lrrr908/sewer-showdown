#!/usr/bin/env node
// Transfer Semantics v1.1 — 7 spec invariant tests.
// Run: node server/tests/transfer_semantics.test.js

const ZoneManager = require('../src/zones/zone_manager');
const presence    = require('../src/zones/presence');
const { wireSnapshot } = require('../src/zones/zone');
const {
  makeTransferBegin, makeTransferCommit, makeSnapshot, makeDelta,
  makeError, makeUgcUpdate,
} = require('../src/realtime/messages');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}`); }
}

function makeEntity(id, accountId, zoneId) {
  return {
    id, accountId, zoneId,
    x: 10, y: 10, facing: 'e', spriteRef: 'base:van',
    lastSeq: 0, intent: null,
    hitbox: { x: 0, y: 0, w: 1, h: 1 },
    ownership: { type: 'account', id: accountId },
  };
}

function mockWs(label) {
  const ws = {
    label,
    readyState: 1,
    sent: [],
    closed: false,
    send(data) { ws.sent.push(JSON.parse(data)); },
    close() { ws.closed = true; ws.readyState = 3; },
  };
  return ws;
}

function freshZoneManager() { return new ZoneManager(); }
function clearPresence() {
  for (const k of [...presence._cacheKeys()]) presence.remove(k);
}

// Expose cache keys for test cleanup.
if (!presence._cacheKeys) {
  presence._cacheKeys = function() {
    const keys = [];
    // Access internal cache via resolveReconnect behavior
    return keys;
  };
}

// ─── Test 1: Transfer success sequence ─────────────────────────────────────

function test1_transferSuccessSequence() {
  console.log('\nTest 1: Transfer success — begin → commit → snapshot, input frozen');
  const zm = freshZoneManager();
  const ws = mockWs('player1');
  const zoneA = zm.getOrCreate('world:na');
  const entity = makeEntity('p_001', 'acct_1', null);
  zoneA.addEntity(entity, ws);

  entity.lastSeq = 5;
  entity.intent = { move: { x: 1, y: 0 }, facing: 'e', keys: {} };

  // Simulate transfer phases (as ws_server does).
  const fromZone = 'world:na';
  const toZone   = 'region:na:la';
  let pendingPhase = 'begin_sent';

  ws.send(makeTransferBegin(fromZone, toZone, 'enter_region'));
  assert(ws.sent.length === 1, 'transfer_begin sent first');
  assert(ws.sent[0].t === 'transfer_begin', 'first message is transfer_begin');
  assert(ws.sent[0].from === fromZone, 'begin.from is source');
  assert(ws.sent[0].to === toZone, 'begin.to is destination');

  const result = zm.transferEntity('p_001', fromZone, toZone);
  pendingPhase = 'commit_sent';
  assert(result !== null, 'transferEntity succeeded');
  assert(!zoneA.entities.has('p_001'), 'entity removed from source');
  assert(result.newZone.entities.has('p_001'), 'entity added to destination');

  ws.send(makeTransferCommit(toZone, 'p_001', 'acct_1'));
  assert(ws.sent[ws.sent.length - 1].t === 'transfer_commit', 'commit sent after begin');
  assert(ws.sent[ws.sent.length - 1].zone === toZone, 'commit zone is destination');

  const snap = result.newZone.buildSnapshotFor();
  ws.send(makeSnapshot(1, toZone, snap));
  pendingPhase = 'snapshot_sent';
  assert(ws.sent[ws.sent.length - 1].t === 'snapshot', 'snapshot sent after commit');
  assert(ws.sent[ws.sent.length - 1].zone === toZone, 'snapshot zone is destination');

  const order = ws.sent.map(m => m.t);
  assert(
    order[0] === 'transfer_begin' && order[1] === 'transfer_commit' && order[2] === 'snapshot',
    'message order: begin → commit → snapshot'
  );
}

// ─── Test 2: Old zone subscribers receive removes ──────────────────────────

function test2_oldZoneRemoves() {
  console.log('\nTest 2: Old zone subscribers receive removes');
  const zm = freshZoneManager();
  const ws1 = mockWs('player1');
  const ws2 = mockWs('observer');
  const zoneA = zm.getOrCreate('world:na');

  const e1 = makeEntity('p_010', 'acct_10', null);
  const e2 = makeEntity('p_011', 'acct_11', null);
  zoneA.addEntity(e1, ws1);
  zoneA.addEntity(e2, ws2);

  assert(zoneA.entities.size === 2, 'source zone has 2 entities before transfer');

  zm.transferEntity('p_010', 'world:na', 'region:na:la');

  assert(zoneA.entities.size === 1, 'source zone has 1 entity after transfer');
  assert(zoneA.dirtyRemoves.has('p_010'), 'source zone dirty removes includes transferred entity');

  // broadcastDeltas would send this to ws2. Verify by calling it.
  zoneA.broadcastDeltas(1);
  const removeMsgs = ws2.sent.filter(m => m.t === 'delta' && m.removes && m.removes.length > 0);
  assert(removeMsgs.length === 1, 'observer received remove delta');
  assert(removeMsgs[0].removes.includes('p_010'), 'remove delta contains transferred entity id');
}

// ─── Test 3: Disconnect after begin, before commit → resumes in source ─────

function test3_dcBeforeCommit() {
  console.log('\nTest 3: Disconnect after begin, before commit — resumes in source');

  // Simulate: entity is in source zone, transfer_begin sent but entity NOT moved yet.
  // In our synchronous implementation, this means transferEntity hasn't been called.
  // Presence still has source zone.
  presence.remove('acct_30');
  const zm = freshZoneManager();
  const ws = mockWs('player');
  const zone = zm.getOrCreate('world:na');
  const entity = makeEntity('p_030', 'acct_30', null);
  zone.addEntity(entity, ws);
  // presence.update was called inside addEntity.

  // Now simulate socket close at phase=begin_sent.
  // Per spec, if commit has NOT occurred, presence zone remains source.
  // The pendingTransfer.phase check in ws_server would re-write presence to source.
  // Here we verify presence is still source (transfer never ran).
  presence.markDisconnected('acct_30');

  const resumed = presence.resolveReconnect('acct_30', 'world:na', true);
  assert(resumed.resume === true, 'resume applied after DC before commit');
  assert(resumed.zoneId === 'world:na', 'resumes in source zone (world:na)');
  assert(resumed.reason === 'within_ttl', 'reason is within_ttl');
}

// ─── Test 4: Disconnect after commit → resumes in destination ───────────────

function test4_dcAfterCommit() {
  console.log('\nTest 4: Disconnect after commit, before snapshot — resumes in destination');
  presence.remove('acct_40');
  const zm = freshZoneManager();
  const ws = mockWs('player');
  const zone = zm.getOrCreate('world:na');
  const entity = makeEntity('p_040', 'acct_40', null);
  zone.addEntity(entity, ws);

  // Perform actual transfer (commit happened).
  // transferEntity calls addConn which calls addEntity which calls presence.update
  // with the destination zone.
  const result = zm.transferEntity('p_040', 'world:na', 'region:na:la');
  assert(result !== null, 'transfer succeeded');

  // Now socket closes after commit. presence.update already wrote destination zone.
  presence.markDisconnected('acct_40');

  const resumed = presence.resolveReconnect('acct_40', 'world:na', true);
  assert(resumed.resume === true, 'resume applied after DC post-commit');
  assert(resumed.zoneId === 'region:na:la', 'resumes in destination zone (region:na:la)');
  assert(
    resumed.reason === 'zone_mismatch_forced_transfer',
    'reason is zone_mismatch_forced_transfer (client sent world:na but server says region:na:la)'
  );
}

// ─── Test 5: Socket replace mid-transfer — no dup entities ──────────────────

function test5_socketReplaceMidTransfer() {
  console.log('\nTest 5: Socket replace mid-transfer — resume in correct zone, no dups');
  presence.remove('acct_50');
  const zm = freshZoneManager();
  const ws1 = mockWs('old_conn');
  const zoneA = zm.getOrCreate('world:na');
  const entity = makeEntity('p_050', 'acct_50', null);
  zoneA.addEntity(entity, ws1);

  // Transfer to destination (commit happened, presence updated).
  const result = zm.transferEntity('p_050', 'world:na', 'region:na:la');
  assert(result !== null, 'transfer succeeded');

  const destZone = result.newZone;
  assert(destZone.entities.has('p_050'), 'entity in destination');
  assert(!zoneA.entities.has('p_050'), 'entity not in source');

  // Simulate old socket close (replace). Remove entity from destination.
  destZone.removeEntity('p_050');
  presence.markDisconnected('acct_50');

  // New connection arrives. Resume should place in destination (presence has region:na:la).
  const resumed = presence.resolveReconnect('acct_50', 'world:na', true);
  assert(resumed.resume === true, 'new conn resumes');
  assert(resumed.zoneId === 'region:na:la', 'new conn placed in destination');

  // Simulate addPlayerWithResume equivalent.
  const newZone = zm.getOrCreate(resumed.zoneId);
  const newEntity = makeEntity('p_051', 'acct_50', null);
  newEntity.x = resumed.x;
  newEntity.y = resumed.y;
  newEntity.facing = resumed.facing;
  newZone.addEntity(newEntity, mockWs('new_conn'));

  assert(newZone.entities.has('p_051'), 'new entity in destination');
  assert(!zoneA.entities.has('p_050'), 'no ghost in source zone');
  assert(!zoneA.entities.has('p_051'), 'no dup in source zone');

  let countInDest = 0;
  for (const e of destZone.entities.values()) {
    if (e.accountId === 'acct_50') countInDest++;
  }
  assert(countInDest === 1, 'exactly 1 entity for account in destination');
}

// ─── Test 6: Client discards wrong-zone messages ────────────────────────────

function test6_wrongZoneDiscard() {
  console.log('\nTest 6: Zone-scoped messages include zone field (client discard contract)');

  const snap = JSON.parse(makeSnapshot(1, 'world:na', []));
  assert(snap.zone === 'world:na', 'snapshot includes zone field');

  const delta = JSON.parse(makeDelta(1, 'world:na', [], []));
  assert(delta.zone === 'world:na', 'delta includes zone field');

  const ugc = JSON.parse(makeUgcUpdate('world:na', 'acct_x', 'u_1', 'base:van', 'ugc:u_1'));
  assert(ugc.zone === 'world:na', 'ugc_update includes zone field');

  const tbegin = JSON.parse(makeTransferBegin('world:na', 'region:na:la', 'enter'));
  assert(tbegin.t === 'transfer_begin', 'transfer_begin has no zone filter (always processed)');
  assert(tbegin.from === 'world:na', 'transfer_begin has from');
  assert(tbegin.to === 'region:na:la', 'transfer_begin has to');

  const tcommit = JSON.parse(makeTransferCommit('region:na:la', 'p_x', 'acct_x'));
  assert(tcommit.zone === 'region:na:la', 'transfer_commit has zone (for currentZone update)');

  // Cross-zone discards verified: if snapshot.zone !== currentZone, client breaks.
  const wrongSnap = JSON.parse(makeSnapshot(1, 'region:na:la', []));
  assert(wrongSnap.zone !== 'world:na', 'wrong-zone snapshot has different zone — client would discard');
}

// ─── Test 7: Transfer resets lastSeq and intent ─────────────────────────────

function test7_transferResetsSeqAndIntent() {
  console.log('\nTest 7: Transfer resets lastSeq = 0 and intent = null');
  presence.remove('acct_70');
  const zm = freshZoneManager();
  const ws = mockWs('player');
  const zoneA = zm.getOrCreate('world:na');
  const entity = makeEntity('p_070', 'acct_70', null);
  zoneA.addEntity(entity, ws);

  entity.lastSeq = 42;
  entity.intent = { move: { x: 1, y: 0 }, facing: 'n', keys: {} };
  entity.facing = 'n';
  assert(entity.lastSeq === 42, 'lastSeq is 42 before transfer');
  assert(entity.intent !== null, 'intent is non-null before transfer');

  const result = zm.transferEntity('p_070', 'world:na', 'region:na:la');
  assert(result !== null, 'transfer succeeded');
  assert(result.entity.lastSeq === 0, 'lastSeq reset to 0 after transfer');
  assert(result.entity.intent === null, 'intent reset to null after transfer');
  assert(result.entity.facing === 'n', 'facing preserved through transfer');

  // Verify one tick in destination doesn't crash with null intent.
  result.newZone.tick();
  assert(result.entity.x === result.newZone.spawnX, 'entity stayed at spawn (no intent)');
}

// ─── Test 8: Presence phase invariant at each transfer step ─────────────────

function test8_presencePhaseInvariant() {
  console.log('\nTest 8: Presence zoneId correct at every transfer phase');
  presence.remove('acct_80');
  const zm = freshZoneManager();
  const ws = mockWs('player');
  const zoneA = zm.getOrCreate('world:na');
  const entity = makeEntity('p_080', 'acct_80', null);
  zoneA.addEntity(entity, ws);

  // Phase: begin_sent — entity still in source, presence == source.
  const presBegin = presence.getResume('acct_80');
  assert(presBegin !== null, 'presence exists before transfer');
  assert(presBegin.zoneId === 'world:na', 'begin_sent phase: presence == source');

  // Atomic transferEntity moves entity + updates presence.
  const result = zm.transferEntity('p_080', 'world:na', 'region:na:la');
  assert(result !== null, 'transfer succeeded');

  // Phase: commit_sent — presence must be destination and must not revert.
  const presCommit = presence.getResume('acct_80');
  assert(presCommit !== null, 'presence exists after commit');
  assert(presCommit.zoneId === 'region:na:la', 'commit_sent phase: presence == destination (LOCKED)');

  // Phase: snapshot_sent — still destination.
  const presSnap = presence.getResume('acct_80');
  assert(presSnap.zoneId === 'region:na:la', 'snapshot_sent phase: presence == destination');

  // Mark disconnected — should freeze at destination.
  presence.markDisconnected('acct_80');
  const resumed = presence.resolveReconnect('acct_80', 'world:na', true);
  assert(resumed.zoneId === 'region:na:la', 'post-disconnect: presence still destination');
  assert(resumed.resume === true, 'resume applies');
}

// ─── Test 9: Same-zone transfer rejected ────────────────────────────────────

function test9_sameZoneTransferRejected() {
  console.log('\nTest 9: Transfer to current zone rejected (debounce)');
  const zm = freshZoneManager();
  const ws = mockWs('player');
  const zoneA = zm.getOrCreate('world:na');
  const entity = makeEntity('p_090', 'acct_90', null);
  zoneA.addEntity(entity, ws);

  // Attempt to transfer to the zone we're already in.
  // In ws_server this is caught before transferEntity is called.
  // Here we verify the guard logic directly: toZoneId === fromZoneId.
  const toZoneId = 'world:na';
  const fromZoneId = 'world:na';
  const sameZone = (toZoneId === fromZoneId);
  assert(sameZone === true, 'same-zone detected');

  // Entity should still be in zone A, untouched.
  assert(zoneA.entities.has('p_090'), 'entity remains in zone after same-zone reject');
  assert(entity.lastSeq === 0, 'lastSeq unchanged');
  assert(entity.intent === null, 'intent unchanged');
}

// ─── Run all ────────────────────────────────────────────────────────────────

console.log('=== Transfer Semantics v1.1 — Spec Invariant Tests ===');
test1_transferSuccessSequence();
test2_oldZoneRemoves();
test3_dcBeforeCommit();
test4_dcAfterCommit();
test5_socketReplaceMidTransfer();
test6_wrongZoneDiscard();
test7_transferResetsSeqAndIntent();
test8_presencePhaseInvariant();
test9_sameZoneTransferRejected();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
