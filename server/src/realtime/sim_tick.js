const crypto = require('crypto');
const config = require('../config');
const ZoneManager = require('../zones/zone_manager');
const { wireSnapshot } = require('../zones/zone');
const presence = require('../zones/presence');
const { loadBounds } = require('../zones/zone_bounds');

const DEFAULT_ZONE = 'world:na';
const zoneManager = new ZoneManager();
let tickCount = 0;
let fastInterval = null;
let slowInterval = null;

function boot() {
  zoneManager.getOrCreate(DEFAULT_ZONE, 'world');
}

function makeEntityId() {
  return 'p_' + crypto.randomBytes(4).toString('hex');
}

function createPlayerEntity(entityId, accountId, spawnX, spawnY, opts) {
  return {
    id: entityId,
    accountId,
    zoneId: null,
    x: spawnX,
    y: spawnY,
    px: (opts && opts.px != null) ? opts.px : spawnX * 64,
    py: (opts && opts.py != null) ? opts.py : spawnY * 64,
    facing: (opts && opts.facing) || 's',
    spriteRef: (opts && opts.spriteRef) || 'base:van',
    lastSeq: 0,
    intent: null,
    hitbox: { x: 0, y: 0, w: 1, h: 1 },
    ownership: { type: 'account', id: accountId },
  };
}

// Fresh spawn — no resume logic.
function addPlayer(accountId, ws, zoneId) {
  const zone = zoneManager.getOrCreate(zoneId || DEFAULT_ZONE);
  const entityId = makeEntityId();
  const entity = createPlayerEntity(entityId, accountId, zone.spawnX, zone.spawnY);
  zone.addEntity(entity, ws);
  return entity;
}

// Resume-aware spawn. Returns { entity, resumeResult }.
function addPlayerWithResume(accountId, ws, clientZone, clientResume) {
  const resumeResult = presence.resolveReconnect(
    accountId, clientZone || DEFAULT_ZONE, clientResume
  );

  const actualZone = resumeResult.zoneId;
  const zone = zoneManager.getOrCreate(actualZone);
  const entityId = makeEntityId();

  let entity;
  if (resumeResult.resume) {
    const bounds = loadBounds(actualZone);
    const cx = Math.max(0, Math.min(bounds.w - 1, resumeResult.x));
    const cy = Math.max(0, Math.min(bounds.h - 1, resumeResult.y));
    entity = createPlayerEntity(entityId, accountId, cx, cy, {
      facing: resumeResult.facing,
      spriteRef: resumeResult.spriteRef,
    });
  } else {
    entity = createPlayerEntity(entityId, accountId, zone.spawnX, zone.spawnY);
  }

  zone.addEntity(entity, ws);
  return { entity, resumeResult };
}

function removePlayer(accountId) {
  const zone = zoneManager.zoneForAccount(accountId);
  if (!zone) return;
  const entityId = zone.entityIdForAccount(accountId);
  if (entityId) zone.removeEntity(entityId);
  presence.markDisconnected(accountId);
}

function applyInput(accountId, intent) {
  const zone = zoneManager.zoneForAccount(accountId);
  if (zone) zone.applyInput(accountId, intent);
}

function getEntityForAccount(accountId) {
  const zone = zoneManager.zoneForAccount(accountId);
  if (!zone) return null;
  const entityId = zone.entityIdForAccount(accountId);
  return entityId ? zone.getEntity(entityId) : null;
}

function getZoneForAccount(accountId) {
  return zoneManager.zoneForAccount(accountId);
}

function transferPlayer(entityId, fromZoneId, toZoneId) {
  return zoneManager.transferEntity(entityId, fromZoneId, toZoneId);
}

function fastTick() {
  tickCount++;
  for (const zone of zoneManager.zones.values()) {
    zone.tick();
    zone.broadcastDeltas(tickCount);
  }
}

function slowTick() {
  presence.cleanup();
  for (const [zid, zone] of zoneManager.zones) {
    if (zone.playerCount > 0) {
      console.log('[zone] ' + zid + ': ' + zone.playerCount + ' players, ' + zone.aoi.cells.size + ' AOI cells');
    }
  }
}

function startSimLoop() {
  boot();
  if (fastInterval) return;
  fastInterval = setInterval(fastTick, config.TICK_MS);
  slowInterval = setInterval(slowTick, 1000);
  console.log(`[sim] started (${config.TICK_HZ} Hz fast, 1 Hz slow)`);
}

function stopSimLoop() {
  if (fastInterval) { clearInterval(fastInterval); fastInterval = null; }
  if (slowInterval) { clearInterval(slowInterval); slowInterval = null; }
  console.log('[sim] stopped');
}

module.exports = {
  addPlayer, addPlayerWithResume, removePlayer,
  applyInput, transferPlayer,
  getEntityForAccount, getZoneForAccount,
  wireSnapshot,
  startSimLoop, stopSimLoop,
  zoneManager, presence,
  get tickCount() { return tickCount; },
  DEFAULT_ZONE,
};
