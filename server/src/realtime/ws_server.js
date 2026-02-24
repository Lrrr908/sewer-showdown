const config = require('../config');
const { verifyToken } = require('../auth/auth_tokens');
const { isValidZoneId } = require('../zones/zone_id');
const presence = require('../zones/presence');
const zoneDir = require('../zones/zone_directory');
const {
  PROTOCOL_VERSION,
  parseMessage, validateHello, validateInput, validateAction, validateUgcSubmit,
  makeHelloOk, makeSnapshot, makeDelta, makeError, makeUgcUpdate,
  makeTransferBegin, makeTransferCommit, makeCollisionFull,
} = require('./messages');
const sim = require('./sim_tick');
const { wireSnapshot } = require('../zones/zone');
const ugcValidate = require('../ugc/ugc_validate');

const AUTH_TIMEOUT_MS = 5000;
const TRANSFER_IGNORE_NOTIFY_MS = 1000;
const POS_SYNC_MIN_MS = 40;

// accountId -> ws. Enforces single active connection per account.
const connByAccount = new Map();

function initWsServer(wss) {
  wss.on('connection', (ws) => {
    let authenticated = false;
    let accountId = null;
    let entityId = null;
    let zoneId = null;
    let alive = true;
    let transferring = false;
    let lastTransferIgnoreNotify = 0;
    let lastPosSyncMs = 0;

    // Phase tracking for disconnect-during-transfer safety.
    // null when no transfer active; { from, to, phase } during transfer.
    // phase: 'begin_sent' | 'commit_sent' | 'snapshot_sent'
    let pendingTransfer = null;

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
        entity.displayName = msg.dn || decoded.dn || accountId.substring(0, 8);
        authenticated = true;

        const zone = sim.getZoneForAccount(accountId);
        const visiblePlayers = zone ? zone.getVisibleSnapshots(entityId) : [];

        ws.send(makeHelloOk(entityId, accountId, zoneId, resumeResult));

        const allPlayers = [wireSnapshot(entity), ...visiblePlayers];
        const bounds = zone ? { w: zone.boundsW, h: zone.boundsH } : null;
        const collision = zone ? zone.collisionDescriptor : null;
        ws.send(makeSnapshot(sim.tickCount, zoneId, allPlayers, entity.lastSeq, bounds, collision));

        if (zone) {
          const snap = wireSnapshot(entity);
          for (const [pid, pws] of zone.conns) {
            if (pid !== entityId && pws.readyState === 1) {
              const recipEntity = zone.getEntity(pid);
              const ack = recipEntity ? recipEntity.lastSeq : 0;
              try { pws.send(makeDelta(sim.tickCount, zoneId, [snap], [], ack)); } catch {}
            }
          }
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
        case 'input':
          if (validateInput(msg)) {
            sim.applyInput(accountId, msg);
          } else {
            try { ws.send(makeError('INPUT_INVALID', 'bad input payload', false)); } catch {}
          }
          break;

        case 'pos_sync': {
          const now = Date.now();
          if (now - lastPosSyncMs < POS_SYNC_MIN_MS) break;
          lastPosSyncMs = now;
          if (typeof msg.px === 'number' && typeof msg.py === 'number') {
            const zone = sim.getZoneForAccount(accountId);
            if (zone) zone.posSync(accountId, msg.px, msg.py, msg.facing, msg.mode, msg.tid, msg.vpx, msg.vpy, msg.vf);
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
                  for (const [, pws] of zone.conns) {
                    if (pws.readyState === 1) {
                      try { pws.send(ugcMsg); } catch {}
                    }
                  }
                }
              }
            } catch (e) {
              ws.send(JSON.stringify({ t: 'ugc_result', v: PROTOCOL_VERSION, ok: false, error: e.message }));
            }
          } else {
            try { ws.send(makeError('MESSAGE_INVALID', 'bad ugc_submit payload', false)); } catch {}
          }
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
      for (const [pid, pws] of result.newZone.conns) {
        if (pid !== entityId && pws.readyState === 1) {
          const recipEntity = result.newZone.getEntity(pid);
          const ack = recipEntity ? recipEntity.lastSeq : 0;
          try { pws.send(makeDelta(sim.tickCount, toZoneId, [transferSnap], [], ack)); } catch {}
        }
      }

      transferring = false;
      pendingTransfer = null;
      console.log(`[ws] ${entityId} transferred ${fromZoneId} -> ${toZoneId}`);
    }

    function handleSpawnPos(msg) {
      try {
        if (typeof msg.x !== 'number' || typeof msg.y !== 'number') {
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
        try { ws.send(JSON.stringify({ t: 'event', event: 'spawn_ack', ok: false, reason: 'crash', err: err.message })); } catch {}
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
        sim.removePlayer(accountId);

        if (zone && entityId) {
          for (const [pid, pws] of zone.conns) {
            if (pws.readyState === 1) {
              const recipEntity = zone.getEntity(pid);
              const ack = recipEntity ? recipEntity.lastSeq : 0;
              try { pws.send(makeDelta(sim.tickCount, zone.id, [], [entityId], ack)); } catch {}
            }
          }
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

module.exports = { initWsServer, connByAccount };
