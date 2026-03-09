'use strict';

/**
 * Lightweight in-memory level room registry.
 * Tracks which players are in a given level instance,
 * who is the host (first joiner), and the state of shared items.
 *
 * Item refresh: items taken on a previous UTC day are automatically
 * available again. Server restart also resets all state, which is
 * acceptable given the 24-hour refresh window.
 */

// Map<instanceId, RoomData>
// RoomData = {
//   members: Map<entityId, ws>,
//   memberNames: Map<entityId, string>,
//   hostId: string|null,
//   items: Map<itemId, { takenBy: string, takenAtDay: number }>
// }
const rooms = new Map();

function _currentUtcDay() {
    return Math.floor(Date.now() / 86400000);
}

function _getOrCreateRoom(instanceId) {
    if (!rooms.has(instanceId)) {
        rooms.set(instanceId, {
            members: new Map(),
            memberNames: new Map(),
            hostId: null,
            items: new Map(),
            // Map<enemyId, killedAtDay> — persists for the current UTC day
            deadEnemies: new Map()
        });
    }
    return rooms.get(instanceId);
}

/**
 * Join a level room.
 * Returns { isHost, items, existingMembers: [{entityId, displayName}] }
 * existingMembers contains everyone already in the room BEFORE this join.
 */
function joinRoom(instanceId, entityId, ws, displayName) {
    const room = _getOrCreateRoom(instanceId);

    // Snapshot existing members BEFORE adding the new one
    const existingMembers = [];
    for (const [eid, _ws] of room.members) {
        if (eid !== entityId) {
            existingMembers.push({ entityId: eid, displayName: room.memberNames.get(eid) || eid });
        }
    }

    room.members.set(entityId, ws);
    room.memberNames.set(entityId, displayName || entityId);

    const isHost = (room.hostId === null);
    if (isHost) room.hostId = entityId;

    // Serialize current (active) item state to send to new joiner
    const today = _currentUtcDay();
    const items = {};
    for (const [itemId, state] of room.items) {
        items[itemId] = {
            takenBy: state.takenBy,
            takenAtDay: state.takenAtDay,
            available: state.takenAtDay < today
        };
    }

    // Dead enemies for today (reuse `today` already declared above)
    const deadEnemies = [];
    for (const [eid, day] of room.deadEnemies) {
        if (day >= today) deadEnemies.push(eid);
    }

    return { isHost, items, existingMembers, deadEnemies };
}

/**
 * Leave a level room.
 * If the host leaves, promotes the next member.
 * Returns the new host entityId (or null if room is now empty).
 */
function leaveRoom(instanceId, entityId) {
    const room = rooms.get(instanceId);
    if (!room) return null;

    room.members.delete(entityId);
    room.memberNames.delete(entityId);

    if (room.members.size === 0) {
        rooms.delete(instanceId);
        return null;
    }

    if (room.hostId === entityId) {
        // Promote first remaining member
        room.hostId = room.members.keys().next().value;
    }
    return room.hostId;
}

/**
 * Broadcast a JSON payload to all room members except excludeId.
 */
function broadcast(instanceId, payload, excludeId) {
    const room = rooms.get(instanceId);
    if (!room) return;
    const msg = JSON.stringify(payload);
    for (const [eid, ws] of room.members) {
        if (eid === excludeId) continue;
        try { ws.send(msg); } catch (_) {}
    }
}

/**
 * Record one or more enemy kills for today.
 * Idempotent — safe to call multiple times for the same enemy.
 */
function killEnemies(instanceId, enemyIds) {
    const room = rooms.get(instanceId);
    if (!room || !Array.isArray(enemyIds)) return;
    const today = _currentUtcDay();
    for (const eid of enemyIds) {
        if (typeof eid === 'string') room.deadEnemies.set(eid, today);
    }
}

/**
 * Get list of enemy IDs killed today in this room.
 */
function getDeadEnemies(instanceId) {
    const room = rooms.get(instanceId);
    if (!room) return [];
    const today = _currentUtcDay();
    const result = [];
    for (const [eid, day] of room.deadEnemies) {
        if (day >= today) result.push(eid);
    }
    return result;
}

/**
 * Try to mark an item as taken.
 * Returns false if already taken today.
 * Returns { takenBy, takenAtDay } on success.
 */
function takeItem(instanceId, itemId, entityId) {
    const room = rooms.get(instanceId);
    if (!room) return false;

    const today = _currentUtcDay();
    const existing = room.items.get(itemId);
    if (existing && existing.takenAtDay >= today) {
        return false; // already taken today
    }

    const state = { takenBy: entityId, takenAtDay: today };
    room.items.set(itemId, state);
    return state;
}

/**
 * Get current item state for an instance.
 * Items taken on a previous day are marked available.
 */
function getRoomItems(instanceId) {
    const room = rooms.get(instanceId);
    if (!room) return {};
    const today = _currentUtcDay();
    const items = {};
    for (const [itemId, state] of room.items) {
        items[itemId] = {
            takenBy: state.takenBy,
            takenAtDay: state.takenAtDay,
            available: state.takenAtDay < today
        };
    }
    return items;
}

/**
 * Get room member count.
 */
function getMemberCount(instanceId) {
    const room = rooms.get(instanceId);
    return room ? room.members.size : 0;
}

/**
 * Get current host id.
 */
function getHostId(instanceId) {
    const room = rooms.get(instanceId);
    return room ? room.hostId : null;
}

/**
 * Remove empty/stale rooms to prevent memory leaks.
 * Call periodically (e.g. every few minutes).
 */
function pruneStaleRooms() {
    for (const [id, room] of rooms) {
        if (room.members.size === 0) rooms.delete(id);
    }
}

// Auto-prune every 5 minutes
setInterval(pruneStaleRooms, 5 * 60 * 1000);

module.exports = {
    joinRoom,
    leaveRoom,
    broadcast,
    killEnemies,
    getDeadEnemies,
    takeItem,
    getRoomItems,
    getMemberCount,
    getHostId,
    pruneStaleRooms
};
