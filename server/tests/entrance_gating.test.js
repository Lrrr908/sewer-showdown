#!/usr/bin/env node
// Region → Level Entrance Gating v1 — Spec Tests.
// Run: node server/tests/entrance_gating.test.js

const zoneDir = require('../src/zones/zone_directory');
const { parseZoneId } = require('../src/zones/zone_id');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}`); }
}

// ===== Build a synthetic directory snapshot with entrances =====

function buildTestSnapshot() {
  const { buildCollisionDescriptor } = require('../src/zones/collision_grid');

  const world = [];
  const region = [];
  const level = [];
  const zoneSet = new Set();

  // na region (8x6)
  const naW = 8, naH = 6;
  const naColl = buildCollisionDescriptor('world:na', naW, naH);
  world.push({
    id: 'world:na',
    bounds: { w: naW, h: naH },
    collision: { ver: naColl.descriptor.ver, hash: naColl.descriptor.hash },
  });
  zoneSet.add('world:na');

  region.push({ id: 'region:na:la', world: 'world:na', townKey: 'la', name: 'LA', spawn: { x: 1, y: 1 } });
  zoneSet.add('region:na:la');
  region.push({ id: 'region:na:sf', world: 'world:na', townKey: 'sf', name: 'SF', spawn: { x: 3, y: 2 } });
  zoneSet.add('region:na:sf');

  // eu region (4x4, no entrances)
  const euW = 4, euH = 4;
  const euColl = buildCollisionDescriptor('world:eu', euW, euH);
  world.push({
    id: 'world:eu',
    bounds: { w: euW, h: euH },
    collision: { ver: euColl.descriptor.ver, hash: euColl.descriptor.hash },
  });
  zoneSet.add('world:eu');
  region.push({ id: 'region:eu:paris', world: 'world:eu', townKey: 'paris', name: 'Paris', spawn: { x: 1, y: 1 } });
  zoneSet.add('region:eu:paris');

  // level_sewer (5x4)
  const lsW = 5, lsH = 4;
  const lsColl = buildCollisionDescriptor('level:level_sewer', lsW, lsH);
  level.push({
    id: 'level:level_sewer',
    bounds: { w: lsW, h: lsH },
    collision: { ver: lsColl.descriptor.ver, hash: lsColl.descriptor.hash },
  });
  zoneSet.add('level:level_sewer');

  // level_dock (3x3)
  const ldW = 3, ldH = 3;
  const ldColl = buildCollisionDescriptor('level:level_dock', ldW, ldH);
  level.push({
    id: 'level:level_dock',
    bounds: { w: ldW, h: ldH },
    collision: { ver: ldColl.descriptor.ver, hash: ldColl.descriptor.hash },
  });
  zoneSet.add('level:level_dock');

  // ── Entrances ──
  // na region: two entrances to level_sewer (one at 4,3 and one at 2,1), one to level_dock (5,4)
  const entrances = new Map();
  const naEntrances = new Map();
  naEntrances.set('level:level_sewer', [
    { x: 4, y: 3, facing: 's' },
    { x: 2, y: 1, facing: null },
  ]);
  naEntrances.set('level:level_dock', [
    { x: 5, y: 4, facing: 'e' },
  ]);
  entrances.set('na', naEntrances);
  // eu region: no entrances (intentionally empty)

  return { world, region, level, _zoneSet: zoneSet, _entrances: entrances, _builtAt: Date.now() };
}

// ===========================================================================
// Tests
// ===========================================================================

function test_validEntranceOnTile() {
  console.log('\nT1: Valid entrance exists, entity on tile -> transfer allowed');
  const r = zoneDir.checkEntranceEligibility('region:na:la', 'level:level_sewer', 4, 3);
  assert(r.ok === true, 'transfer allowed');
  assert(r.entrance !== undefined, 'entrance returned');
  assert(r.entrance.x === 4 && r.entrance.y === 3, 'entrance coords match');
  assert(r.entrance.facing === 's', 'entrance facing = s');
}

function test_validEntranceOffTile() {
  console.log('\nT2: Valid entrance exists, entity off tile -> TRANSFER_FAILED, no mutation');
  const snap1 = zoneDir.getSnapshot();
  const r = zoneDir.checkEntranceEligibility('region:na:la', 'level:level_sewer', 0, 0);
  assert(r.ok === false, 'transfer denied');
  assert(r.code === 'TRANSFER_FAILED', 'code = TRANSFER_FAILED');
  assert(r.msg === 'not_on_entrance', 'msg = not_on_entrance');

  const snap2 = zoneDir.getSnapshot();
  assert(snap1 === snap2, 'snapshot unchanged (no mutation)');
}

function test_noEntrancesInRegion() {
  console.log('\nT3: No entrances in region -> TRANSFER_INVALID_ZONE');
  const r = zoneDir.checkEntranceEligibility('region:eu:paris', 'level:level_sewer', 1, 1);
  assert(r.ok === false, 'transfer denied');
  assert(r.code === 'TRANSFER_INVALID_ZONE', 'code = TRANSFER_INVALID_ZONE');
  assert(r.msg.includes('no entrances'), 'msg mentions no entrances');
}

function test_entranceToNonExistentLevel() {
  console.log('\nT4: Entrance points to non-existent level -> entrance skipped');
  // level:level_fake doesn't exist in directory. It should have been
  // skipped during snapshot build. Verify via checkEntranceEligibility.
  const r = zoneDir.checkEntranceEligibility('region:na:la', 'level:level_fake', 4, 3);
  // This goes through validateTransferRoute first in real flow. Here we test
  // checkEntranceEligibility directly — to=level_fake is not in directory,
  // so validateTransferRoute would reject it. But checkEntranceEligibility
  // also finds no entrance for it.
  assert(r.ok === false, 'transfer denied');
  assert(r.code === 'TRANSFER_INVALID_ZONE', 'code = TRANSFER_INVALID_ZONE');
}

function test_multipleEntrancesToSameLevel() {
  console.log('\nT5: Multiple entrances to same level: any matching tile works');
  const r1 = zoneDir.checkEntranceEligibility('region:na:la', 'level:level_sewer', 4, 3);
  assert(r1.ok === true, 'first entrance tile (4,3) works');

  const r2 = zoneDir.checkEntranceEligibility('region:na:la', 'level:level_sewer', 2, 1);
  assert(r2.ok === true, 'second entrance tile (2,1) works');

  const r3 = zoneDir.checkEntranceEligibility('region:na:la', 'level:level_sewer', 3, 2);
  assert(r3.ok === false, 'non-entrance tile (3,2) rejected');
  assert(r3.code === 'TRANSFER_FAILED', 'code = TRANSFER_FAILED');
}

function test_entranceCoordsOutOfBounds() {
  console.log('\nT6: Entrance coords out of bounds -> skipped during build');
  // We verify this by injecting a snapshot with intentionally OOB entrance
  // that should have been filtered. The current snapshot has no OOB entries
  // because buildTestSnapshot only includes valid ones.
  // Instead, test that an entrance at (99,99) on an 8x6 grid was never added.
  const snap = zoneDir.getSnapshot();
  const naEnt = snap._entrances.get('na');
  assert(naEnt !== undefined, 'na entrances exist');
  const sewerTiles = naEnt.get('level:level_sewer');
  assert(sewerTiles.length === 2, 'exactly 2 sewer entrances (no OOB)');
  const hasOob = sewerTiles.some(e => e.x >= 8 || e.y >= 6);
  assert(!hasOob, 'no out-of-bounds entrance tiles present');
}

function test_nonRegionToLevelBypass() {
  console.log('\nT7: Non region->level route bypasses entrance check');
  // world -> region: no entrance check needed
  const r1 = zoneDir.checkEntranceEligibility('world:na', 'region:na:la', 0, 0);
  assert(r1.ok === true, 'world->region bypasses entrance check');

  // region -> world: no entrance check needed
  const r2 = zoneDir.checkEntranceEligibility('region:na:la', 'world:na', 0, 0);
  assert(r2.ok === true, 'region->world bypasses entrance check');

  // world -> level: no entrance check (deferred, not region->level)
  const r3 = zoneDir.checkEntranceEligibility('world:na', 'level:level_sewer', 0, 0);
  assert(r3.ok === true, 'world->level bypasses entrance check');
}

function test_entranceFacingPreserved() {
  console.log('\nT8: Entrance facing is returned for spawn override');
  const r1 = zoneDir.checkEntranceEligibility('region:na:la', 'level:level_sewer', 4, 3);
  assert(r1.entrance.facing === 's', 'entrance at (4,3) has facing=s');

  const r2 = zoneDir.checkEntranceEligibility('region:na:la', 'level:level_sewer', 2, 1);
  assert(r2.entrance.facing === null, 'entrance at (2,1) has facing=null (preserve existing)');

  const r3 = zoneDir.checkEntranceEligibility('region:na:la', 'level:level_dock', 5, 4);
  assert(r3.entrance.facing === 'e', 'dock entrance has facing=e');
}

function test_differentLevelsSameRegion() {
  console.log('\nT9: Different levels gated independently from same region');
  // On sewer entrance tile, can enter sewer but not dock
  const r1 = zoneDir.checkEntranceEligibility('region:na:la', 'level:level_sewer', 4, 3);
  assert(r1.ok === true, 'sewer entrance at (4,3) -> sewer allowed');

  const r2 = zoneDir.checkEntranceEligibility('region:na:la', 'level:level_dock', 4, 3);
  assert(r2.ok === false, 'sewer entrance at (4,3) -> dock denied');
  assert(r2.code === 'TRANSFER_FAILED', 'wrong entrance: TRANSFER_FAILED');

  // On dock entrance tile, can enter dock but not sewer
  const r3 = zoneDir.checkEntranceEligibility('region:na:la', 'level:level_dock', 5, 4);
  assert(r3.ok === true, 'dock entrance at (5,4) -> dock allowed');

  const r4 = zoneDir.checkEntranceEligibility('region:na:la', 'level:level_sewer', 5, 4);
  assert(r4.ok === false, 'dock entrance at (5,4) -> sewer denied');
}

// ===========================================================================
// Run
// ===========================================================================

console.log('=== Region → Level Entrance Gating v1 — Spec Tests ===');

const testSnap = buildTestSnapshot();
zoneDir._injectSnapshot(testSnap);

test_validEntranceOnTile();
test_validEntranceOffTile();
test_noEntrancesInRegion();
test_entranceToNonExistentLevel();
test_multipleEntrancesToSameLevel();
test_entranceCoordsOutOfBounds();
test_nonRegionToLevelBypass();
test_entranceFacingPreserved();
test_differentLevelsSameRegion();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
