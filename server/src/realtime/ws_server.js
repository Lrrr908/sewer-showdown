const config = require('../config');
const { verifyToken } = require('../auth/auth_tokens');
const { isValidZoneId } = require('../zones/zone_id');
const presence = require('../zones/presence');
const zoneDir = require('../zones/zone_directory');
const {
  PROTOCOL_VERSION,
  parseMessage, validateHello, validateInput, validateAction, validateUgcSubmit,
  makeHelloOk, makeSnapshot, makeDelta, makeError, makeUgcUpdate,
  makeTransferBegin, makeTransferCommit, makeCollisionFull, makeChat,
} = require('./messages');
const sim = require('./sim_tick');
const { wireSnapshot } = require('../zones/zone');
const ugcValidate = require('../ugc/ugc_validate');
const levelRoom = require('../level_room');
const { resolveEmailByAccountId } = require('../auth/auth_routes');

const AUTH_TIMEOUT_MS = 5000;
const TRANSFER_IGNORE_NOTIFY_MS = 1000;
const POS_SYNC_MIN_MS = 25;
const CHAT_MAX_LEN = 60;
const CHAT_COOLDOWN_MS = 1000;

// ── Entity-level tracking ─────────────────────────────────────────────────────
// Tracks which entity IDs are currently inside a building level so the overworld
// AOI chat broadcast can skip them (they have their own level-room chat channel).
const inLevelEntityIds = new Set();

// ── Per-connection rate limits (ms between allowed messages) ─────────────────
const RATE_INPUT_MIN_MS        = 16;   // ~60 Hz max
const RATE_ENEMY_SYNC_MIN_MS   = 80;   // ~12 Hz max
const RATE_OW_ENEMY_SYNC_MIN_MS= 80;
const RATE_OW_JOIN_MIN_MS      = 2000; // re-join cooldown
const RATE_JOIN_LEVEL_MIN_MS   = 1000;
const RATE_PIZZA_MIN_MS        = 500;
const RATE_LEVEL_SYNC_MIN_MS   = 50;

// ── Field validation helpers ──────────────────────────────────────────────────
const DN_MAX_LEN = 24;
const INSTANCE_ID_MAX_LEN = 64;
const OW_KILL_STORE_MAX = 5000; // per zone per hour

function isSafeNumber(v) {
    return typeof v === 'number' && isFinite(v) && !isNaN(v);
}
function isSafeString(v, maxLen) {
    return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

// ── Overworld hourly kill store ───────────────────────────────────────────────
// zoneId -> { hour: number, ids: Set<string> }
// Auto-resets each hour. Persists for the server's lifetime (in-memory only).
const owKillStore = new Map();

function _currentHour() { return Math.floor(Date.now() / 3600000); }

function owRecordKills(zoneKey, ids) {
    const h = _currentHour();
    let entry = owKillStore.get(zoneKey);
    if (!entry || entry.hour !== h) {
        entry = { hour: h, ids: new Set() };
        owKillStore.set(zoneKey, entry);
    }
    for (const id of ids) {
        if (entry.ids.size >= OW_KILL_STORE_MAX) break;
        if (typeof id === 'string' && id.length <= 64) entry.ids.add(id);
        else if (id && typeof id === 'object' && typeof id.id === 'string' && id.id.length <= 64) entry.ids.add(id.id);
    }
}

function owGetDeadEnemies(zoneKey) {
    const h = _currentHour();
    const entry = owKillStore.get(zoneKey);
    if (!entry || entry.hour !== h) return [];
    return [...entry.ids];
}

// ── Per-zone enemy snapshot store ────────────────────────────────────────────
// Caches the last-known position of every live enemy in a zone so late-joining
// or refreshing players see enemies at their current positions immediately.
// zoneId -> Map<enemyId, {id, x, y, s, tp}>
const owEnemySnapshots = new Map();
const OW_ENEMY_SNAPSHOT_CAP = 150; // max enemies stored per zone

function _getEnemySnapshotMap(zoneId) {
    let snap = owEnemySnapshots.get(zoneId);
    if (!snap) { snap = new Map(); owEnemySnapshots.set(zoneId, snap); }
    return snap;
}

function owUpdateEnemySnapshot(zoneId, enemies) {
    const snap = _getEnemySnapshotMap(zoneId);
    for (const e of enemies) {
        if (e && e.id) {
            snap.set(e.id, { id: e.id, x: e.x, y: e.y, s: e.s || 'patrol', tp: e.tp || 'walker' });
        }
    }
    // Keep the snapshot bounded
    if (snap.size > OW_ENEMY_SNAPSHOT_CAP) {
        const toDelete = snap.size - OW_ENEMY_SNAPSHOT_CAP;
        let deleted = 0;
        for (const key of snap.keys()) {
            if (deleted++ >= toDelete) break;
            snap.delete(key);
        }
    }
}

function owRemoveFromEnemySnapshot(zoneId, kills) {
    const snap = owEnemySnapshots.get(zoneId);
    if (!snap) return;
    for (const k of kills) {
        const id = typeof k === 'string' ? k : (k && k.id);
        if (id) snap.delete(id);
    }
}

function owGetEnemySnapshot(zoneId) {
    const snap = owEnemySnapshots.get(zoneId);
    return snap ? [...snap.values()] : [];
}

// Region host model removed — all clients simulate their own nearby sectors and
// broadcast via AOI. This distributes CPU load to client machines and keeps
// server message volume proportional to local density rather than zone size.

// ── Per-zone pizza state store ────────────────────────────────────────────────
// zoneId -> Map<pizzaId, { id, x, y, type, spawnTime, collected, collectedTime }>
// Tracks all active pizzas so late-joining players see the current world state.
const zonePizzaStore = new Map();
const PIZZA_EXPIRE_MS = 10 * 60 * 1000; // remove uncollected pizzas after 10 min

function _getPizzaMap(zoneId) {
    let store = zonePizzaStore.get(zoneId);
    if (!store) { store = new Map(); zonePizzaStore.set(zoneId, store); }
    // Prune stale entries on each access to keep memory bounded
    const now = Date.now();
    for (const [id, p] of store) {
        if (p.collected && (now - (p.collectedTime || 0)) > 5 * 60 * 1000) store.delete(id);
        else if (!p.collected && (now - (p.spawnTime || 0)) > PIZZA_EXPIRE_MS) store.delete(id);
    }
    return store;
}

function zonePizzaAdd(zoneId, pizza) {
    if (!pizza || !pizza.id) return;
    const store = _getPizzaMap(zoneId);
    store.set(pizza.id, { id: pizza.id, x: pizza.x, y: pizza.y, type: pizza.type,
        spawnTime: pizza.spawnTime || Date.now(), collected: false, collectedTime: 0 });
}

function zonePizzaCollect(zoneId, pizzaId) {
    const store = _getPizzaMap(zoneId);
    const p = store.get(pizzaId);
    if (p) { p.collected = true; p.collectedTime = Date.now(); }
}

function zonePizzaList(zoneId) {
    return [..._getPizzaMap(zoneId).values()].filter(p => !p.collected);
}

// ── Zone-wide broadcast helper ────────────────────────────────────────────────
function broadcastToZone(zone, payload, excludeWs) {
    for (const [, pws] of zone.conns) {
        if (pws === excludeWs || pws.readyState !== 1) continue;
        try { pws.send(payload); } catch {}
    }
}

// accountId -> ws. Enforces single active connection per account.
const connByAccount = new Map();

// ── Technodrone vehicle-building state (server-authoritative) ────────────────
const technodroneState = {
  x: null, y: null, direction: 'right',
  driverId: null,           // entityId of the current driver
  driverAccountId: null,    // accountId of the current driver
};

function broadcastTechnodroneState(excludeWs) {
  const payload = JSON.stringify({
    t: 'technodrone_state',
    x: technodroneState.x,
    y: technodroneState.y,
    dir: technodroneState.direction,
    active: technodroneState.driverId !== null,
    driverId: technodroneState.driverId
  });
  for (const [, pws] of connByAccount) {
    if (pws !== excludeWs && pws.readyState === 1) {
      try { pws.send(payload); } catch {}
    }
  }
}

function autoParktechnodrone(lastEntityId) {
  if (technodroneState.driverId === lastEntityId) {
    technodroneState.driverId = null;
    technodroneState.driverAccountId = null;
    console.log(`[technodrone] auto-parked at (${technodroneState.x}, ${technodroneState.y})`);
    broadcastTechnodroneState(null);
  }
}

function initWsServer(wss) {
  wss.on('connection', (ws) => {
    let authenticated = false;
    let accountId = null;
    let accountEmail = null;
    let entityId = null;
    let zoneId = null;
    let alive = true;
    let transferring = false;
    let lastTransferIgnoreNotify = 0;
    let lastPosSyncMs = 0;

    // Phase tracking for disconnect-during-transfer safety.
    let pendingTransfer = null;
    let lastChatMs = 0;
    let currentLevelInstanceId = null;
    let currentRoomId = null;          // dungeon/gallery room the player is currently in

    // Per-connection rate-limit timestamps
    const _rl = {
        input:       0,
        enemySync:   0,
        owEnemySync: 0,
        owJoin:      0,
        joinLevel:   0,
        pizza:       0,
        levelSync:   0,
    };

    const pingInterval = setInterval(() => {
      if (!alive) {
        console.log(`[ws] no pong from ${entityId || 'unknown'}, terminating`);
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, config.WS_PING_INTERVAL_MS);

    ws.on('pong', () => { alive = true; });

    const authTimer = setTimeout(() => {
      if (!authenticated) {
        sendFatal('AUTH_REQUIRED', 'hello not received in time');
      }
    }, AUTH_TIMEOUT_MS);

    function sendFatal(code, msg) {
      try { ws.send(makeError(code, msg, true)); } catch {}
      ws.close(4000 + fatalCodeOffset(code), code);
    }

    ws.on('message', async (raw) => {
      alive = true;
      const msg = parseMessage(raw);
      if (!msg) return;

      // --- Pre-auth: must be hello ---
      if (!authenticated) {
        const helloResult = validateHello(msg);
        if (!helloResult.ok) {
          sendFatal(helloResult.code, errorMsgFor(helloResult.code, msg));
          return;
        }

        let decoded;
        try {
          decoded = verifyToken(msg.token);
        } catch (e) {
          sendFatal('AUTH_REQUIRED', 'invalid or expired token');
          return;
        }

        accountId = decoded.sub;
        accountEmail = decoded.email || null;
        if (!accountEmail) {
          try { accountEmail = await resolveEmailByAccountId(accountId); } catch {}
        }
        clearTimeout(authTimer);

        // Single connection per account: close old if exists.
        const oldWs = connByAccount.get(accountId);
        if (oldWs && oldWs !== ws && oldWs.readyState <= 1) {
          try { oldWs.send(makeError('REPLACED_BY_NEW_CONNECTION', 'new connection opened', true)); } catch {}
          oldWs.close(4005, 'REPLACED_BY_NEW_CONNECTION');
          sim.removePlayer(accountId);
          console.log(`[ws] replaced old connection for ${accountId}`);
        }
        connByAccount.set(accountId, ws);

        // Resume-or-fresh decision
        const clientZone = msg.zone || sim.DEFAULT_ZONE;
        const clientResume = msg.resume !== false;
        const { entity, resumeResult } = sim.addPlayerWithResume(accountId, ws, clientZone, clientResume);

        entityId = entity.id;
        zoneId = entity.zoneId;
        // Trust the token's display name over the client-supplied one to prevent
        // spoofing. Strip to safe length and printable ASCII regardless.
        const rawDn = decoded.dn || msg.dn || accountId.substring(0, 8);
        entity.displayName = String(rawDn).replace(/[^\x20-\x7E]/g, '').substring(0, DN_MAX_LEN) || accountId.substring(0, 8);
        authenticated = true;

        const zone = sim.getZoneForAccount(accountId);
        const visiblePlayers = zone ? zone.getVisibleSnapshots(entityId) : [];

        ws.send(makeHelloOk(entityId, accountId, zoneId, resumeResult));

        const allowedVehicles = [];
        if (accountEmail && config.TECHNODROME_ALLOWED_EMAILS.includes(accountEmail.toLowerCase())) {
          allowedVehicles.push('technodrone');
        }
        try { ws.send(JSON.stringify({ t: 'vehicles_allowed', vehicles: allowedVehicles })); } catch {}

        if (accountEmail && config.ALL_ITEMS_EMAILS.includes(accountEmail.toLowerCase())) {
          const ALL_ITEM_IDS = [
            'mutagen_canister', 'pizza_box', 'helmet_shard', 'shell_fragment', 'power_cell',
            'microphone', 'staff_piece', 'foot_scroll', 'dimension_crystal', 'technodrome_key',
          ];
          try { ws.send(JSON.stringify({ t: 'grant_items', items: ALL_ITEM_IDS })); } catch {}
        }

        const allPlayers = [wireSnapshot(entity), ...visiblePlayers];
        const bounds = zone ? { w: zone.boundsW, h: zone.boundsH } : null;
        const collision = zone ? zone.collisionDescriptor : null;
        ws.send(makeSnapshot(sim.tickCount, zoneId, allPlayers, entity.lastSeq, bounds, collision));

        if (zone) {
          const snap = wireSnapshot(entity);
          // AOI-filtered: only announce to players within neighbor cells of the joiner.
          const joinedNearby = zone.getPlayersNearEntity(entityId);
          for (const { pid, ws: pws } of joinedNearby) {
            const recipEntity = zone.getEntity(pid);
            const ack = recipEntity ? recipEntity.lastSeq : 0;
            try { pws.send(makeDelta(sim.tickCount, zoneId, [snap], [], ack)); } catch {}
          }
        }

        // Send current technodrone state so client knows where the building is
        if (technodroneState.x != null) {
          try {
            ws.send(JSON.stringify({
              t: 'technodrone_state',
              x: technodroneState.x, y: technodroneState.y,
              dir: technodroneState.direction,
              active: technodroneState.driverId !== null,
              driverId: technodroneState.driverId
            }));
          } catch {}
        }

        console.log(`[ws] ${entityId} (${accountId}) joined ${zoneId} (resume: ${resumeResult.reason}) instance=${require('../config').INSTANCE_ID}`);
        return;
      }

      // --- Input freeze during transfer ---
      if (transferring) {
        if (msg.t === 'input') {
          const now = Date.now();
          if (now - lastTransferIgnoreNotify >= TRANSFER_IGNORE_NOTIFY_MS) {
            lastTransferIgnoreNotify = now;
            try { ws.send(makeError('INPUT_IGNORED_TRANSFER', 'transfer in progress', false)); } catch {}
          }
        }
        if (msg.t === 'action' && msg.action === 'transfer') {
          try { ws.send(makeError('TRANSFER_ALREADY_IN_PROGRESS', 'already transferring', false)); } catch {}
        }
        return;
      }

      // --- Post-auth message routing ---
      switch (msg.t) {
        case 'input': {
          const _now = Date.now();
          if (_now - _rl.input < RATE_INPUT_MIN_MS) break;
          _rl.input = _now;
          if (validateInput(msg)) {
            sim.applyInput(accountId, msg);
          } else {
            try { ws.send(makeError('INPUT_INVALID', 'bad input payload', false)); } catch {}
          }
          break;
        }

        case 'pos_sync': {
          const now = Date.now();
          if (now - lastPosSyncMs < POS_SYNC_MIN_MS) break;
          lastPosSyncMs = now;
          if (isSafeNumber(msg.px) && isSafeNumber(msg.py)) {
            const zone = sim.getZoneForAccount(accountId);
            if (zone) zone.posSync(accountId, msg.px, msg.py, msg.facing, msg.mode, msg.tid, msg.vpx, msg.vpy, msg.vf, msg.atk);
            // Track technodrone position while being driven
            if (msg.mode === 'technodrone' && technodroneState.driverId === entityId) {
              technodroneState.x = msg.px;
              technodroneState.y = msg.py;
              if (msg.facing) {
                const fMap = { n: 'up', s: 'down', e: 'right', w: 'left' };
                technodroneState.direction = fMap[msg.facing] || msg.facing;
              }
            }
          }
          break;
        }

        case 'action':
          if (!validateAction(msg)) {
            try { ws.send(makeError('MESSAGE_INVALID', 'bad action payload', false)); } catch {}
            break;
          }
          if (msg.action === 'transfer') {
            handleTransfer(ws, msg);
          } else if (msg.action === 'collision_request') {
            handleCollisionRequest(ws, msg);
          } else if (msg.action === 'spawn_pos') {
            handleSpawnPos(msg);
          }
          break;

        case 'ugc_submit':
          if (validateUgcSubmit(msg)) {
            try {
              const result = await ugcValidate.handleSubmission(accountId, msg);
              ws.send(JSON.stringify({ t: 'ugc_result', v: PROTOCOL_VERSION, ...result }));
              if (result.ok && !result.deduped) {
                const zone = sim.getZoneForAccount(accountId);
                if (zone) {
                  const ugcMsg = makeUgcUpdate(zone.id, accountId, result.ugcId, result.baseSpriteKey, result.spriteRef);
                  // Deliver to submitter first (getPlayersNearEntity excludes them)
                  try { ws.send(ugcMsg); } catch {}
                  // AOI-scoped broadcast — only players who can actually see this entity
                  const entityId = zone.byAccount.get(accountId);
                  const nearby = entityId ? zone.getPlayersNearEntity(entityId) : [];
                  for (const { ws: pws } of nearby) {
                    try { pws.send(ugcMsg); } catch {}
                  }
                }
              }
            } catch (e) {
              console.error('[ws] ugc_submit error:', e);
              ws.send(JSON.stringify({ t: 'ugc_result', v: PROTOCOL_VERSION, ok: false, error: 'submission_failed' }));
            }
          } else {
            try { ws.send(makeError('MESSAGE_INVALID', 'bad ugc_submit payload', false)); } catch {}
          }
          break;

        case 'enemy_sync': {
          const _esNow = Date.now();
          if (_esNow - _rl.enemySync < RATE_ENEMY_SYNC_MIN_MS) break;
          _rl.enemySync = _esNow;
          const hasKills = Array.isArray(msg.kills) && msg.kills.length > 0;
          const hasHits  = Array.isArray(msg.hits)  && msg.hits.length  > 0;
          const hasShots = Array.isArray(msg.shots) && msg.shots.length > 0;
          const hasAtks  = Array.isArray(msg.atks)  && msg.atks.length  > 0;
          if (!hasKills && !hasHits && !hasShots && !hasAtks) break;
          // Persist kills for the hour so late-joiners don't respawn these enemies,
          // and remove from the position snapshot so joiners don't see dead enemies.
          if (hasKills) {
            owRecordKills(zoneId, msg.kills.slice(0, 50));
            owRemoveFromEnemySnapshot(zoneId, msg.kills.slice(0, 50));
          }
          const zone = sim.getZoneForAccount(accountId);
          if (zone) {
            // Kills must reach EVERY player in the zone — a player on the other side of
            // the map must know an enemy died so it doesn't attack them as a phantom.
            if (hasKills) {
              const killPayload = JSON.stringify({
                t: 'enemy_sync', zone: zoneId,
                kills: msg.kills.slice(0, 50), hits: [], shots: [], atks: [],
              });
              broadcastToZone(zone, killPayload, ws);
            }
            // Hits/shots/atks are cosmetic and high-frequency; keep AOI-filtered.
            if (hasHits || hasShots || hasAtks) {
              const localPayload = JSON.stringify({
                t: 'enemy_sync', zone: zoneId,
                kills: [],
                hits:  Array.isArray(msg.hits)  ? msg.hits.slice(0, 50)  : [],
                shots: Array.isArray(msg.shots) ? msg.shots.slice(0, 20) : [],
                atks:  Array.isArray(msg.atks)  ? msg.atks.slice(0, 10)  : [],
              });
              const enemySyncNearby = zone.getPlayersNearEntity(entityId);
              for (const { ws: pws } of enemySyncNearby) {
                try { pws.send(localPayload); } catch {}
              }
            }
          }
          break;
        }

        case 'ow_join': {
          const _ojNow = Date.now();
          if (_ojNow - _rl.owJoin < RATE_OW_JOIN_MIN_MS) break;
          _rl.owJoin = _ojNow;
          if (typeof msg.regionId !== 'string') break;
          const deadEnemies = owGetDeadEnemies(zoneId);
          const currentPizzas = zonePizzaList(zoneId);
          const currentEnemies = owGetEnemySnapshot(zoneId);
          try {
            ws.send(JSON.stringify({
              t: 'ow_dead_enemies',
              regionId: msg.regionId,
              deadEnemies,
              pizzas: currentPizzas,
              enemies: currentEnemies,
            }));
          } catch (_) {}
          break;
        }

        case 'set_region': {
          // Client reports which region map they're currently in (e.g. 'na', 'eu', null for world)
          const srZone = sim.getZoneForAccount(accountId);
          const srEntity = srZone ? srZone.entities.get(entityId) : null;
          if (srEntity) srEntity.rid = (typeof msg.rid === 'string' && msg.rid) ? msg.rid : null;
          break;
        }

        case 'ow_enemy_sync': {
          const _oesNow = Date.now();
          if (_oesNow - _rl.owEnemySync < RATE_OW_ENEMY_SYNC_MIN_MS) break;
          _rl.owEnemySync = _oesNow;
          if (!Array.isArray(msg.enemies) || msg.enemies.length === 0) break;
          const zone2 = sim.getZoneForAccount(accountId);
          if (zone2) {
            const capped = msg.enemies.slice(0, 100);
            // Update server snapshot so new joiners get current positions
            owUpdateEnemySnapshot(zoneId, capped);
            // AOI broadcast — only nearby players receive this
            const owSyncPayload = JSON.stringify({ t: 'ow_enemy_sync', enemies: capped });
            const nearby = zone2.getPlayersNearEntity(entityId);
            for (const { ws: pws } of nearby) {
              if (pws.readyState !== 1) continue;
              try { pws.send(owSyncPayload); } catch {}
            }
          }
          break;
        }

        case 'chat': {
          const now = Date.now();
          if (now - lastChatMs < CHAT_COOLDOWN_MS) break;
          if (typeof msg.text !== 'string') break;
          const text = msg.text.trim().substring(0, CHAT_MAX_LEN);
          if (text.length === 0) break;
          lastChatMs = now;
          const zone = sim.getZoneForAccount(accountId);
          if (!zone) break;
          const entity = zone.entities.get(entityId);
          const dn = (entity && entity.displayName) || accountId.substring(0, 8);

          if (currentLevelInstanceId) {
            // ── Inside a level room: chat is private to that room ──────────────
            // ctx = instanceId so clients can filter against their current level.
            const _lvlChatPayload = {
              t: 'chat', zone: zoneId, from: entityId, dn, text,
              ctx: currentLevelInstanceId,
            };
            if (currentRoomId !== null && currentRoomId !== undefined) {
              _lvlChatPayload.roomId = currentRoomId;
            }
            const levelChatMsg = JSON.stringify(_lvlChatPayload);
            levelRoom.broadcast(currentLevelInstanceId, _lvlChatPayload, entityId);
            try { ws.send(levelChatMsg); } catch {}
          } else {
            // ── Overworld: AOI-filtered, only physically nearby players ────────
            const chatMsg = makeChat(zone.id, entityId, dn, text); // no ctx = overworld
            const chatNearby = zone.getPlayersNearEntity(entityId);
            for (const { ws: pws, pid } of chatNearby) {
              // Skip players who are inside a building level — they have their own channel
              if (inLevelEntityIds.has(pid)) continue;
              if (pws.readyState === 1) try { pws.send(chatMsg); } catch {}
            }
            try { ws.send(chatMsg); } catch {}
          }
          break;
        }

        case 'join_level': {
          const _jlNow = Date.now();
          if (_jlNow - _rl.joinLevel < RATE_JOIN_LEVEL_MIN_MS) break;
          _rl.joinLevel = _jlNow;
          if (!isSafeString(msg.instanceId, INSTANCE_ID_MAX_LEN)) break;
          // Leave any previous room first
          if (currentLevelInstanceId && currentLevelInstanceId !== msg.instanceId) {
            const prevHostId = levelRoom.leaveRoom(currentLevelInstanceId, entityId);
            levelRoom.broadcast(currentLevelInstanceId, {
              t: 'level_player_leave',
              instanceId: currentLevelInstanceId,
              entityId,
              newHostId: prevHostId || null
            }, entityId);
          }
          currentLevelInstanceId = msg.instanceId;
          if (entityId) inLevelEntityIds.add(entityId);
          const zone = sim.getZoneForAccount(accountId);
          const entity = zone ? zone.entities.get(entityId) : null;
          const dn = (entity && entity.displayName) || accountId.substring(0, 8);
          const joinResult = levelRoom.joinRoom(msg.instanceId, entityId, ws, dn);
          // Reply to the joiner: include host flag, item state, existing members,
          // and the list of enemies already killed today so they load dead.
          try {
            ws.send(JSON.stringify({
              t: 'level_joined',
              instanceId: msg.instanceId,
              isHost: joinResult.isHost,
              items: joinResult.items,
              members: joinResult.existingMembers,   // [{entityId, displayName}]
              deadEnemies: joinResult.deadEnemies    // [enemyId, ...]
            }));
          } catch (_) {}
          // Announce arrival to existing room members
          levelRoom.broadcast(msg.instanceId, {
            t: 'level_player_join',
            instanceId: msg.instanceId,
            entityId,
            displayName: dn
          }, entityId);
          // Ask existing members to immediately re-broadcast their position so the
          // new joiner gets everyone's location on the very next frame.
          levelRoom.broadcast(msg.instanceId, {
            t: 'level_pos_request',
            instanceId: msg.instanceId,
            forEntityId: entityId    // the new joiner who needs positions
          }, entityId);
          break;
        }

        case 'leave_level': {
          if (typeof msg.instanceId !== 'string') break;
          if (currentLevelInstanceId === msg.instanceId) {
            currentLevelInstanceId = null;
            currentRoomId = null;
            if (entityId) inLevelEntityIds.delete(entityId);
          }
          const newHostId = levelRoom.leaveRoom(msg.instanceId, entityId);
          // Notify remaining members of departure (and new host if changed)
          levelRoom.broadcast(msg.instanceId, {
            t: 'level_player_leave',
            instanceId: msg.instanceId,
            entityId,
            newHostId: newHostId || null
          }, entityId);
          break;
        }

        case 'level_pos': {
          if (typeof msg.instanceId !== 'string') break;
          // Relay position to all room members except sender
          const levelPosMsg = {
            t: 'level_pos',
            instanceId: msg.instanceId,
            entityId,
            px: msg.px,
            py: msg.py,
            facing: msg.facing,
            atkPhase: msg.atkPhase,
            tid: msg.tid
          };
          if (msg.roomId !== undefined && msg.roomId !== null) {
            levelPosMsg.roomId = msg.roomId;
            currentRoomId = msg.roomId; // keep server in sync with client's current room
          }
          levelRoom.broadcast(msg.instanceId, levelPosMsg, entityId);
          break;
        }

        case 'level_enemy_sync': {
          if (typeof msg.instanceId !== 'string') break;
          // Relay host enemy positions to all non-host room members
          levelRoom.broadcast(msg.instanceId, {
            t: 'level_enemy_sync',
            instanceId: msg.instanceId,
            enemies: Array.isArray(msg.enemies) ? msg.enemies : []
          }, entityId);
          break;
        }

        case 'level_sync': {
          if (typeof msg.instanceId !== 'string') break;

          const kills = Array.isArray(msg.kills) ? msg.kills.slice(0, 50) : [];

          // Record kills server-side so late-joiners get a dead enemy list
          if (kills.length > 0) {
            levelRoom.killEnemies(msg.instanceId, kills);
          }

          const syncPayload = {
            t: 'level_sync',
            instanceId: msg.instanceId,
            kills
          };

          // Relay damage hits so all clients (including the host) can apply guest
          // damage and HP bars stay consistent. hits = [{id, hp}] after damage applied.
          if (Array.isArray(msg.hits) && msg.hits.length > 0) {
            syncPayload.hits = msg.hits.slice(0, 50);
          }

          // Item pickup: only the room host can claim items
          if (msg.item && typeof msg.item.id === 'string' &&
              levelRoom.getHostId(msg.instanceId) === entityId) {
            const taken = levelRoom.takeItem(msg.instanceId, msg.item.id, entityId);
            if (taken) {
              syncPayload.item = { id: msg.item.id, takenBy: entityId, takenAtDay: taken.takenAtDay };
            }
          }

          // Broadcast to all members except sender (sender already applied locally)
          levelRoom.broadcast(msg.instanceId, syncPayload, entityId);
          break;
        }

        case 'technodrone_enter': {
          // Client requests to drive the technodrone
          if (technodroneState.driverId) {
            try { ws.send(JSON.stringify({ t: 'technodrone_denied', reason: 'already_driven' })); } catch {}
            break;
          }
          const emailNorm = (accountEmail || '').toLowerCase();
          if (!config.TECHNODROME_ALLOWED_EMAILS.includes(emailNorm)) {
            try { ws.send(JSON.stringify({ t: 'technodrone_denied', reason: 'not_allowed' })); } catch {}
            break;
          }
          // First time: use position from client (building's current world position)
          if (technodroneState.x == null && isSafeNumber(msg.x) && isSafeNumber(msg.y)) {
            technodroneState.x = msg.x;
            technodroneState.y = msg.y;
          }
          technodroneState.driverId = entityId;
          technodroneState.driverAccountId = accountId;
          if (typeof msg.dir === 'string') technodroneState.direction = msg.dir;
          try {
            ws.send(JSON.stringify({
              t: 'technodrone_ok',
              x: technodroneState.x, y: technodroneState.y,
              dir: technodroneState.direction
            }));
          } catch {}
          broadcastTechnodroneState(ws);
          console.log(`[technodrone] ${entityId} entered at (${technodroneState.x}, ${technodroneState.y})`);
          break;
        }

        case 'technodrone_park': {
          if (technodroneState.driverId && technodroneState.driverId !== entityId) break;
          if (isSafeNumber(msg.x)) technodroneState.x = msg.x;
          if (isSafeNumber(msg.y)) technodroneState.y = msg.y;
          const VALID_DIRS = new Set(['up', 'down', 'left', 'right', 'n', 's', 'e', 'w']);
          if (typeof msg.dir === 'string' && VALID_DIRS.has(msg.dir)) technodroneState.direction = msg.dir;
          technodroneState.driverId = null;
          technodroneState.driverAccountId = null;
          broadcastTechnodroneState(null);
          console.log(`[technodrone] parked at (${technodroneState.x}, ${technodroneState.y})`);
          break;
        }

        case 'pizza_spawn': {
          const _psNow = Date.now();
          if (_psNow - _rl.pizza < RATE_PIZZA_MIN_MS) break;
          _rl.pizza = _psNow;
          // Validate the pizza object before trusting it.
          if (!msg.pizza || !isSafeString(msg.pizza.id, 128)) break;
          if (!isSafeNumber(msg.pizza.x) || !isSafeNumber(msg.pizza.y)) break;
          // Only store fields we recognise; discard any extra client data.
          const safePizza = { id: msg.pizza.id, x: msg.pizza.x, y: msg.pizza.y };
          if (typeof msg.pizza.type === 'string') safePizza.type = msg.pizza.type.substring(0, 32);
          const zone3 = sim.getZoneForAccount(accountId);
          if (zone3) {
            zonePizzaAdd(zoneId, safePizza);
            const pizzaPayload = JSON.stringify({ t: 'pizza_spawn', pizza: safePizza });
            broadcastToZone(zone3, pizzaPayload, ws);
          }
          break;
        }

        case 'pizza_collect': {
          // Type-check id strictly to prevent non-string keys from corrupting the Map.
          if (!isSafeString(msg.id, 128)) break;
          const zone4 = sim.getZoneForAccount(accountId);
          if (zone4) {
            zonePizzaCollect(zoneId, msg.id);
            const collectPayload = JSON.stringify({ t: 'pizza_collect', id: msg.id });
            broadcastToZone(zone4, collectPayload, ws);
          }
          break;
        }

        case 'ping':
          alive = true;
          try { ws.send(JSON.stringify({ t: 'pong' })); } catch {}
          break;

        default:
          break;
      }
    });

    function handleTransfer(ws, msg) {
      const toZoneId = msg.to;

      if (typeof toZoneId !== 'string' || !isValidZoneId(toZoneId)) {
        try { ws.send(makeError('TRANSFER_INVALID_ZONE', 'invalid zone id: ' + toZoneId, false)); } catch {}
        return;
      }

      if (toZoneId === zoneId) {
        try { ws.send(makeError('TRANSFER_FAILED', 'already in zone', false)); } catch {}
        return;
      }

      // Directory validation: target must exist and routing rules must pass.
      const routeCheck = zoneDir.validateTransferRoute(zoneId, toZoneId);
      if (!routeCheck.ok) {
        try { ws.send(makeError(routeCheck.code, routeCheck.msg, false)); } catch {}
        return;
      }

      // Region → Level entrance gating: entity must be on entrance tile.
      const entity = sim.getEntityForAccount(accountId);
      const entranceCheck = zoneDir.checkEntranceEligibility(
        zoneId, toZoneId, entity ? entity.x : -1, entity ? entity.y : -1
      );
      if (!entranceCheck.ok) {
        try { ws.send(makeError(entranceCheck.code, entranceCheck.msg, false)); } catch {}
        return;
      }

      const fromZoneId = zoneId;
      transferring = true;

      // Presence phase invariant:
      //   begin_sent  -> presence.zoneId == source (entity not yet moved)
      //   commit_sent -> presence.zoneId == destination (LOCKED, must not revert)
      //   snapshot_sent -> presence.zoneId == destination
      // On close, only begin_sent forces presence back to source.
      pendingTransfer = { from: fromZoneId, to: toZoneId, phase: 'begin_sent' };

      try { ws.send(makeTransferBegin(fromZoneId, toZoneId, 'enter_region')); } catch {}

      const result = sim.transferPlayer(entityId, fromZoneId, toZoneId);
      if (!result) {
        transferring = false;
        pendingTransfer = null;
        try { ws.send(makeError('TRANSFER_FAILED', 'transfer failed', false)); } catch {}
        return;
      }

      entityId = result.entity.id;
      zoneId = toZoneId;
      pendingTransfer.phase = 'commit_sent';

      // Apply entrance facing if region→level transfer provided one.
      if (entranceCheck.entrance && entranceCheck.entrance.facing) {
        result.entity.facing = entranceCheck.entrance.facing;
      }

      try { ws.send(makeTransferCommit(toZoneId, entityId, accountId)); } catch {}

      const snap = result.newZone.buildSnapshotFor();
      const tBounds = { w: result.newZone.boundsW, h: result.newZone.boundsH };
      const tColl = result.newZone.collisionDescriptor;
      try { ws.send(makeSnapshot(sim.tickCount, toZoneId, snap, result.entity.lastSeq, tBounds, tColl)); } catch {}

      pendingTransfer.phase = 'snapshot_sent';

      const transferSnap = wireSnapshot(result.entity);
      // AOI-filtered: only announce arrival to players near the transfer destination.
      const transferNearby = result.newZone.getPlayersNearEntity(entityId);
      for (const { pid, ws: pws } of transferNearby) {
        const recipEntity = result.newZone.getEntity(pid);
        const ack = recipEntity ? recipEntity.lastSeq : 0;
        try { pws.send(makeDelta(sim.tickCount, toZoneId, [transferSnap], [], ack)); } catch {}
      }

      transferring = false;
      pendingTransfer = null;
      console.log(`[ws] ${entityId} transferred ${fromZoneId} -> ${toZoneId}`);
    }

    function handleSpawnPos(msg) {
      // Only allowed when the server flag is enabled (disabled in production).
      if (!config.ALLOW_WORLD_LEVEL_TELEPORT) {
        try { ws.send(JSON.stringify({ t: 'event', event: 'spawn_ack', ok: false, reason: 'forbidden' })); } catch {}
        return;
      }
      try {
        if (!isSafeNumber(msg.x) || !isSafeNumber(msg.y)) {
          try { ws.send(JSON.stringify({ t: 'event', event: 'spawn_ack', ok: false, reason: 'bad_xy' })); } catch {}
          return;
        }
        const zone = sim.getZoneForAccount(accountId);
        if (!zone) {
          try { ws.send(JSON.stringify({ t: 'event', event: 'spawn_ack', ok: false, reason: 'no_zone' })); } catch {}
          return;
        }
        const teleOk = zone.teleportEntity(accountId, msg.x, msg.y);

        const entity = sim.getEntityForAccount(accountId);
        const visiblePlayers = zone.getVisibleSnapshots(entityId);
        const allPlayers = entity ? [wireSnapshot(entity), ...visiblePlayers] : visiblePlayers;
        const bounds = { w: zone.boundsW, h: zone.boundsH };
        const collision = zone.collisionDescriptor;
        ws.send(makeSnapshot(sim.tickCount, zoneId, allPlayers, entity ? entity.lastSeq : 0, bounds, collision));

        ws.send(JSON.stringify({ t: 'event', event: 'spawn_ack', ok: true, teleOk: teleOk, pos: { x: entity ? entity.x : -1, y: entity ? entity.y : -1 }, players: allPlayers.length }));
        console.log('[ws] ' + entityId + ' spawn_pos -> (' + msg.x + ',' + msg.y + ') teleOk=' + teleOk + ' snapshot=' + allPlayers.length);
      } catch (err) {
        console.error('[ws] spawn_pos CRASH:', err);
        // Do not expose internal error details to the client.
        try { ws.send(JSON.stringify({ t: 'event', event: 'spawn_ack', ok: false, reason: 'error' })); } catch {}
      }
    }

    function handleCollisionRequest(ws, msg) {
      const zone = sim.getZoneForAccount(accountId);
      if (!zone) return;
      const desc = zone.collisionDescriptor;
      if (!desc) return;
      try { ws.send(makeCollisionFull(zone.id, desc)); } catch {}
    }

    ws.on('close', (code, reason) => {
      console.log(`[ws] CLOSE: ${entityId || 'unknown'} (${accountId || 'none'}) code=${code} reason=${reason || 'none'} instance=${require('../config').INSTANCE_ID}`);
      clearInterval(pingInterval);
      clearTimeout(authTimer);
      if (accountId) {
        if (connByAccount.get(accountId) === ws) {
          connByAccount.delete(accountId);
        }

        // Phase-aware presence zone determination.
        // If close happens during transfer:
        //   begin_sent (before entity move): presence stays source (entity still in source)
        //   commit_sent or snapshot_sent: presence is destination (entity moved)
        // In practice, transferEntity is synchronous so begin_sent means entity
        // hasn't moved yet. After transferEntity, phase is commit_sent and
        // presence was already updated by addEntity. This explicit check
        // future-proofs against async transfers.
        if (pendingTransfer && pendingTransfer.phase === 'begin_sent') {
          presence.update(accountId, {
            zoneId: pendingTransfer.from,
            x: 0, y: 0, facing: 's', spriteRef: 'base:van',
          });
        }

        const zone = sim.getZoneForAccount(accountId);
        // Capture AOI neighbors BEFORE removePlayer strips the entity from the grid.
        const nearbyBeforeLeave = (zone && entityId) ? zone.getPlayersNearEntity(entityId) : [];
        sim.removePlayer(accountId);

        if (zone && entityId) {
          for (const { pid, ws: pws } of nearbyBeforeLeave) {
            const recipEntity = zone.getEntity(pid);
            const ack = recipEntity ? recipEntity.lastSeq : 0;
            try { pws.send(makeDelta(sim.tickCount, zone.id, [], [entityId], ack)); } catch {}
          }
        }

        // Auto-park technodrone if this was the driver
        if (entityId) autoParktechnodrone(entityId);

        // No region host to clean up — all clients are equal peers.

        // Clean up any level room memberships on disconnect
        if (entityId && currentLevelInstanceId) {
          const newHostId = levelRoom.leaveRoom(currentLevelInstanceId, entityId);
          levelRoom.broadcast(currentLevelInstanceId, {
            t: 'level_player_leave',
            instanceId: currentLevelInstanceId,
            entityId,
            newHostId: newHostId || null
          }, entityId);
          currentLevelInstanceId = null;
          currentRoomId = null;
          inLevelEntityIds.delete(entityId);
        }

        console.log(`[ws] ${entityId} (${accountId}) left`);
      }
    });

    ws.on('error', (err) => {
      console.error(`[ws] error for ${entityId || 'unknown'}:`, err.message);
    });
  });

  console.log('[ws] server initialized');
}

function fatalCodeOffset(code) {
  switch (code) {
    case 'VERSION_MISMATCH': return 1;
    case 'AUTH_REQUIRED': return 2;
    case 'ZONE_INVALID': return 3;
    case 'ZONE_NOT_FOUND': return 4;
    case 'REPLACED_BY_NEW_CONNECTION': return 5;
    default: return 0;
  }
}

function errorMsgFor(code, msg) {
  switch (code) {
    case 'VERSION_MISMATCH':
      return `Server requires v${PROTOCOL_VERSION}, got v${msg.v}`;
    case 'AUTH_REQUIRED':
      return 'Missing or invalid token in hello';
    case 'ZONE_INVALID':
      return `Invalid zone format: ${msg.zone}`;
    default:
      return 'Invalid hello message';
  }
}

// ── Zone-wide player directory broadcast ─────────────────────────────────────
// Every 5 seconds, send every authenticated client a lightweight list of ALL
// other players in their zone (id, px, py, displayName). This is not AOI-
// filtered so players always know where to find each other, even across the map.
setInterval(() => {
  // Group all authenticated connections by zoneId
  const zoneMap = new Map(); // zoneId -> [{id, px, py, dn}]
  for (const [acctId, ws] of connByAccount) {
    const entity = sim.getEntityForAccount(acctId);
    if (!entity) continue;
    const zid = entity.zoneId || sim.DEFAULT_ZONE;
    if (!zoneMap.has(zid)) zoneMap.set(zid, []);
    zoneMap.get(zid).push({
      id: entity.id,
      px: entity.px,
      py: entity.py,
      dn: entity.displayName || '',
      rid: entity.rid || null
    });
  }
  // Send each client the list of everyone else in their zone
  for (const [acctId, ws] of connByAccount) {
    if (ws.readyState !== 1) continue;
    const entity = sim.getEntityForAccount(acctId);
    if (!entity) continue;
    const zid = entity.zoneId || sim.DEFAULT_ZONE;
    const all = zoneMap.get(zid) || [];
    const others = all.filter(p => p.id !== entity.id);
    if (others.length === 0) continue;
    try {
      const zpMsg = { t: 'zone_players', players: others };
      if (technodroneState.x != null) {
        zpMsg.technodrone = {
          x: technodroneState.x, y: technodroneState.y,
          dir: technodroneState.direction,
          active: technodroneState.driverId !== null,
          driverId: technodroneState.driverId
        };
      }
      ws.send(JSON.stringify(zpMsg));
    } catch (_) {}
  }
}, 5000);

module.exports = { initWsServer, connByAccount };
