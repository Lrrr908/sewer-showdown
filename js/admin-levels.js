/* ================================================================
   admin-levels.js — Level Builder Tab
   Side-scrolling level editor for hand-crafted and generated levels
   ================================================================ */

(function () {
    'use strict';
    var A = Admin;
    var el = A.el;

    var TILE_TYPES = {
        0: { name: 'air',      color: '#0a0b10', solid: false },
        1: { name: 'wall',     color: '#747474', solid: true },
        2: { name: 'hazard',   color: '#a40000', solid: true },
        3: { name: 'platform', color: '#0070ec', solid: true }
    };

    var ENEMY_TYPES = ['foot', 'foot_ranged', 'foot_shield', 'foot_runner'];
    var ENEMY_COLORS = { foot: '#fc7460', foot_ranged: '#fcfc00', foot_shield: '#3cbcfc', foot_runner: '#4ade80' };

    var THEMES = ['sewer', 'street', 'dock', 'gallery'];
    var SIZES = { S: { w: 24, h: 12 }, M: { w: 36, h: 15 }, L: { w: 48, h: 18 } };

    // State
    var currentLevel = null;
    var currentLevelName = '';
    var tool = 'tile';       // 'tile', 'entity', 'select'
    var activeTileType = 1;
    var activeEntityType = 'player';
    var zoom = 24;
    var isDrawing = false;
    var history = [], historyIdx = -1;
    var scrollX = 0, scrollY = 0;
    var isPanning = false, panStart = { x: 0, y: 0 }, scrollStart = { x: 0, y: 0 };

    // DOM refs
    var canvasEl, ctx, levelList, propsPanel, statusEl, entityPalette;
    var wrapperEl;

    function init() {
        var panel = document.getElementById('tab-levels');
        panel.innerHTML = '';
        panel.style.cssText = '';

        // Left sidebar: level list
        var left = el('div', { style: { width: '220px', minWidth: '200px', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--surface)' } });
        var leftHead = el('div', { style: { padding: '8px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '6px' } });
        leftHead.appendChild(el('div', { className: 'panel-title', textContent: 'Levels' }));

        var genRow = el('div', { className: 'col', style: { gap: '4px' } });
        genRow.appendChild(el('label', { textContent: 'Generate New Level' }));
        var themeSelect = el('select', { id: 'lvlTheme' });
        THEMES.forEach(function (t) { themeSelect.appendChild(el('option', { value: t, textContent: t })); });
        genRow.appendChild(themeSelect);
        var sizeRow = el('div', { className: 'row' });
        sizeRow.appendChild(el('label', { textContent: 'Size:' }));
        var sizeSelect = el('select', { id: 'lvlSize' });
        ['S', 'M', 'L'].forEach(function (s) { sizeSelect.appendChild(el('option', { value: s, textContent: s })); });
        sizeSelect.value = 'M';
        sizeRow.appendChild(sizeSelect);
        genRow.appendChild(sizeRow);
        var seedRow = el('div', { className: 'row' });
        seedRow.appendChild(el('label', { textContent: 'Seed:' }));
        seedRow.appendChild(el('input', { type: 'text', id: 'lvlSeed', value: 'test', style: { flex: '1' } }));
        genRow.appendChild(seedRow);
        var diffRow = el('div', { className: 'row' });
        diffRow.appendChild(el('label', { textContent: 'Diff:' }));
        diffRow.appendChild(el('input', { type: 'number', id: 'lvlDiff', value: '2', min: '1', max: '5', style: { width: '50px' } }));
        genRow.appendChild(diffRow);
        genRow.appendChild(el('button', { className: 'btn small success', textContent: 'Generate', onClick: generateLevel }));
        leftHead.appendChild(genRow);
        leftHead.appendChild(el('hr'));

        var btnRow = el('div', { className: 'btn-row' });
        btnRow.appendChild(el('button', { className: 'btn small', textContent: 'New Blank', onClick: newBlankLevel }));
        btnRow.appendChild(el('button', { className: 'btn small', textContent: 'Load JSON', onClick: loadLevelFile }));
        leftHead.appendChild(btnRow);
        left.appendChild(leftHead);

        levelList = el('div', { style: { flex: '1', overflowY: 'auto', padding: '4px' } });
        left.appendChild(levelList);

        // Center: canvas
        var center = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', overflow: 'hidden' } });

        // Toolbar
        var toolbar = el('div', { style: { padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } });

        toolbar.appendChild(el('label', { textContent: 'Tool:' }));
        var toolBtns = [
            { id: 'tile', label: 'Tile Paint' },
            { id: 'entity', label: 'Entities' },
            { id: 'select', label: 'Select' }
        ];
        toolBtns.forEach(function (tb) {
            var b = el('button', { className: 'btn small' + (tool === tb.id ? ' primary' : ''), textContent: tb.label, 'data-tool': tb.id });
            b.addEventListener('click', function () {
                tool = tb.id;
                toolbar.querySelectorAll('[data-tool]').forEach(function (btn) {
                    btn.className = 'btn small' + (btn.dataset.tool === tool ? ' primary' : '');
                });
            });
            toolbar.appendChild(b);
        });

        toolbar.appendChild(el('span', { style: { width: '1px', height: '20px', background: 'var(--border)', margin: '0 4px' } }));
        toolbar.appendChild(el('label', { textContent: 'Tile:' }));
        var tileSel = el('select', { id: 'tileTypeSel' });
        Object.keys(TILE_TYPES).forEach(function (k) {
            tileSel.appendChild(el('option', { value: k, textContent: k + ' (' + TILE_TYPES[k].name + ')' }));
        });
        tileSel.value = String(activeTileType);
        tileSel.addEventListener('change', function () { activeTileType = parseInt(this.value); });
        toolbar.appendChild(tileSel);

        toolbar.appendChild(el('span', { style: { flex: '1' } }));
        toolbar.appendChild(el('label', { textContent: 'Zoom:' }));
        var zoomSel = el('select');
        [12, 16, 20, 24, 32, 40].forEach(function (z) {
            zoomSel.appendChild(el('option', { value: String(z), textContent: z + 'px' }));
        });
        zoomSel.value = String(zoom);
        zoomSel.addEventListener('change', function () { zoom = parseInt(this.value); renderCanvas(); });
        toolbar.appendChild(zoomSel);

        toolbar.appendChild(el('button', { className: 'btn small', textContent: 'Undo', onClick: undo }));
        toolbar.appendChild(el('button', { className: 'btn small', textContent: 'Redo', onClick: redo }));
        center.appendChild(toolbar);

        wrapperEl = el('div', { style: { flex: '1', overflow: 'auto', background: '#060810', position: 'relative' } });
        canvasEl = el('canvas', { style: { cursor: 'crosshair' } });
        ctx = canvasEl.getContext('2d');
        wrapperEl.appendChild(canvasEl);
        center.appendChild(wrapperEl);

        // Bottom bar
        var bottomBar = el('div', { style: { display: 'flex', gap: '8px', padding: '6px 10px', borderTop: '1px solid var(--border)', background: 'var(--surface)', alignItems: 'center' } });
        bottomBar.appendChild(el('button', { className: 'btn small success', textContent: 'Export JSON', onClick: exportLevel }));
        bottomBar.appendChild(el('button', { className: 'btn small', textContent: 'Copy JSON', onClick: copyLevel }));
        bottomBar.appendChild(el('button', { className: 'btn small primary', textContent: 'Preview in Game', onClick: previewInGame }));
        statusEl = el('div', { className: 'status-msg', style: { flex: '1' } });
        bottomBar.appendChild(statusEl);
        center.appendChild(bottomBar);

        // Right: entity palette + properties
        var right = el('div', { style: { width: '200px', minWidth: '180px', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--surface)', overflowY: 'auto' } });

        var entityHead = el('div', { style: { padding: '8px', borderBottom: '1px solid var(--border)' } });
        entityHead.appendChild(el('div', { className: 'panel-title', textContent: 'Entity Palette' }));
        right.appendChild(entityHead);

        entityPalette = el('div', { style: { padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px' } });
        var entityTypes = [
            { id: 'player', label: 'Player Spawn', color: '#4ade80' },
            { id: 'exit', label: 'Exit', color: '#fbbf24' }
        ];
        ENEMY_TYPES.forEach(function (et) {
            entityTypes.push({ id: et, label: et.replace(/_/g, ' '), color: ENEMY_COLORS[et] || '#fc7460' });
        });
        entityTypes.push({ id: 'trigger', label: 'Trigger', color: '#a855f7' });
        entityTypes.push({ id: 'art_frame', label: 'Art Frame', color: '#3cbcfc' });
        entityTypes.push({ id: 'item', label: 'Item Spawn', color: '#fcfc00' });

        entityTypes.forEach(function (et) {
            var btn = el('div', {
                style: {
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 6px', cursor: 'pointer',
                    borderRadius: '4px', border: activeEntityType === et.id ? '1px solid var(--accent)' : '1px solid transparent',
                    background: activeEntityType === et.id ? 'var(--surface2)' : 'transparent'
                }
            });
            btn.appendChild(el('div', { style: { width: '12px', height: '12px', background: et.color, borderRadius: '2px', flexShrink: '0' } }));
            btn.appendChild(el('span', { style: { fontSize: '11px' }, textContent: et.label }));
            btn.addEventListener('click', function () {
                activeEntityType = et.id;
                tool = 'entity';
                toolbar.querySelectorAll('[data-tool]').forEach(function (b) {
                    b.className = 'btn small' + (b.dataset.tool === 'entity' ? ' primary' : '');
                });
                entityPalette.querySelectorAll('div[style]').forEach(function (d) {
                    if (d.children.length === 2) {
                        d.style.border = '1px solid transparent';
                        d.style.background = 'transparent';
                    }
                });
                btn.style.border = '1px solid var(--accent)';
                btn.style.background = 'var(--surface2)';
            });
            entityPalette.appendChild(btn);
        });
        right.appendChild(entityPalette);

        right.appendChild(el('hr'));
        propsPanel = el('div', { style: { padding: '8px' } });
        propsPanel.appendChild(el('div', { className: 'panel-title', textContent: 'Properties' }));
        propsPanel.appendChild(el('div', { style: { fontSize: '11px', color: 'var(--muted)' }, textContent: 'Select a level to edit' }));
        right.appendChild(propsPanel);

        panel.appendChild(left);
        panel.appendChild(center);
        panel.appendChild(right);

        // Events
        canvasEl.addEventListener('mousedown', onCanvasDown);
        canvasEl.addEventListener('mousemove', onCanvasMove);
        canvasEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        document.addEventListener('mouseup', function () {
            if (isDrawing) { isDrawing = false; A.scheduleSave(); }
            isPanning = false;
        });

        renderLevelList();
    }

    // ── Level list ──
    function renderLevelList() {
        levelList.innerHTML = '';
        var stored = A.data.levels || {};
        var keys = Object.keys(stored);
        if (keys.length === 0) {
            levelList.appendChild(el('div', { style: { fontSize: '11px', color: 'var(--muted)', padding: '8px' }, textContent: 'No levels loaded. Generate or load one.' }));
            return;
        }
        keys.forEach(function (k) {
            var lvl = stored[k];
            var item = el('div', {
                style: {
                    padding: '6px 8px', cursor: 'pointer', borderRadius: '4px', marginBottom: '2px',
                    background: k === currentLevelName ? 'var(--surface2)' : 'transparent',
                    border: k === currentLevelName ? '1px solid var(--accent)' : '1px solid transparent'
                }
            });
            item.appendChild(el('div', { className: 'mono', style: { fontSize: '11px' }, textContent: lvl.name || k }));
            var w = lvl.world ? lvl.world.widthTiles : '?';
            var h = lvl.world ? lvl.world.heightTiles : '?';
            var enemies = (lvl.enemies || []).length;
            item.appendChild(el('div', { style: { fontSize: '10px', color: 'var(--muted)' }, textContent: w + '×' + h + ' | ' + enemies + ' enemies' }));
            item.addEventListener('click', function () { loadLevel(k, lvl); });
            levelList.appendChild(item);
        });
    }

    function loadLevel(name, lvl) {
        currentLevelName = name;
        currentLevel = JSON.parse(JSON.stringify(lvl));
        history = [];
        historyIdx = -1;
        pushHistory();
        renderLevelList();
        renderCanvas();
        renderProps();
        status('Loaded: ' + (lvl.name || name));
    }

    // ── Generate level ──
    function generateLevel() {
        var theme = document.getElementById('lvlTheme').value;
        var size = document.getElementById('lvlSize').value;
        var seed = document.getElementById('lvlSeed').value || 'test';
        var diff = parseInt(document.getElementById('lvlDiff').value) || 2;

        if (typeof generateLevelRT === 'function') {
            var lvl = generateLevelRT(theme, size, seed, diff);
            var name = theme + '_generated_' + seed;
            A.data.levels[name] = lvl;
            loadLevel(name, lvl);
            return;
        }

        // Fallback: simple procedural generation
        var S = SIZES[size] || SIZES.M;
        var W = S.w, H = S.h;
        var map = [];
        for (var y = 0; y < H; y++) {
            map[y] = new Array(W).fill(0);
            if (y === 0 || y === H - 1) map[y].fill(1);
            else { map[y][0] = 1; map[y][W - 1] = 1; }
        }
        // Floor
        map[H - 2] = new Array(W).fill(1);
        // Some platforms
        var platY = Math.floor(H * 0.5);
        for (var px = 8; px < W - 8; px += 6 + Math.floor(Math.random() * 6)) {
            var pw = 2 + Math.floor(Math.random() * 3);
            for (var pi = 0; pi < pw && px + pi < W - 1; pi++) {
                map[platY][px + pi] = 1;
            }
        }

        var lvl = {
            id: theme + '_gen_' + seed,
            name: theme.charAt(0).toUpperCase() + theme.slice(1) + ' (' + seed + ')',
            theme: theme,
            world: { widthTiles: W, heightTiles: H, tileSize: 32 },
            tilemap: map,
            tileTypes: { '0': { name: 'air', solid: false }, '1': { name: 'wall', solid: true }, '2': { name: 'hazard', solid: true }, '3': { name: 'platform', solid: true } },
            spawns: { player: { x: 2, y: H - 3 }, exit: { x: W - 3, y: H - 3 } },
            enemies: [],
            triggers: [{ type: 'door', x: W - 3, y: H - 3, target: 'REGION' }]
        };
        // Enemies based on difficulty
        var numEnemies = diff + Math.floor(Math.random() * diff);
        for (var ei = 0; ei < numEnemies; ei++) {
            var ex = 6 + Math.floor(Math.random() * (W - 12));
            lvl.enemies.push({
                type: ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)],
                x: ex, y: H - 3,
                patrol: { left: Math.max(1, ex - 3), right: Math.min(W - 2, ex + 3) }
            });
        }

        var name = lvl.id;
        A.data.levels[name] = lvl;
        loadLevel(name, lvl);
    }

    function newBlankLevel() {
        var name = prompt('Level name:', 'new_level');
        if (!name) return;
        var W = parseInt(prompt('Width (tiles):', '40')) || 40;
        var H = parseInt(prompt('Height (tiles):', '15')) || 15;
        var map = [];
        for (var y = 0; y < H; y++) {
            map[y] = new Array(W).fill(0);
            if (y === 0 || y === H - 1) map[y].fill(1);
            else { map[y][0] = 1; map[y][W - 1] = 1; }
        }
        var lvl = {
            id: name, name: name,
            world: { widthTiles: W, heightTiles: H, tileSize: 32 },
            tilemap: map,
            tileTypes: { '0': { name: 'air', solid: false }, '1': { name: 'wall', solid: true }, '2': { name: 'hazard', solid: true }, '3': { name: 'platform', solid: true } },
            spawns: { player: { x: 2, y: H - 2 }, exit: { x: W - 3, y: H - 2 } },
            enemies: [], triggers: []
        };
        A.data.levels[name] = lvl;
        loadLevel(name, lvl);
    }

    async function loadLevelFile() {
        var file = await A.promptFile('.json');
        if (!file) return;
        var text = await A.readFileAsText(file);
        var lvl = JSON.parse(text);
        var name = lvl.id || file.name.replace('.json', '');
        A.data.levels[name] = lvl;
        loadLevel(name, lvl);
        renderLevelList();
    }

    // ── Rendering ──
    function renderCanvas() {
        var dpr = window.devicePixelRatio || 1;
        if (!currentLevel || !currentLevel.tilemap) {
            canvasEl.width = Math.round(400 * dpr); canvasEl.height = Math.round(200 * dpr);
            canvasEl.style.width = '400px'; canvasEl.style.height = '200px';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = '#0a0b10';
            ctx.fillRect(0, 0, 400, 200);
            ctx.fillStyle = '#666';
            ctx.font = '14px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('No level loaded', 200, 100);
            return;
        }

        var map = currentLevel.tilemap;
        var H = map.length, W = map[0].length;
        var logW = W * zoom, logH = H * zoom;
        canvasEl.width = Math.round(logW * dpr);
        canvasEl.height = Math.round(logH * dpr);
        canvasEl.style.width = logW + 'px';
        canvasEl.style.height = logH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Use NES tile patterns if available
        var PATS = (typeof NES !== 'undefined' && NES.PATTERNS) ? NES.PATTERNS : null;
        var theme = currentLevel.theme || 'sewer';
        var floorPat = theme + 'Floor';
        var wallPat = theme + 'Wall';

        for (var y = 0; y < H; y++) {
            for (var x = 0; x < W; x++) {
                var t = map[y][x];
                var sx = x * zoom, sy = y * zoom;

                if (PATS && t === 1 && PATS[wallPat] && zoom >= 16) {
                    A.renderPattern(ctx, PATS[wallPat], sx, sy, zoom / 16);
                } else if (PATS && t === 0 && PATS[floorPat] && zoom >= 16) {
                    A.renderPattern(ctx, PATS[floorPat], sx, sy, zoom / 16);
                } else {
                    var tt = TILE_TYPES[t] || TILE_TYPES[0];
                    ctx.fillStyle = tt.color;
                    ctx.fillRect(sx, sy, zoom, zoom);
                }

                if (t === 2) {
                    ctx.fillStyle = TILE_TYPES[2].color;
                    ctx.fillRect(sx, sy, zoom, zoom);
                    ctx.strokeStyle = '#ff0';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(sx + 2, sy + zoom - 2);
                    ctx.lineTo(sx + zoom / 2, sy + 2);
                    ctx.lineTo(sx + zoom - 2, sy + zoom - 2);
                    ctx.stroke();
                }
                if (t === 3) {
                    ctx.fillStyle = TILE_TYPES[3].color;
                    ctx.fillRect(sx, sy, zoom, zoom);
                }
            }
        }

        // Grid
        if (zoom >= 12) {
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.lineWidth = 0.5;
            for (var gx = 0; gx <= logW; gx += zoom) {
                ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, logH); ctx.stroke();
            }
            for (var gy = 0; gy <= logH; gy += zoom) {
                ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(logW, gy); ctx.stroke();
            }
        }

        // Entities
        drawEntities();
    }

    function drawEntities() {
        if (!currentLevel) return;
        var spawns = currentLevel.spawns || {};

        // Player spawn
        if (spawns.player) drawEntity(spawns.player.x, spawns.player.y, '#4ade80', 'P');
        if (spawns.exit) drawEntity(spawns.exit.x, spawns.exit.y, '#fbbf24', 'E');

        // Enemies
        (currentLevel.enemies || []).forEach(function (en) {
            var col = ENEMY_COLORS[en.type] || '#fc7460';
            drawEntity(en.x, en.y, col, en.type.charAt(0).toUpperCase());
            // Patrol range
            if (en.patrol) {
                ctx.strokeStyle = col;
                ctx.globalAlpha = 0.3;
                ctx.lineWidth = 2;
                var py = en.y * zoom + zoom / 2;
                ctx.beginPath();
                ctx.moveTo(en.patrol.left * zoom, py);
                ctx.lineTo(en.patrol.right * zoom + zoom, py);
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
        });

        // Triggers
        (currentLevel.triggers || []).forEach(function (tr) {
            drawEntity(tr.x, tr.y, '#a855f7', 'T');
        });
    }

    function drawEntity(tx, ty, color, label) {
        var sx = tx * zoom + 2, sy = ty * zoom + 2;
        var sw = zoom - 4, sh = zoom - 4;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.6;
        ctx.fillRect(sx, sy, sw, sh);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx, sy, sw, sh);
        if (zoom >= 16 && label) {
            ctx.fillStyle = '#fff';
            ctx.font = 'bold ' + Math.max(8, zoom * 0.4) + 'px system-ui';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, tx * zoom + zoom / 2, ty * zoom + zoom / 2);
        }
    }

    // ── Canvas interaction ──
    function tileAt(e) {
        var rect = canvasEl.getBoundingClientRect();
        return {
            x: Math.floor((e.clientX - rect.left) / zoom),
            y: Math.floor((e.clientY - rect.top) / zoom)
        };
    }

    function onCanvasDown(e) {
        e.preventDefault();
        if (!currentLevel) return;
        var t = tileAt(e);

        if (e.button === 1 || (e.button === 0 && e.altKey)) {
            isPanning = true;
            panStart = { x: e.clientX, y: e.clientY };
            scrollStart = { x: wrapperEl.scrollLeft, y: wrapperEl.scrollTop };
            return;
        }

        if (tool === 'tile') {
            pushHistory();
            isDrawing = true;
            var val = e.button === 2 ? 0 : activeTileType;
            setTile(t.x, t.y, val);
            renderCanvas();
        } else if (tool === 'entity') {
            pushHistory();
            placeEntity(t.x, t.y);
            renderCanvas();
        }
    }

    function onCanvasMove(e) {
        if (isPanning) {
            wrapperEl.scrollLeft = scrollStart.x - (e.clientX - panStart.x);
            wrapperEl.scrollTop = scrollStart.y - (e.clientY - panStart.y);
            return;
        }
        if (!isDrawing || tool !== 'tile' || !currentLevel) return;
        var t = tileAt(e);
        var val = e.buttons === 2 ? 0 : activeTileType;
        setTile(t.x, t.y, val);
        renderCanvas();
    }

    function setTile(x, y, val) {
        var map = currentLevel.tilemap;
        if (y >= 0 && y < map.length && x >= 0 && x < map[0].length) {
            map[y][x] = val;
        }
    }

    function placeEntity(x, y) {
        if (!currentLevel) return;
        if (activeEntityType === 'player') {
            if (!currentLevel.spawns) currentLevel.spawns = {};
            currentLevel.spawns.player = { x: x, y: y };
        } else if (activeEntityType === 'exit') {
            if (!currentLevel.spawns) currentLevel.spawns = {};
            currentLevel.spawns.exit = { x: x, y: y };
        } else if (activeEntityType === 'trigger') {
            if (!currentLevel.triggers) currentLevel.triggers = [];
            currentLevel.triggers.push({ type: 'door', x: x, y: y, target: 'REGION' });
        } else if (activeEntityType === 'art_frame' || activeEntityType === 'item') {
            if (!currentLevel.triggers) currentLevel.triggers = [];
            currentLevel.triggers.push({ type: activeEntityType, x: x, y: y });
        } else {
            if (!currentLevel.enemies) currentLevel.enemies = [];
            var W = currentLevel.tilemap[0].length;
            currentLevel.enemies.push({
                type: activeEntityType, x: x, y: y,
                patrol: { left: Math.max(1, x - 3), right: Math.min(W - 2, x + 3) }
            });
        }
        A.scheduleSave();
        status('Placed ' + activeEntityType + ' at (' + x + ',' + y + ')');
    }

    // ── History ──
    function pushHistory() {
        if (!currentLevel) return;
        var snap = JSON.parse(JSON.stringify(currentLevel));
        if (historyIdx < history.length - 1) history = history.slice(0, historyIdx + 1);
        history.push(snap);
        if (history.length > 40) history.shift();
        historyIdx = history.length - 1;
    }

    function undo() {
        if (historyIdx <= 0) return;
        historyIdx--;
        currentLevel = JSON.parse(JSON.stringify(history[historyIdx]));
        renderCanvas();
    }

    function redo() {
        if (historyIdx >= history.length - 1) return;
        historyIdx++;
        currentLevel = JSON.parse(JSON.stringify(history[historyIdx]));
        renderCanvas();
    }

    // ── Properties ──
    function renderProps() {
        if (!currentLevel) return;
        propsPanel.innerHTML = '';
        propsPanel.appendChild(el('div', { className: 'panel-title', textContent: 'Level Properties' }));

        var fields = [
            { label: 'Name', key: 'name', type: 'text' },
            { label: 'Theme', key: 'theme', type: 'text' },
            { label: 'Tile Size', key: 'world.tileSize', type: 'number' }
        ];
        fields.forEach(function (f) {
            var wrap = el('div', { style: { marginBottom: '6px' } });
            wrap.appendChild(el('label', { textContent: f.label }));
            var val = f.key.indexOf('.') >= 0 ? getDeep(currentLevel, f.key) : currentLevel[f.key];
            var inp = el('input', { type: f.type, value: val || '', style: { width: '100%' } });
            inp.addEventListener('change', function () {
                var v = f.type === 'number' ? parseInt(this.value) : this.value;
                if (f.key.indexOf('.') >= 0) setDeep(currentLevel, f.key, v);
                else currentLevel[f.key] = v;
            });
            wrap.appendChild(inp);
            propsPanel.appendChild(wrap);
        });

        var enemies = (currentLevel.enemies || []).length;
        propsPanel.appendChild(el('div', { style: { fontSize: '11px', color: 'var(--muted)', marginTop: '8px' }, textContent: 'Enemies: ' + enemies }));
        propsPanel.appendChild(el('button', { className: 'btn small danger', textContent: 'Clear All Enemies', style: { marginTop: '4px' }, onClick: function () {
            pushHistory();
            currentLevel.enemies = [];
            renderCanvas();
            renderProps();
        }}));
    }

    function getDeep(obj, path) {
        var parts = path.split('.');
        var cur = obj;
        for (var i = 0; i < parts.length; i++) {
            if (!cur) return undefined;
            cur = cur[parts[i]];
        }
        return cur;
    }

    function setDeep(obj, path, val) {
        var parts = path.split('.');
        var cur = obj;
        for (var i = 0; i < parts.length - 1; i++) {
            if (!cur[parts[i]]) cur[parts[i]] = {};
            cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = val;
    }

    // ── Export ──
    function exportLevel() {
        if (!currentLevel) return;
        A.downloadJSON(currentLevel, (currentLevel.id || currentLevelName || 'level') + '.json');
        status('Exported');
    }

    function copyLevel() {
        if (!currentLevel) return;
        navigator.clipboard.writeText(JSON.stringify(currentLevel, null, 2)).then(function () {
            status('JSON copied to clipboard');
        });
    }

    function previewInGame() {
        if (!currentLevel) return;
        var json = JSON.stringify(currentLevel);
        var encoded = btoa(json);
        var url = 'index.html?levelData=' + encoded;
        window.open(url, '_blank');
        status('Opened preview');
    }

    function status(msg) {
        if (statusEl) statusEl.textContent = msg;
    }

    A.registerTab('levels', init, function () { renderCanvas(); });
})();
