// Zone — owns entities, AOI, intent processing, tick, AOI-scoped broadcast.
// Supports both tile-based movement (intents) and pixel-position sync (pos_sync).
// Designed for hundreds of concurrent players per zone.

const { AOIGrid, posToCell, cellKey, neighborCells } = require('../realtime/aoi');
const { makeDelta, makePosUpdate } = require('../realtime/messages');
const { loadBounds } = require('./zone_bounds');
const { getSpawn } = require('./zone_spawn');
const { parseZoneId } = require('./zone_id');
const { buildCollisionDescriptor, isBlocked } = require('./collision_grid');
const presence = require('./presence');

const MOVE_SPEED = 1;
const VALID_FACING = { n: true, e: true, s: true, w: true };
const POS_DIRTY_THRESHOLD_PX = 4;
const TILE_PX = 64;

class Zone {
  constructor(id, type) {
    this.id = id;
    const parsed = parseZoneId(id);
    this.type = type || (parsed ? parsed.type : 'world');
    this.entities = new Map();
    this.byAccount = new Map();
    this.conns = new Map();
    this.aoi = new AOIGrid();
    this.dirtyUpserts = new Map();
    this._pendingTeleports = new Map();
    this._posDirty = new Map();
    this.dirtyRemoves = new Set();
    this.tickId = 0;

    const bounds = loadBounds(id);
    this.boundsW = bounds.w;
    this.boundsH = bounds.h;

    const spawn = getSpawn(id, this.boundsW, this.boundsH);
    this._spawnX = spawn.x;
    this._spawnY = spawn.y;

    const coll = buildCollisionDescriptor(id, this.boundsW, this.boundsH);
    this._collisionGrid = coll.grid;
    this._collisionDescriptor = coll.descriptor;
  }

  get spawnX() { return this._spawnX; }
  get spawnY() { return this._spawnY; }
  get collisionDescriptor() { return this._collisionDescriptor; }
  get playerCount() { return this.conns.size; }

  blocked(x, y) {
    return isBlocked(this._collisionGrid, x, y, this.boundsW, this.boundsH);
  }

  addEntity(entity, ws) {
    entity.zoneId = this.id;
    entity.px = entity.px != null ? entity.px : entity.x * TILE_PX;
    entity.py = entity.py != null ? entity.py : entity.y * TILE_PX;
    entity._lastBcastPx = entity.px;
    entity._lastBcastPy = entity.py;
    entity._lastBcastFacing = entity.facing;
    this.entities.set(entity.id, entity);
    this.byAccount.set(entity.accountId, entity.id);
    if (ws) this.conns.set(entity.id, ws);
    const cell = posToCell(entity.x, entity.y, 1);
    this.aoi.addPlayer(entity.id, cell.cx, cell.cy);
    presence.update(entity.accountId, entity);
  }

  removeEntity(entityId) {
    const entity = this.entities.get(entityId);
    if (entity) this.byAccount.delete(entity.accountId);
    this.entities.delete(entityId);
    this.conns.delete(entityId);
    this.aoi.removePlayer(entityId);
    this.dirtyRemoves.add(entityId);
  }

  removeConn(entityId) {
    const entity = this.entities.get(entityId);
    if (!entity) return null;
    this.removeEntity(entityId);
    return entityId;
  }

  addConn(entity, ws) {
    entity.x = this._spawnX;
    entity.y = this._spawnY;
    entity.lastSeq = 0;
    entity.intent = null;
    this.addEntity(entity, ws);
    return entity;
  }

  getEntity(entityId) {
    return this.entities.get(entityId) || null;
  }

  entityIdForAccount(accountId) {
    return this.byAccount.get(accountId) || null;
  }

  applyInput(accountId, intent) {
    const entityId = this.byAccount.get(accountId);
    if (!entityId) return;
    const entity = this.entities.get(entityId);
    if (!entity) return;
    if (intent.seq <= entity.lastSeq) return;
    entity.lastSeq = intent.seq;
    entity.intent = {
      move: intent.move || { x: 0, y: 0 },
      facing: (intent.facing && VALID_FACING[intent.facing]) ? intent.facing : null,
      keys: intent.keys || {},
    };
  }

  posSync(accountId, px, py, facing, mode, turtleId, vpx, vpy, vf) {
    const entityId = this.byAccount.get(accountId);
    if (!entityId) return false;
    const entity = this.entities.get(entityId);
    if (!entity) return false;

    entity.px = px;
    entity.py = py;
    if (facing && VALID_FACING[facing]) entity.facing = facing;
    if (mode === 'van' || mode === 'foot') entity.mode = mode;
    if (turtleId) entity.turtleId = turtleId;
    if (mode === 'foot' && vpx != null) {
      entity.vpx = vpx;
      entity.vpy = vpy;
      entity.vf = vf || 's';
    } else {
      entity.vpx = null;
      entity.vpy = null;
      entity.vf = null;
    }

    const newTileX = Math.floor(px / TILE_PX);
    const newTileY = Math.floor(py / TILE_PX);
    const clampedX = Math.max(0, Math.min(this.boundsW - 1, newTileX));
    const clampedY = Math.max(0, Math.min(this.boundsH - 1, newTileY));

    if (clampedX !== entity.x || clampedY !== entity.y) {
      entity.x = clampedX;
      entity.y = clampedY;
      const newCell = posToCell(clampedX, clampedY, 1);
      this.aoi.movePlayer(entityId, newCell.cx, newCell.cy);
    }

    const dxB = Math.abs(px - entity._lastBcastPx);
    const dyB = Math.abs(py - entity._lastBcastPy);
    const facingChanged = entity.facing !== entity._lastBcastFacing;

    if (dxB >= POS_DIRTY_THRESHOLD_PX || dyB >= POS_DIRTY_THRESHOLD_PX || facingChanged) {
      this._posDirty.set(entityId, entity);
    }

    return true;
  }

  teleportEntity(accountId, tx, ty) {
    const entityId = this.byAccount.get(accountId);
    if (!entityId) return false;
    const entity = this.entities.get(entityId);
    if (!entity) return false;
    const cx = Math.max(0, Math.min(this.boundsW - 1, Math.round(tx)));
    const cy = Math.max(0, Math.min(this.boundsH - 1, Math.round(ty)));
    entity.x = cx;
    entity.y = cy;
    entity.px = cx * TILE_PX;
    entity.py = cy * TILE_PX;
    entity._lastBcastPx = entity.px;
    entity._lastBcastPy = entity.py;
    entity._lastBcastFacing = entity.facing;
    entity.intent = null;
    const newCell = posToCell(cx, cy, 1);
    this.aoi.movePlayer(entityId, newCell.cx, newCell.cy);
    this._pendingTeleports.set(entityId, wireSnapshot(entity));
    presence.update(accountId, entity);
    return true;
  }

  tick() {
    this.tickId++;
    this.dirtyUpserts.clear();

    for (const [eid, snap] of this._pendingTeleports) {
      this.dirtyUpserts.set(eid, snap);
    }
    this._pendingTeleports.clear();

    for (const [eid, player] of this.entities) {
      if (!player.intent) continue;

      let dirty = false;

      if (player.intent.facing && player.intent.facing !== player.facing) {
        player.facing = player.intent.facing;
        dirty = true;
      }

      let dx = player.intent.move.x || 0;
      let dy = player.intent.move.y || 0;

      if (dx !== 0 && dy !== 0) {
        dy = 0;
      }

      const wantedMove = (dx !== 0 || dy !== 0);

      if (wantedMove) {
        const nextX = player.x + dx * MOVE_SPEED;
        const nextY = player.y + dy * MOVE_SPEED;

        const clampedX = Math.max(0, Math.min(this.boundsW - 1, nextX));
        const clampedY = Math.max(0, Math.min(this.boundsH - 1, nextY));

        if (this.blocked(clampedX, clampedY)) {
          dirty = true;
        } else if (clampedX !== player.x || clampedY !== player.y) {
          const oldCell = posToCell(player.x, player.y, 1);
          player.x = clampedX;
          player.y = clampedY;
          player.px = clampedX * TILE_PX;
          player.py = clampedY * TILE_PX;
          const newCell = posToCell(player.x, player.y, 1);

          if (cellKey(oldCell.cx, oldCell.cy) !== cellKey(newCell.cx, newCell.cy)) {
            this.aoi.movePlayer(eid, newCell.cx, newCell.cy);
          }

          dirty = true;
        } else {
          dirty = true;
        }
      }

      if (dirty) {
        this.dirtyUpserts.set(eid, wireSnapshot(player));
        presence.update(player.accountId, player);
      }
    }
  }

  broadcastDeltas(globalTick) {
    const hasUpserts = this.dirtyUpserts.size > 0;
    const hasPosDirty = this._posDirty.size > 0;
    const hasRemoves = this.dirtyRemoves.size > 0;

    if (!hasUpserts && !hasPosDirty && !hasRemoves) return;

    const buckets = new Map();
    const ensureBucket = (ws) => {
      if (!buckets.has(ws)) buckets.set(ws, { upserts: [], posUpdates: [], removes: [] });
      return buckets.get(ws);
    };

    for (const [eid, snap] of this.dirtyUpserts) {
      const entity = this.entities.get(eid);
      if (!entity) continue;
      this._posDirty.delete(eid);
      entity._lastBcastPx = entity.px;
      entity._lastBcastPy = entity.py;
      entity._lastBcastFacing = entity.facing;
      const cell = posToCell(entity.x, entity.y, 1);
      const neighbors = neighborCells(cell.cx, cell.cy);
      for (const nk of neighbors) {
        const cellSet = this.aoi.cells.get(nk);
        if (!cellSet) continue;
        for (const recipientId of cellSet) {
          const ws = this.conns.get(recipientId);
          if (ws && ws.readyState === 1) {
            ensureBucket(ws).upserts.push(snap);
          }
        }
      }
    }

    for (const [eid, entity] of this._posDirty) {
      entity._lastBcastPx = entity.px;
      entity._lastBcastPy = entity.py;
      entity._lastBcastFacing = entity.facing;
      const compact = [entity.id, entity.px, entity.py, entity.facing, entity.mode || 'van', entity.turtleId || 'leo', entity.vpx, entity.vpy, entity.vf];
      const cell = posToCell(entity.x, entity.y, 1);
      const neighbors = neighborCells(cell.cx, cell.cy);
      for (const nk of neighbors) {
        const cellSet = this.aoi.cells.get(nk);
        if (!cellSet) continue;
        for (const recipientId of cellSet) {
          const ws = this.conns.get(recipientId);
          if (ws && ws.readyState === 1) {
            ensureBucket(ws).posUpdates.push(compact);
          }
        }
      }
    }
    this._posDirty.clear();

    if (hasRemoves) {
      const removeIds = Array.from(this.dirtyRemoves);
      for (const [, ws] of this.conns) {
        if (ws && ws.readyState === 1) {
          ensureBucket(ws).removes.push(...removeIds);
        }
      }
    }

    const wsToEid = new Map();
    for (const [eid, w] of this.conns) wsToEid.set(w, eid);

    for (const [ws, bucket] of buckets) {
      const eid = wsToEid.get(ws);
      const ent = eid ? this.entities.get(eid) : null;
      const ackSeq = ent ? ent.lastSeq : 0;

      if (bucket.upserts.length > 0 || bucket.removes.length > 0) {
        try {
          ws.send(makeDelta(globalTick, this.id, bucket.upserts, bucket.removes, ackSeq));
        } catch {}
      }

      if (bucket.posUpdates.length > 0) {
        try {
          ws.send(makePosUpdate(globalTick, this.id, bucket.posUpdates));
        } catch {}
      }
    }

    this.dirtyRemoves.clear();
  }

  buildSnapshotFor() {
    const result = [];
    for (const e of this.entities.values()) {
      result.push(wireSnapshot(e));
    }
    return result;
  }

  getAllPlayerSnapshots() {
    return this.buildSnapshotFor();
  }

  getVisibleSnapshots(entityId) {
    const visible = this.aoi.getVisiblePlayers(entityId);
    const result = [];
    for (const pid of visible) {
      const e = this.entities.get(pid);
      if (e) result.push(wireSnapshot(e));
    }
    return result;
  }
}

function wireSnapshot(entity) {
  const snap = {
    id: entity.id,
    x: entity.x,
    y: entity.y,
    px: entity.px != null ? entity.px : entity.x * TILE_PX,
    py: entity.py != null ? entity.py : entity.y * TILE_PX,
    facing: entity.facing,
    spriteRef: entity.spriteRef,
    mode: entity.mode || 'van',
    tid: entity.turtleId || 'leo',
  };
  if (entity.vpx != null) {
    snap.vpx = entity.vpx;
    snap.vpy = entity.vpy;
    snap.vf = entity.vf || 's';
  }
  return snap;
}

module.exports = { Zone, wireSnapshot, MOVE_SPEED };
