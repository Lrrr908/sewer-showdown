const { Zone } = require('./zone');
const { parseZoneId } = require('./zone_id');

class ZoneManager {
  constructor() {
    this.zones = new Map();
  }

  createZone(id, type) {
    if (this.zones.has(id)) return this.zones.get(id);
    const resolved = type || deriveType(id);
    const zone = new Zone(id, resolved);
    this.zones.set(id, zone);
    console.log(`[zones] created "${id}" (${resolved})`);
    return zone;
  }

  getZone(id) {
    return this.zones.get(id) || null;
  }

  getOrCreate(id, type) {
    return this.zones.get(id) || this.createZone(id, type);
  }

  destroyZone(id) {
    const zone = this.zones.get(id);
    if (!zone) return;
    for (const entityId of Array.from(zone.entities.keys())) {
      zone.removeEntity(entityId);
    }
    this.zones.delete(id);
    console.log(`[zones] destroyed "${id}"`);
  }

  zoneForAccount(accountId) {
    for (const zone of this.zones.values()) {
      if (zone.byAccount.has(accountId)) return zone;
    }
    return null;
  }

  // Atomic transfer: remove entity from old zone, add to new zone at its spawn.
  // Returns { entity, newZone } or null on failure.
  transferEntity(entityId, fromZoneId, toZoneId) {
    const fromZone = this.zones.get(fromZoneId);
    if (!fromZone) return null;
    const entity = fromZone.getEntity(entityId);
    if (!entity) return null;

    const ws = fromZone.conns.get(entityId) || null;

    fromZone.removeConn(entityId);

    const toZone = this.getOrCreate(toZoneId);
    toZone.addConn(entity, ws);

    console.log(`[zones] transfer ${entityId}: ${fromZoneId} -> ${toZoneId} (${toZone.spawnX},${toZone.spawnY})`);
    return { entity, newZone: toZone };
  }

  get size() { return this.zones.size; }
}

function deriveType(zoneId) {
  const parsed = parseZoneId(zoneId);
  return parsed ? parsed.type : 'world';
}

module.exports = ZoneManager;
