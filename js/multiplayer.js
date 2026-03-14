// multiplayer.js — Client-side WS manager, auth, input sender, UGC cache.
// Provides window.MP. Loaded before game.js.
// Movement reconciliation: client prediction + server authority + render smoothing.

var MP = (function () {
    'use strict';

    // Auto-detect server URL: production uses the Render service, local uses localhost
    var _serverHost = (window.SS_SERVER_HOST ||
        (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'
            ? 'sewer-showdown-server.onrender.com'
            : 'localhost:3000'));
    var _isSecure = location.protocol === 'https:' || _serverHost.indexOf('.onrender.com') !== -1;
    var WS_URL = (_isSecure ? 'wss://' : 'ws://') + _serverHost + '/ws';
    var API_URL = (_isSecure ? 'https://' : 'http://') + _serverHost;
    var PROTOCOL_VERSION = 1;
    var DEFAULT_ZONE = 'world:na';
    var MAX_RECONNECT_DELAY = 30000;
    var TILE_SIZE = 64; // synced from game via setTileSize; default matches game.js
    var SNAP_DIST_PX = 64;
    var SMOOTH_FACTOR = 0.35;

    var ws = null;
    var _keepaliveTimer = null;
    var connected = false;
    var authenticated = false;
    var token = localStorage.getItem('ss_token') || null;
    var userId = null;
    var displayName = null;
    var isGuest = false;
    var entityId = null;
    var inputSeq = 0;
    var reconnectTimer = null;
    var reconnectDelay = 500;
    var currentZone = localStorage.getItem('ss_last_zone') || DEFAULT_ZONE;
    var serverInfo = null;
    var inputFrozen = false;
    var lastResumeResult = null;

    var remotePlayers = {};
    // Last-seen positions for players that left our AOI (so arrows keep showing)
    // id -> { px, py, displayName, _lastSeen: timestamp }
    var _lastSeenPos = {};
    var _LAST_SEEN_TTL = 5 * 60 * 1000; // keep ghost arrows for 5 minutes
    var selfPlayer = null;
    var serverTick = 0;

    // --- Prediction state ---
    var pendingInputs = [];
    var lastAckSeq = 0;
    var predTile = { x: 0, y: 0 };
    var authTile = { x: 0, y: 0 };
    var zoneBounds = { w: 200, h: 120 };

    // --- Render state ---
    var localRenderPx = { x: 0, y: 0 };
    var remoteRenderPx = {};

    // --- Collision state ---
    // collisionGrid: decoded 2D array for current zone (null = blind mode).
    // collisionHash: hash of current grid for cache key.
    var collisionGrid = null;
    var collisionHash = null;
    var pendingSpawnPos = null;
    var _lastPosSyncTime = 0;
    var POS_SYNC_INTERVAL_MS = 100;
    var _lastSentPx = -9999;
    var _lastSentPy = -9999;
    var _lastSentFacing = '';
    var POS_SEND_THRESHOLD = 2;

    var ugcCache = {};

    // --- Enemy sync state ---
    // Outgoing: kills/hits/shots queued by game, flushed on timer or immediately for kills.
    var _outKills = [];
    var _outHits  = [];
    var _outShots = [];
    var _outAtks  = [];   // turtle attack-fired events
    var _enemySyncLastFlush = 0;
    var _ENEMY_SYNC_FLUSH_MS = 120;  // max 8 hit batches/sec

    // Incoming: queued from server, drained each game frame.
    // Each event type has its own queue so consumers don't steal each other's data.
    var _inEnemySyncs = [];  // {kills, hits} — drained by updateRegionEnemies
    var _inShotSyncs  = [];  // flat shot objects — drained by updateVanProjectiles
    var _inAtkSyncs   = [];  // flat atk objects  — drained by _processRemoteAtks

    // --- Level room state ---
    var _levelRoomId      = null;   // current instance ID while in a level
    var _isLevelHost      = false;  // true if this client is the room host
    var _levelRemotes     = {};     // entityId -> { px, py, facing, atkPhase, atkTimer, tid, frame, displayName }
    var _inLevelJoins     = [];     // [{entityId, displayName}]
    var _inLevelLeaves    = [];     // [entityId]
    var _inLevelPos       = [];     // [{entityId, px, py, facing, atkPhase, tid}]
    var _inLevelSyncs     = [];     // [{kills, item}]
    var _inLevelItemState = null;   // item snapshot received on join
    var _inLevelDeadEnemies = null; // [enemyId] list received on join
    var _inLevelEnemySyncs = [];    // [{id,x,y,hp,s,fd}] host→non-host enemy positions
    var _lastLevelPosSend = 0;
    var _LEVEL_POS_MS = 100;        // throttle: send position max 10 times/sec

    // Overworld enemy sync
    var _inOwDeadEnemies  = null;   // [enemyId] received from server after ow_join
    var _inOwEnemySyncs   = [];     // [{id,x,y,s}] positions from nearby players

    var onHelloOk = null;
    var onSnapshot = null;
    var onDelta = null;
    var onEvent = null;
    var onUgcUpdate = null;
    var onAuthChange = null;
    var onTransferBegin = null;
    var onTransferCommit = null;
    var onChatReceived = null;

    var chatBubbles = {};
    var CHAT_MAX_LEN = 60;

    // --- Prediction helpers ---

    function clampTile(val, bound) {
        if (val < 0) return 0;
        if (val >= bound) return bound - 1;
        return val;
    }

    function blockedAt(x, y) {
        if (!collisionGrid) return false;
        if (x < 0 || y < 0 || x >= zoneBounds.w || y >= zoneBounds.h) return true;
        return collisionGrid[y] && collisionGrid[y][x] === 1;
    }

    // Axis normalization: no diagonals. If both non-zero, X wins.
    function normalizeDxDy(dx, dy) {
        if (dx !== 0 && dy !== 0) return { dx: dx, dy: 0 };
        return { dx: dx, dy: dy };
    }

    function applyPredMove(dx, dy) {
        var norm = normalizeDxDy(dx, dy);
        var nx = clampTile(predTile.x + norm.dx, zoneBounds.w);
        var ny = clampTile(predTile.y + norm.dy, zoneBounds.h);
        if (!blockedAt(nx, ny)) {
            predTile.x = nx;
            predTile.y = ny;
        }
    }

    function processAck(ackSeq) {
        if (typeof ackSeq !== 'number') return;
        if (ackSeq <= lastAckSeq) return;
        lastAckSeq = ackSeq;
        while (pendingInputs.length > 0 && pendingInputs[0].seq <= lastAckSeq) {
            pendingInputs.shift();
        }
    }

    function replayPending() {
        predTile.x = authTile.x;
        predTile.y = authTile.y;
        for (var i = 0; i < pendingInputs.length; i++) {
            var inp = pendingInputs[i];
            var norm = normalizeDxDy(inp.dx, inp.dy);
            var nx = clampTile(predTile.x + norm.dx, zoneBounds.w);
            var ny = clampTile(predTile.y + norm.dy, zoneBounds.h);
            if (!blockedAt(nx, ny)) {
                predTile.x = nx;
                predTile.y = ny;
            }
        }
    }

    function reconcile(authX, authY, ack) {
        authTile.x = authX;
        authTile.y = authY;
        if (ack) processAck(ack.seq);
        replayPending();
    }

    function resetPredictionState() {
        pendingInputs = [];
        lastAckSeq = 0;
        predTile.x = 0;
        predTile.y = 0;
        authTile.x = 0;
        authTile.y = 0;
        localRenderPx.x = 0;
        localRenderPx.y = 0;
        remoteRenderPx = {};
    }

    // --- Collision grid decode (bitset_rle) ---

    function decodeBitsetRle(base64, w, h) {
        var raw = atob(base64);
        var buf = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
        if (buf.length === 0) return null;

        var pos = 0;
        var startBit = buf[pos++] & 1;
        var total = w * h;
        var grid = [];
        for (var y = 0; y < h; y++) grid[y] = new Uint8Array(w);

        var bitIdx = 0;
        var currentBit = startBit;

        while (bitIdx < total && pos < buf.length) {
            var runLen = 0;
            var shift = 0;
            var b;
            do {
                b = buf[pos++];
                runLen |= (b & 0x7F) << shift;
                shift += 7;
            } while ((b & 0x80) && pos < buf.length);

            var end = Math.min(bitIdx + runLen, total);
            if (currentBit === 1) {
                for (var k = bitIdx; k < end; k++) {
                    var gy = (k / w) | 0;
                    var gx = k % w;
                    grid[gy][gx] = 1;
                }
            }
            bitIdx = end;
            currentBit ^= 1;
        }

        return grid;
    }

    function applyCollision(desc) {
        if (!desc || !desc.data || desc.format !== 'bitset_rle') {
            collisionGrid = null;
            collisionHash = null;
            return;
        }
        if (desc.hash === collisionHash) return;
        collisionGrid = decodeBitsetRle(desc.data, zoneBounds.w, zoneBounds.h);
        collisionHash = desc.hash || null;
        if (collisionHash) {
            try { localStorage.setItem('ss_collision_hash_' + currentZone.replace(/:/g, '_'), collisionHash); } catch (e) {}
        }
    }

    // --- Render interpolation ---

    function interpolateToward(renderPx, targetX, targetY) {
        var dx = targetX - renderPx.x;
        var dy = targetY - renderPx.y;
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (dist >= SNAP_DIST_PX) {
            renderPx.x = targetX;
            renderPx.y = targetY;
        } else if (dist > 0.5) {
            renderPx.x += dx * SMOOTH_FACTOR;
            renderPx.y += dy * SMOOTH_FACTOR;
        }
    }

    var INTERP_DELAY_MS = 100;

    function _flushEnemySync(force) {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        if (_outKills.length === 0 && _outHits.length === 0 && _outShots.length === 0 && _outAtks.length === 0) return;
        var now = Date.now();
        if (!force && now - _enemySyncLastFlush < _ENEMY_SYNC_FLUSH_MS) return;
        _enemySyncLastFlush = now;
        ws.send(JSON.stringify({ t: 'enemy_sync', kills: _outKills, hits: _outHits, shots: _outShots, atks: _outAtks }));
        _outKills = [];
        _outHits  = [];
        _outShots = [];
        _outAtks  = [];
    }

    // Send a single "attack fired" event so remote clients can trigger the full
    // weapon animation locally from one message (mirrors the van-shot pattern).
    function sendTurtleAtk(x, y, direction, turtleId) {
        if (!ws || ws.readyState !== 1 || !authenticated || !entityId) return;
        _outAtks.push({ id: entityId, x: Math.round(x), y: Math.round(y), dir: direction || 's', tid: turtleId || 'leo', t: Date.now() });
        _flushEnemySync(true);  // fire immediately — same priority as kills
    }

    function sendVanShot(x, y, vx, vy, life) {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        _outShots.push({ x: Math.round(x), y: Math.round(y), vx: Math.round(vx), vy: Math.round(vy),
                         life: life || 1.6, t: Date.now() });
        _flushEnemySync(true);  // shots go out immediately like kills
    }

    function sendEnemyKill(enemyId, worldX, worldY) {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        _outKills.push({ id: enemyId, x: Math.round(worldX || 0), y: Math.round(worldY || 0) });
        _flushEnemySync(true);  // kills go out immediately
    }

    function sendEnemyHit(enemyId, hp) {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        // Deduplicate: keep only latest hp for same id in batch
        for (var i = 0; i < _outHits.length; i++) {
            if (_outHits[i].id === enemyId) { _outHits[i].hp = hp; return; }
        }
        _outHits.push({ id: enemyId, hp: hp });
    }

    function drainEnemySyncs() {
        if (_inEnemySyncs.length === 0) return null;
        var result = _inEnemySyncs;
        _inEnemySyncs = [];
        return result;
    }

    function drainShotSyncs() {
        if (_inShotSyncs.length === 0) return null;
        var result = _inShotSyncs;
        _inShotSyncs = [];
        return result;
    }

    function drainAtkSyncs() {
        if (_inAtkSyncs.length === 0) return null;
        var result = _inAtkSyncs;
        _inAtkSyncs = [];
        return result;
    }

    // ── Level room API ────────────────────────────────────────────────────

    function sendJoinLevel(instanceId) {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        _levelRoomId = instanceId;
        _isLevelHost = false;
        _levelRemotes = {};
        console.log('[level] joining room:', instanceId);
        ws.send(JSON.stringify({ t: 'join_level', instanceId: instanceId }));
    }

    function sendLeaveLevel(instanceId) {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        if (_levelRoomId === instanceId) {
            _levelRoomId = null;
            _isLevelHost = false;
            _levelRemotes = {};
        }
        ws.send(JSON.stringify({ t: 'leave_level', instanceId: instanceId }));
    }

    function sendLevelPos(instanceId, px, py, facing, atkPhase, tid, roomId) {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        var now = Date.now();
        if (now - _lastLevelPosSend < _LEVEL_POS_MS) return;
        _lastLevelPosSend = now;
        var msg = {
            t: 'level_pos',
            instanceId: instanceId,
            px: Math.round(px),
            py: Math.round(py),
            facing: facing || 's',
            atkPhase: atkPhase || 'IDLE',
            tid: tid || 'leo'
        };
        if (roomId !== undefined && roomId !== null) msg.roomId = roomId;
        ws.send(JSON.stringify(msg));
    }

    function sendLevelSync(instanceId, kills, itemId) {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        var payload = { t: 'level_sync', instanceId: instanceId, kills: kills || [] };
        if (itemId) payload.item = { id: itemId };
        ws.send(JSON.stringify(payload));
    }

    function drainLevelJoins() {
        if (_inLevelJoins.length === 0) return null;
        var r = _inLevelJoins; _inLevelJoins = []; return r;
    }

    function drainLevelLeaves() {
        if (_inLevelLeaves.length === 0) return null;
        var r = _inLevelLeaves; _inLevelLeaves = []; return r;
    }

    function drainLevelPos() {
        if (_inLevelPos.length === 0) return null;
        var r = _inLevelPos; _inLevelPos = []; return r;
    }

    function drainLevelSyncs() {
        if (_inLevelSyncs.length === 0) return null;
        var r = _inLevelSyncs; _inLevelSyncs = []; return r;
    }

    function drainLevelItemState() {
        var r = _inLevelItemState; _inLevelItemState = null; return r;
    }

    function drainLevelDeadEnemies() {
        var r = _inLevelDeadEnemies; _inLevelDeadEnemies = null; return r;
    }

    function sendLevelEnemySync(instanceId, enemies) {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        ws.send(JSON.stringify({ t: 'level_enemy_sync', instanceId: instanceId, enemies: enemies }));
    }

    function drainLevelEnemySyncs() {
        if (_inLevelEnemySyncs.length === 0) return null;
        var r = _inLevelEnemySyncs; _inLevelEnemySyncs = []; return r;
    }

    // ── Overworld enemy sync ─────────────────────────────────────────────────
    function sendOwJoin(regionId) {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        ws.send(JSON.stringify({ t: 'ow_join', regionId: regionId }));
    }

    function drainOwDeadEnemies() {
        var r = _inOwDeadEnemies; _inOwDeadEnemies = null; return r;
    }

    function sendOwEnemySync(enemies) {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        ws.send(JSON.stringify({ t: 'ow_enemy_sync', enemies: enemies }));
    }

    function drainOwEnemySyncs() {
        if (_inOwEnemySyncs.length === 0) return null;
        var r = _inOwEnemySyncs; _inOwEnemySyncs = []; return r;
    }

    function isLevelHost() { return _isLevelHost; }

    function getLevelRemotes() { return _levelRemotes; }

    function updateRender() {
        var localTargetX = predTile.x * TILE_SIZE;
        var localTargetY = predTile.y * TILE_SIZE;
        interpolateToward(localRenderPx, localTargetX, localTargetY);

        // Flush any pending hit-sync batches on the render timer
        _flushEnemySync(false);

        var renderTime = Date.now() - INTERP_DELAY_MS;

        for (var id in remotePlayers) {
            var rp = remotePlayers[id];
            var tpx = rp.px != null ? rp.px : rp.x * TILE_SIZE;
            var tpy = rp.py != null ? rp.py : rp.y * TILE_SIZE;

            if (!remoteRenderPx[id]) {
                remoteRenderPx[id] = { x: tpx, y: tpy };
            }

            var buf = rp._interpBuf;
            if (buf && buf.length >= 2) {
                var a = null, b = null;
                for (var bi = 0; bi < buf.length - 1; bi++) {
                    if (buf[bi].t <= renderTime && buf[bi + 1].t >= renderTime) {
                        a = buf[bi];
                        b = buf[bi + 1];
                        break;
                    }
                }
                if (a && b) {
                    var dt = b.t - a.t;
                    var frac = dt > 0 ? Math.min(1, (renderTime - a.t) / dt) : 1;
                    tpx = a.px + (b.px - a.px) * frac;
                    tpy = a.py + (b.py - a.py) * frac;
                } else if (buf && buf.length > 0) {
                    var last = buf[buf.length - 1];
                    tpx = last.px;
                    tpy = last.py;
                }
            }

            interpolateToward(remoteRenderPx[id], tpx, tpy);
        }

        for (var rid in remoteRenderPx) {
            if (!remotePlayers[rid]) delete remoteRenderPx[rid];
        }

        // Flush players whose removal grace period expired (AOI exit confirmed)
        var _now = Date.now();
        for (var _gid in remotePlayers) {
            var _grp = remotePlayers[_gid];
            if (_grp._removeAt && _now >= _grp._removeAt) {
                if (_grp.px != null || _grp.x != null) {
                    var _gRid = (_lastSeenPos[_gid] && _lastSeenPos[_gid].rid != null)
                        ? _lastSeenPos[_gid].rid : (_grp.rid || null);
                    _lastSeenPos[_gid] = {
                        px: _grp.px != null ? _grp.px : _grp.x * 64,
                        py: _grp.py != null ? _grp.py : _grp.y * 64,
                        displayName: _grp.displayName || _gid,
                        rid: _gRid,
                        _lastSeen: _now
                    };
                }
                delete remotePlayers[_gid];
                delete remoteRenderPx[_gid];
            }
        }

        // Expire stale remote players (no update for 60s = out of AOI or truly gone)
        var staleThreshold = Date.now() - 60000;
        for (var sid in remotePlayers) {
            var _srp = remotePlayers[sid];
            if (_srp._lastUpdate && _srp._lastUpdate < staleThreshold) {
                // Save last known position so the arrow keeps showing
                if (_srp.px != null || _srp.x != null) {
                    var _staleRid = (_lastSeenPos[sid] && _lastSeenPos[sid].rid != null)
                        ? _lastSeenPos[sid].rid
                        : (_srp.rid || null);
                    _lastSeenPos[sid] = {
                        px: _srp.px != null ? _srp.px : _srp.x * 64,
                        py: _srp.py != null ? _srp.py : _srp.y * 64,
                        displayName: _srp.displayName || sid,
                        rid: _staleRid,
                        _lastSeen: _srp._lastUpdate || Date.now()
                    };
                }
                delete remotePlayers[sid];
                delete remoteRenderPx[sid];
            }
        }

        // Prune ghost arrows that are older than 5 minutes
        var ghostCutoff = Date.now() - _LAST_SEEN_TTL;
        for (var gsid in _lastSeenPos) {
            if (_lastSeenPos[gsid]._lastSeen < ghostCutoff) delete _lastSeenPos[gsid];
        }
    }

    function getLastSeenPlayers() {
        var arr = [];
        for (var id in _lastSeenPos) arr.push(_lastSeenPos[id]);
        return arr;
    }

    // --- Auth ---

    function setToken(t) {
        token = t;
        if (t) {
            localStorage.setItem('ss_token', t);
            try {
                var payload = JSON.parse(atob(t.split('.')[1]));
                userId = payload.sub;
                isGuest = !!payload.is_guest;
                if (payload.dn && !displayName) displayName = payload.dn;
            } catch (e) {
                userId = null; isGuest = false;
            }
        } else {
            localStorage.removeItem('ss_token');
            userId = null; displayName = null; isGuest = false;
            entityId = null;
        }
        if (onAuthChange) onAuthChange({ token: token, userId: userId, displayName: displayName, isGuest: isGuest });
    }

    function isLoggedIn() { return !!token; }

    async function guest() {
        var resp = await fetch(API_URL + '/auth/guest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        var data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Guest login failed');
        setToken(data.token);
        displayName = data.user.displayName;
        return data;
    }

    async function register(name, email, password) {
        var resp = await fetch(API_URL + '/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName: name, email: email, password: password }),
        });
        var data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Registration failed');
        setToken(data.token);
        displayName = data.user.displayName;
        return data;
    }

    async function login(email, password) {
        var resp = await fetch(API_URL + '/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, password: password }),
        });
        var data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Login failed');
        setToken(data.token);
        displayName = data.user.displayName;
        return data;
    }

    function logout() {
        if (token) {
            fetch(API_URL + '/auth/logout', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
            }).catch(function () {});
        }
        setToken(null);
        disconnect();
    }

    // --- WebSocket ---

    function connect(zone) {
        if (ws) return;
        if (!token) return;
        currentZone = zone || currentZone || DEFAULT_ZONE;

        console.log('[mp] connecting to', WS_URL, 'zone:', currentZone);
        try { ws = new WebSocket(WS_URL); } catch (e) {
            console.warn('[mp] WS creation failed:', e.message);
            scheduleReconnect();
            return;
        }

        ws.onopen = function () {
            connected = true;
            reconnectDelay = 500;
            ws.send(JSON.stringify({
                t: 'hello', v: PROTOCOL_VERSION,
                token: token, zone: currentZone,
                resume: true,
                dn: displayName || '',
                client: { build: 'dev', ua: navigator.userAgent },
            }));
            if (_keepaliveTimer) clearInterval(_keepaliveTimer);
            _keepaliveTimer = setInterval(function() {
                if (ws && ws.readyState === 1) {
                    ws.send(JSON.stringify({ t: 'ping' }));
                }
            }, 15000);
        };

        ws.onmessage = function (evt) {
            var msg;
            try { msg = JSON.parse(evt.data); } catch (e) { return; }
            handleMessage(msg);
        };

        ws.onclose = function (evt) {
            console.warn('[mp] WS closed: code=' + evt.code + ' reason=' + (evt.reason || 'none'));
            if (_keepaliveTimer) { clearInterval(_keepaliveTimer); _keepaliveTimer = null; }
            connected = false;
            authenticated = false;
            inputFrozen = false;
            ws = null;
            scheduleReconnect();
        };

        ws.onerror = function (err) { console.warn('[mp] WS error', err); };
    }

    function disconnect() {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (ws) { ws.onclose = null; ws.close(); ws = null; }
        connected = false;
        authenticated = false;
        inputFrozen = false;
        remotePlayers = {};
        selfPlayer = null;
        entityId = null;
        resetPredictionState();
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        if (!token) return;
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            connect();
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }

    function handleMessage(msg) {
        switch (msg.t) {
            case 'hello_ok':
                authenticated = true;
                console.log('[mp] hello_ok! entityId:', msg.you ? msg.you.entityId : 'none', 'zone:', msg.you ? msg.you.zone : 'none', 'server:', JSON.stringify(msg.server || {}));
                fetch(API_URL + '/health').then(function(r){return r.json()}).then(function(d){console.log('[mp] health check: instance=' + d.instance + ' uptime=' + Math.round(d.uptime) + 's')}).catch(function(){});
                if (msg.you) {
                    entityId = msg.you.entityId;
                    currentZone = msg.you.zone || currentZone;
                    localStorage.setItem('ss_last_zone', currentZone);
                }
                if (msg.server) {
                    serverInfo = msg.server;
                }
                lastResumeResult = msg.resume || null;
                if (pendingSpawnPos) {
                    _flushSpawnPos(pendingSpawnPos.x, pendingSpawnPos.y);
                }
                if (onHelloOk) onHelloOk(msg);
                break;

            case 'snapshot':
                if (msg.zone && msg.zone !== currentZone) break;
                serverTick = msg.tick;

                if (msg.bounds) {
                    zoneBounds.w = msg.bounds.w;
                    zoneBounds.h = msg.bounds.h;
                }

                if (msg.collision) applyCollision(msg.collision);

                if (msg.ack) processAck(msg.ack.seq);

                remotePlayers = {};
                remoteRenderPx = {};
                var foundSelf = false;
                if (msg.players) {
                    for (var i = 0; i < msg.players.length; i++) {
                        var p = msg.players[i];
                        if (p.id === entityId) {
                            selfPlayer = p;
                            authTile.x = p.x;
                            authTile.y = p.y;
                            replayPending();
                            localRenderPx.x = predTile.x * TILE_SIZE;
                            localRenderPx.y = predTile.y * TILE_SIZE;
                            foundSelf = true;
                        } else {
                            if (p.dn) p.displayName = p.dn;
                            p._lastUpdate = Date.now();
                            var _spx = p.px != null ? p.px : p.x * TILE_SIZE;
                            var _spy = p.py != null ? p.py : p.y * TILE_SIZE;
                            p._interpBuf = [{ px: _spx, py: _spy, t: Date.now() }];
                            remotePlayers[p.id] = p;
                        }
                    }
                }
                if (!foundSelf && selfPlayer) {
                    replayPending();
                }
                inputFrozen = false;
                console.log('[mp] snapshot: ' + Object.keys(remotePlayers).length + ' remote players, self:', entityId);
                if (onSnapshot) onSnapshot(msg);
                break;

            case 'delta':
                if (msg.zone && msg.zone !== currentZone) break;
                serverTick = msg.tick;

                if (msg.ack) processAck(msg.ack.seq);

                if (msg.upserts) {
                    var now = Date.now();
                    for (var u = 0; u < msg.upserts.length; u++) {
                        var upd = msg.upserts[u];
                        if (upd.id === entityId) {
                            selfPlayer = upd;
                            authTile.x = upd.x;
                            authTile.y = upd.y;
                            replayPending();
                        } else {
                            var existRp = remotePlayers[upd.id];
                            if (existRp && existRp._interpBuf) {
                                upd._interpBuf = existRp._interpBuf;
                            } else {
                                upd._interpBuf = [];
                            }
                            var tpx = upd.px != null ? upd.px : upd.x * TILE_SIZE;
                            var tpy = upd.py != null ? upd.py : upd.y * TILE_SIZE;
                            upd._interpBuf.push({ px: tpx, py: tpy, t: now });
                            if (upd._interpBuf.length > 4) upd._interpBuf.shift();
                            upd._lastUpdate = now;
                            upd._removeAt = null;
                            if (upd.dn) upd.displayName = upd.dn;
                            remotePlayers[upd.id] = upd;
                        }
                    }
                }
                if (msg.removes) {
                    for (var r = 0; r < msg.removes.length; r++) {
                        var _rmId = msg.removes[r];
                        var _rmRp = remotePlayers[_rmId];
                        if (_rmRp) {
                            _rmRp._removeAt = Date.now() + 500;
                        }
                    }
                }
                if (onDelta) onDelta(msg);
                break;

            case 'enemy_sync':
                // Relay from server: another player killed/hit enemies, fired a shot, or swung a weapon.
                if (msg.zone && msg.zone !== currentZone) break;
                // Kills/hits go into the enemy queue
                if ((msg.kills && msg.kills.length > 0) || (msg.hits && msg.hits.length > 0)) {
                    _inEnemySyncs.push({ kills: msg.kills || [], hits: msg.hits || [] });
                }
                // Shots into shot queue (flat list)
                if (msg.shots && msg.shots.length > 0) {
                    for (var _msi = 0; _msi < msg.shots.length; _msi++) {
                        _inShotSyncs.push(msg.shots[_msi]);
                    }
                }
                // Turtle attacks into atk queue (flat list)
                if (msg.atks && msg.atks.length > 0) {
                    for (var _mai = 0; _mai < msg.atks.length; _mai++) {
                        _inAtkSyncs.push(msg.atks[_mai]);
                    }
                }
                break;

            case 'pos_batch':
                if (msg.zone && msg.zone !== currentZone) break;
                serverTick = msg.tick;
                if (msg.p) {
                    var now = Date.now();
                    for (var bi = 0; bi < msg.p.length; bi++) {
                        var be = msg.p[bi];
                        var bid = be[0], bpx = be[1], bpy = be[2], bf = be[3], bmode = be[4] || 'van', btid = be[5] || 'leo';
                        var bvpx = be[6], bvpy = be[7], bvf = be[8], bdn = be[9] || '', batk = be[10] || 'IDLE';
                        if (bid === entityId) continue;
                        var rp = remotePlayers[bid];
                        if (rp) {
                            rp.px = bpx;
                            rp.py = bpy;
                            rp.facing = bf;
                            rp.mode = bmode;
                            rp.tid = btid;
                            rp.vpx = bvpx != null ? bvpx : rp.vpx;
                            rp.vpy = bvpy != null ? bvpy : rp.vpy;
                            rp.vf = bvf || rp.vf;
                            if (bdn) rp.displayName = bdn;
                            rp.atk = batk;
                            if (!rp._interpBuf) rp._interpBuf = [];
                            rp._interpBuf.push({ px: bpx, py: bpy, t: now });
                            if (rp._interpBuf.length > 4) rp._interpBuf.shift();
                            rp._lastUpdate = now;
                            rp._removeAt = null;
                        } else {
                            remotePlayers[bid] = { id: bid, x: Math.floor(bpx / TILE_SIZE), y: Math.floor(bpy / TILE_SIZE), px: bpx, py: bpy, facing: bf, mode: bmode, tid: btid, vpx: bvpx, vpy: bvpy, vf: bvf, displayName: bdn, atk: batk, spriteRef: 'base:van', _interpBuf: [{ px: bpx, py: bpy, t: now }], _lastUpdate: now };
                        }
                        // Player (re)entered AOI — remove from ghost list
                        delete _lastSeenPos[bid];
                    }
                }
                if (onDelta) onDelta(msg);
                break;

            case 'transfer_begin':
                inputFrozen = true;
                remotePlayers = {};
                selfPlayer = null;
                resetPredictionState();
                collisionGrid = null;
                collisionHash = null;
                _outKills = []; _outHits = []; _outShots = []; _outAtks = []; _inEnemySyncs = []; _inShotSyncs = []; _inAtkSyncs = [];
                _inLevelJoins = []; _inLevelLeaves = []; _inLevelPos = []; _inLevelSyncs = []; _inLevelItemState = null; _inLevelDeadEnemies = null; _inLevelEnemySyncs = [];
                _inOwDeadEnemies = null; _inOwEnemySyncs = [];
                _lastSeenPos = {};
                console.log('[mp] transfer_begin:', msg.from, '->', msg.to);
                if (onTransferBegin) onTransferBegin(msg);
                break;

            case 'transfer_commit':
                currentZone = msg.zone;
                localStorage.setItem('ss_last_zone', currentZone);
                if (msg.you) {
                    entityId = msg.you.entityId;
                }
                console.log('[mp] transfer_commit: now in', currentZone);
                if (onTransferCommit) onTransferCommit(msg);
                break;

            case 'event':
                if (msg.event === 'collision_full' && msg.zone === currentZone) {
                    applyCollision(msg.collision);
                }
                if (onEvent) onEvent(msg);
                break;

            case 'ugc_update':
                if (msg.zone && msg.zone !== currentZone) break;
                if (msg.spriteRef && msg.ugcId) {
                    fetchUgcSprite(msg.ugcId, msg.spriteRef);
                }
                if (onUgcUpdate) onUgcUpdate(msg);
                break;

            case 'chat':
                if (msg.zone && msg.zone !== currentZone) break;
                if (msg.from && msg.text) {
                    var bubbleDuration = Math.max(3000, Math.min(msg.text.length * 60, 7000));
                    chatBubbles[msg.from] = {
                        text: msg.text,
                        dn: msg.dn || '',
                        expire: Date.now() + bubbleDuration
                    };
                    if (onChatReceived) onChatReceived(msg);
                }
                break;

            // ── Level room messages ──────────────────────────────────────
            case 'level_joined':
                // Server reply: we joined the room — store host flag, initial items,
                // and pre-populate _levelRemotes with players already in the room.
                if (msg.instanceId === _levelRoomId) {
                    _isLevelHost = !!msg.isHost;
                    _inLevelItemState = msg.items || {};
                    console.log('[level] level_joined isHost=' + _isLevelHost + ' existingMembers=' + (msg.members ? msg.members.length : 0) + ' deadEnemies=' + (msg.deadEnemies ? msg.deadEnemies.length : 0));
                    // Store dead enemy list so game.js can apply it
                    if (Array.isArray(msg.deadEnemies) && msg.deadEnemies.length > 0) {
                        _inLevelDeadEnemies = msg.deadEnemies;
                    }
                    // Seed level remotes with existing members so we don't wait for their next level_pos
                    if (Array.isArray(msg.members)) {
                        for (var _lmi = 0; _lmi < msg.members.length; _lmi++) {
                            var _lm = msg.members[_lmi];
                            if (_lm.entityId && _lm.entityId !== entityId && !_levelRemotes[_lm.entityId]) {
                                _levelRemotes[_lm.entityId] = {
                                    px: 0, py: 0, facing: 's',
                                    atkPhase: 'IDLE', atkTimer: 0,
                                    frame: 0, tid: 'leo',
                                    displayName: _lm.displayName || _lm.entityId,
                                    _posReceived: false   // flag: position not yet known
                                };
                                console.log('[level] pre-seeded remote player:', _lm.entityId, _lm.displayName);
                            }
                        }
                    }
                }
                break;

            case 'level_player_join':
                if (msg.entityId && msg.entityId !== entityId) {
                    console.log('[level] player joined room:', msg.entityId, msg.displayName);
                    _inLevelJoins.push({ entityId: msg.entityId, displayName: msg.displayName || msg.entityId });
                    // Force an immediate level_pos on the next frame so the new joiner
                    // gets our position right away (bypass the 100ms throttle).
                    _lastLevelPosSend = 0;
                }
                if (msg.newHostId === entityId) {
                    _isLevelHost = true;
                }
                break;

            case 'level_pos_request':
                // Server asks us to immediately re-broadcast our position (a new player just joined)
                console.log('[level] pos_request received — sending position immediately');
                _lastLevelPosSend = 0;
                break;

            case 'level_player_leave':
                if (msg.entityId) {
                    _inLevelLeaves.push(msg.entityId);
                    delete _levelRemotes[msg.entityId];
                }
                if (msg.newHostId === entityId) {
                    _isLevelHost = true;
                }
                break;

            case 'level_pos':
                if (msg.entityId && msg.entityId !== entityId) {
                    // Carry through displayName if already known (e.g. pre-seeded from level_joined)
                    var _lpDn = (_levelRemotes[msg.entityId] && _levelRemotes[msg.entityId].displayName) || null;
                    _inLevelPos.push({
                        entityId: msg.entityId,
                        px: msg.px, py: msg.py,
                        facing: msg.facing,
                        atkPhase: msg.atkPhase,
                        tid: msg.tid,
                        displayName: _lpDn,
                        roomId: (msg.roomId !== undefined) ? msg.roomId : null,
                        _posReceived: true
                    });
                }
                break;

            case 'level_sync':
                _inLevelSyncs.push({
                    kills: msg.kills || [],
                    item: msg.item || null
                });
                break;

            case 'level_enemy_sync':
                if (Array.isArray(msg.enemies)) {
                    for (var _lei = 0; _lei < msg.enemies.length; _lei++) {
                        _inLevelEnemySyncs.push(msg.enemies[_lei]);
                    }
                }
                break;

            case 'ow_dead_enemies':
                _inOwDeadEnemies = Array.isArray(msg.deadEnemies) ? msg.deadEnemies : [];
                break;

            case 'ow_enemy_sync':
                if (Array.isArray(msg.enemies)) {
                    for (var _owsei = 0; _owsei < msg.enemies.length; _owsei++) {
                        _inOwEnemySyncs.push(msg.enemies[_owsei]);
                    }
                }
                break;

            case 'zone_players':
                // Zone-wide directory: seed _lastSeenPos for every player we don't
                // already have in remotePlayers so arrows show from the very start.
                if (Array.isArray(msg.players)) {
                    var _now_zp = Date.now();
                    for (var _zpi = 0; _zpi < msg.players.length; _zpi++) {
                        var _zpp = msg.players[_zpi];
                        if (!_zpp || !_zpp.id) continue;
                        _lastSeenPos[_zpp.id] = {
                            px: _zpp.px,
                            py: _zpp.py,
                            displayName: _zpp.dn || _zpp.id,
                            rid: _zpp.rid || null,
                            _lastSeen: _now_zp
                        };
                    }
                }
                break;

            case 'error':
                console.error('[mp] SERVER ERROR:', msg.code, msg.msg, msg.fatal ? '(FATAL)' : '(non-fatal)');
                if (msg.fatal) {
                    setToken(null);
                    disconnect();
                }
                break;
        }
    }

    // --- Input ---

    function sendInput(moveX, moveY, facing) {
        if (!ws || ws.readyState !== 1 || !authenticated || inputFrozen) return;
        inputSeq++;

        pendingInputs.push({ seq: inputSeq, dx: moveX, dy: moveY, facing: facing || null });
        applyPredMove(moveX, moveY);

        ws.send(JSON.stringify({
            t: 'input', seq: inputSeq,
            move: { x: moveX, y: moveY },
            facing: facing || null,
            keys: {},
        }));
    }

    function sendSpawnPos(tileX, tileY) {
        predTile.x = tileX;
        predTile.y = tileY;
        authTile.x = tileX;
        authTile.y = tileY;
        localRenderPx.x = tileX * TILE_SIZE;
        localRenderPx.y = tileY * TILE_SIZE;
        if (!ws || ws.readyState !== 1 || !authenticated) {
            pendingSpawnPos = { x: tileX, y: tileY };
            console.log('[mp] sendSpawnPos queued (not connected yet) tile (' + tileX + ', ' + tileY + ')');
            return;
        }
        _flushSpawnPos(tileX, tileY);
    }

    function _flushSpawnPos(tileX, tileY) {
        inputSeq++;
        ws.send(JSON.stringify({ t: 'action', seq: inputSeq, action: 'spawn_pos', x: tileX, y: tileY }));
        pendingSpawnPos = null;
        console.log('[mp] sendSpawnPos sent tile (' + tileX + ', ' + tileY + ')');
    }

    var _lastSentMode = '';
    var _lastSentTurtleId = '';
    var _lastAtkSyncTime = 0;
    var _ATK_SYNC_MIN_MS = 40;

    function sendPosSync(px, py, facing, mode, turtleId, vanPx, vanPy, vanDir) {
        if (!ws || ws.readyState !== 1 || !authenticated || inputFrozen) return;
        var now = Date.now();
        if (now - _lastPosSyncTime < POS_SYNC_INTERVAL_MS) return;
        var rpx = Math.round(px);
        var rpy = Math.round(py);
        var f = facing || 's';
        var m = mode || 'van';
        var tid = turtleId || 'leo';
        var dxS = Math.abs(rpx - _lastSentPx);
        var dyS = Math.abs(rpy - _lastSentPy);
        var modeChanged = m !== _lastSentMode || tid !== _lastSentTurtleId;
        var keepalive = (now - _lastPosSyncTime) >= 2000;
        if (!keepalive && !modeChanged && dxS < POS_SEND_THRESHOLD && dyS < POS_SEND_THRESHOLD && f === _lastSentFacing) return;
        _lastPosSyncTime = now;
        _lastSentPx = rpx;
        _lastSentPy = rpy;
        _lastSentFacing = f;
        _lastSentMode = m;
        _lastSentTurtleId = tid;
        var msg = { t: 'pos_sync', px: rpx, py: rpy, facing: f, mode: m, tid: tid };
        if (m === 'foot' && vanPx != null) {
            msg.vpx = Math.round(vanPx);
            msg.vpy = Math.round(vanPy);
            msg.vf = vanDir || 's';
        }
        ws.send(JSON.stringify(msg));
    }

    // Send attack-phase sync immediately (bypasses pos-sync throttle).
    // Called when the local player starts WINDUP, transitions to ACTIVE, etc.
    function sendAtkSync(px, py, facing, mode, turtleId, atkPhase) {
        if (!ws || ws.readyState !== 1 || !authenticated || inputFrozen) return;
        var now = Date.now();
        if (now - _lastAtkSyncTime < _ATK_SYNC_MIN_MS) return;
        _lastAtkSyncTime = now;
        var f = facing || 's';
        var m = mode || 'foot';
        var msg = { t: 'pos_sync', px: Math.round(px), py: Math.round(py), facing: f, mode: m, tid: turtleId || 'leo', atk: atkPhase || 'IDLE' };
        ws.send(JSON.stringify(msg));
    }

    function sendAction(actionType, data) {
        if (!ws || ws.readyState !== 1 || !authenticated || inputFrozen) return;
        inputSeq++;
        ws.send(JSON.stringify({ t: 'action', seq: inputSeq, action: actionType, data: data || {} }));
    }

    function requestTransfer(toZoneId) {
        if (!ws || ws.readyState !== 1 || !authenticated || inputFrozen) return;
        inputSeq++;
        ws.send(JSON.stringify({ t: 'action', seq: inputSeq, action: 'transfer', to: toZoneId }));
    }

    function requestCollision() {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        inputSeq++;
        ws.send(JSON.stringify({ t: 'action', seq: inputSeq, action: 'collision_request', zone: currentZone }));
    }

    function submitUgcSprite(baseSpriteKey, width, height, rows) {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        ws.send(JSON.stringify({ t: 'ugc_submit', baseSpriteKey: baseSpriteKey, width: width, height: height, rows: rows }));
    }


    function sendChat(text) {
        if (!ws || ws.readyState !== 1 || !authenticated) return;
        if (typeof text !== 'string') return;
        text = text.trim().substring(0, CHAT_MAX_LEN);
        if (text.length === 0) return;
        ws.send(JSON.stringify({ t: 'chat', text: text }));
        var bubbleDuration = Math.max(3000, Math.min(text.length * 60, 7000));
        chatBubbles['__self__'] = { text: text, dn: displayName || '', expire: Date.now() + bubbleDuration };
    }

    function getChatBubbles() { return chatBubbles; }
    // --- UGC cache ---

    function fetchUgcSprite(ugcId, spriteRef) {
        if (ugcCache[spriteRef]) return;
        fetch(API_URL + '/ugc/sprite/' + ugcId, {
            headers: token ? { 'Authorization': 'Bearer ' + token } : {},
        }).then(function (resp) {
            if (!resp.ok) throw new Error('fetch failed');
            return resp.json();
        }).then(function (data) {
            ugcCache[spriteRef] = { w: data.w, h: data.h, rows: data.rows, meta: data.meta };
            console.log('[mp] cached UGC:', spriteRef);
        }).catch(function (e) {
            console.warn('[mp] UGC fetch failed:', e.message);
        });
    }

    // --- Rendering helpers ---

    function getRemotePlayers() {
        var arr = [];
        for (var id in remotePlayers) arr.push(remotePlayers[id]);
        return arr;
    }

    function tileToPixel(tileCoord) { return tileCoord * TILE_SIZE; }

    function drawRemotePlayers(ctx, cameraX, cameraY, drawFn) {
        var players = getRemotePlayers();
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            var rpx = remoteRenderPx[p.id];
            var px = rpx ? rpx.x : (p.x * TILE_SIZE);
            var py = rpx ? rpx.y : (p.y * TILE_SIZE);
            var sx = px - cameraX;
            var sy = py - cameraY;
            if (drawFn) {
                drawFn(ctx, p, sx, sy);
            } else {
                ctx.fillStyle = 'rgba(0, 200, 255, 0.7)';
                ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
                ctx.fillStyle = '#fff';
                ctx.font = '8px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(p.id.substring(0, 8), sx + 16, sy - 4);
            }
        }
    }

    // --- Init token from localStorage ---
    if (token) {
        try {
            var payload = JSON.parse(atob(token.split('.')[1]));
            userId = payload.sub;
            isGuest = !!payload.is_guest;
            if (payload.dn) displayName = payload.dn;
            if (payload.exp && payload.exp * 1000 < Date.now()) {
                setToken(null);
            }
        } catch (e) { setToken(null); }
    }

    return {
        connect: connect,
        disconnect: disconnect,
        isConnected: function () { return connected && authenticated; },
        wsState: function () { return ws ? ws.readyState : -1; },
        wsDebug: function () { return { connected: connected, authenticated: authenticated, wsReady: ws ? ws.readyState : -1, entityId: entityId, token: token ? token.substr(0,20) + '...' : null, remotePlayers: Object.keys(remotePlayers).length }; },
        isLoggedIn: isLoggedIn,

        guest: guest,
        register: register,
        login: login,
        logout: logout,

        sendInput: sendInput,
        sendSpawnPos: sendSpawnPos,
        sendPosSync: sendPosSync,
        sendAtkSync: sendAtkSync,
        sendTurtleAtk: sendTurtleAtk,
        sendVanShot: sendVanShot,
        sendEnemyKill: sendEnemyKill,
        sendEnemyHit: sendEnemyHit,
        drainEnemySyncs: drainEnemySyncs,
        drainShotSyncs: drainShotSyncs,
        drainAtkSyncs: drainAtkSyncs,

        // Level room
        sendJoinLevel: sendJoinLevel,
        sendLeaveLevel: sendLeaveLevel,
        sendLevelPos: sendLevelPos,
        sendLevelSync: sendLevelSync,
        drainLevelJoins: drainLevelJoins,
        drainLevelLeaves: drainLevelLeaves,
        drainLevelPos: drainLevelPos,
        drainLevelSyncs: drainLevelSyncs,
        drainLevelItemState: drainLevelItemState,
        drainLevelDeadEnemies: drainLevelDeadEnemies,
        sendLevelEnemySync: sendLevelEnemySync,
        drainLevelEnemySyncs: drainLevelEnemySyncs,
        isLevelHost: isLevelHost,
        getLevelRemotes: getLevelRemotes,

        // Overworld enemy sync
        sendOwJoin: sendOwJoin,
        drainOwDeadEnemies: drainOwDeadEnemies,
        sendOwEnemySync: sendOwEnemySync,
        drainOwEnemySyncs: drainOwEnemySyncs,

        sendAction: sendAction,
        requestTransfer: requestTransfer,
        requestCollision: requestCollision,
        submitUgcSprite: submitUgcSprite,
        sendChat: sendChat,
        getChatBubbles: getChatBubbles,

        updateRender: updateRender,

        getRemotePlayers: getRemotePlayers,
        getLastSeenPlayers: getLastSeenPlayers,
        sendRegion: function(rid) {
            if (ws && ws.readyState === 1) {
                try { ws.send(JSON.stringify({ t: 'set_region', rid: rid || null })); } catch (_) {}
            }
        },
        drawRemotePlayers: drawRemotePlayers,
        getSelfPlayer: function () { return selfPlayer; },
        getSelfRenderPos: function () { return { x: localRenderPx.x, y: localRenderPx.y }; },
        getSelfPredTile: function () { return { x: predTile.x, y: predTile.y }; },
        getUgcCache: function () { return ugcCache; },

        get userId() { return userId; },
        get displayName() { return displayName; },
        get isGuest() { return isGuest; },
        get entityId() { return entityId; },
        get serverTick() { return serverTick; },
        get serverInfo() { return serverInfo; },
        get currentZone() { return currentZone; },
        get isTransferring() { return inputFrozen; },
        get lastResumeResult() { return lastResumeResult; },
        get lastAckSeq() { return lastAckSeq; },
        get collisionHash() { return collisionHash; },
        get hasCollision() { return collisionGrid !== null; },

        set onHelloOk(fn) { onHelloOk = fn; },
        set onSnapshot(fn) { onSnapshot = fn; },
        set onDelta(fn) { onDelta = fn; },
        set onEvent(fn) { onEvent = fn; },
        set onUgcUpdate(fn) { onUgcUpdate = fn; },
        set onAuthChange(fn) { onAuthChange = fn; },
        set onTransferBegin(fn) { onTransferBegin = fn; },
        set onTransferCommit(fn) { onTransferCommit = fn; },
        set onChatReceived(fn) { onChatReceived = fn; },

        setTileSize: function(s) { TILE_SIZE = s; },
        getTileSize: function() { return TILE_SIZE; },
        tileToPixel: tileToPixel,

        PROTOCOL_VERSION: PROTOCOL_VERSION,
        TILE_SIZE: TILE_SIZE,
        SNAP_DIST_PX: SNAP_DIST_PX,
        SMOOTH_FACTOR: SMOOTH_FACTOR,
        CHAT_MAX_LEN: CHAT_MAX_LEN,
        WS_URL: WS_URL,
        API_URL: API_URL,

        _test: {
            clampTile: clampTile,
            blockedAt: blockedAt,
            normalizeDxDy: normalizeDxDy,
            applyPredMove: applyPredMove,
            processAck: processAck,
            replayPending: replayPending,
            reconcile: reconcile,
            interpolateToward: interpolateToward,
            decodeBitsetRle: decodeBitsetRle,
            applyCollision: applyCollision,
            get pendingInputs() { return pendingInputs; },
            set pendingInputs(v) { pendingInputs = v; },
            get lastAckSeq() { return lastAckSeq; },
            set lastAckSeq(v) { lastAckSeq = v; },
            get predTile() { return predTile; },
            set predTile(v) { predTile = v; },
            get authTile() { return authTile; },
            set authTile(v) { authTile = v; },
            get zoneBounds() { return zoneBounds; },
            set zoneBounds(v) { zoneBounds = v; },
            get collisionGrid() { return collisionGrid; },
            set collisionGrid(v) { collisionGrid = v; },
        },
    };
})();
