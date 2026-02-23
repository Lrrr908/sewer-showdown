/* ================================================================
   admin-world.js — World Map Editor Tab
   World-scale terrain painting, region nodes, landmarks, roads/rivers
   ================================================================ */

(function () {
    'use strict';
    var A = Admin;
    var el = A.el;

    var TT = { OCEAN: 0, COAST: 1, LAND: 2, MOUNTAIN: 3, RIVER: 4 };
    var TT_NAMES = ['ocean', 'coast', 'land', 'mountain', 'river'];
    var TT_COLORS = { 0: '#1a3a5c', 1: '#c8b878', 2: '#4a7a3a', 3: '#8a7a6a', 4: '#2a5a8a' };

    // State
    var worldData = null;
    var W = 160, H = 90;
    var camera = { x: 0, y: 0, zoom: 1 };
    var tool = 'terrain';
    var terrainType = TT.LAND;
    var brushSize = 1;
    var isDrawing = false;
    var isPanning = false, panStart = { x: 0, y: 0 }, camStart = { x: 0, y: 0 };
    var undoStack = [], redoStack = [];

    // DOM refs
    var canvasEl, ctx, sidePanel, statusEl, toolOptionsEl;
    var logicalW = 0, logicalH = 0;

    function init() {
        var panel = document.getElementById('tab-world');
        panel.innerHTML = '';
        panel.style.cssText = '';

        // Canvas
        var center = el('div', { style: { flex: '1', position: 'relative', overflow: 'hidden', background: '#0b0c10' } });
        canvasEl = el('canvas', { style: { display: 'block', width: '100%', height: '100%', cursor: 'crosshair' } });
        ctx = canvasEl.getContext('2d');
        center.appendChild(canvasEl);

        var hud = el('div', { id: 'wdHud', style: { position: 'absolute', top: '8px', left: '8px', color: 'var(--muted)', fontSize: '11px', fontFamily: 'monospace', background: 'rgba(17,21,33,0.8)', padding: '4px 8px', borderRadius: '4px', pointerEvents: 'none' }, textContent: 'World Map Editor' });
        center.appendChild(hud);

        var statusBar = el('div', { style: { position: 'absolute', bottom: '0', left: '0', right: '0', height: '24px', background: 'rgba(17,21,33,0.9)', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', padding: '0 10px', gap: '16px', fontSize: '11px', fontFamily: 'monospace', color: 'var(--muted)' } });
        statusBar.innerHTML = '<span id="wdCoords">--</span><span id="wdTerrain">--</span><span id="wdTool">--</span><span id="wdZoom">1.0x</span>';
        center.appendChild(statusBar);

        // Sidebar
        sidePanel = el('div', { style: { width: '250px', minWidth: '230px', borderLeft: '1px solid var(--border)', background: 'var(--surface)', overflowY: 'auto', padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px' } });

        sidePanel.appendChild(el('div', { className: 'panel-title', textContent: 'World Map' }));

        var loadRow = el('div', { className: 'btn-row' });
        loadRow.appendChild(el('button', { className: 'btn small', textContent: 'Load world.json', onClick: function () {
            loadWorldData();
        }}));
        loadRow.appendChild(el('button', { className: 'btn small', textContent: 'Load File', onClick: loadWorldFile }));
        sidePanel.appendChild(loadRow);

        sidePanel.appendChild(el('hr'));

        // Tools
        sidePanel.appendChild(el('div', { className: 'panel-title', textContent: 'Tools' }));
        var toolRow = el('div', { className: 'btn-row', style: { flexWrap: 'wrap' } });
        var tools = [
            { id: 'terrain', label: 'Terrain' },
            { id: 'region', label: 'Region Node' },
            { id: 'landmark', label: 'Landmark' },
            { id: 'road', label: 'Road' },
            { id: 'river', label: 'River' },
            { id: 'eraser', label: 'Erase' }
        ];
        tools.forEach(function (t) {
            var btn = el('button', { className: 'btn small' + (tool === t.id ? ' primary' : ''), textContent: t.label, 'data-tool': t.id });
            btn.addEventListener('click', function () { selectTool(t.id); });
            toolRow.appendChild(btn);
        });
        sidePanel.appendChild(toolRow);

        toolOptionsEl = el('div');
        sidePanel.appendChild(toolOptionsEl);

        sidePanel.appendChild(el('hr'));

        // Brush
        var brushRow = el('div', { className: 'row' });
        brushRow.appendChild(el('label', { textContent: 'Brush:' }));
        var brushSel = el('select');
        [1, 2, 3, 5, 8].forEach(function (s) { brushSel.appendChild(el('option', { value: String(s), textContent: s + 'px' })); });
        brushSel.addEventListener('change', function () { brushSize = parseInt(this.value); });
        brushRow.appendChild(brushSel);
        sidePanel.appendChild(brushRow);

        sidePanel.appendChild(el('hr'));

        // Regions list
        sidePanel.appendChild(el('div', { className: 'panel-title', textContent: 'Region Nodes' }));
        var regionsList = el('div', { id: 'wdRegionsList', style: { fontSize: '11px' } });
        sidePanel.appendChild(regionsList);

        sidePanel.appendChild(el('hr'));

        // Actions
        var actRow = el('div', { className: 'btn-row', style: { flexWrap: 'wrap' } });
        actRow.appendChild(el('button', { className: 'btn small', textContent: 'Undo', onClick: undo }));
        actRow.appendChild(el('button', { className: 'btn small', textContent: 'Redo', onClick: redo }));
        sidePanel.appendChild(actRow);

        var exportRow = el('div', { className: 'btn-row', style: { flexWrap: 'wrap' } });
        exportRow.appendChild(el('button', { className: 'btn small success', textContent: 'Export world.json', onClick: exportWorld }));
        exportRow.appendChild(el('button', { className: 'btn small', textContent: 'Copy JSON', onClick: copyJSON }));
        sidePanel.appendChild(exportRow);

        statusEl = el('div', { className: 'status-msg' });
        sidePanel.appendChild(statusEl);

        panel.appendChild(center);
        panel.appendChild(sidePanel);

        // Events
        canvasEl.addEventListener('mousedown', onMouseDown);
        canvasEl.addEventListener('mousemove', onMouseMove);
        canvasEl.addEventListener('mouseup', function () {
            if (isDrawing) { isDrawing = false; A.scheduleSave(); }
            isPanning = false;
        });
        canvasEl.addEventListener('wheel', onWheel);
        canvasEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });

        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();
        selectTool('terrain');
        loadWorldData();
    }

    function resizeCanvas() {
        if (!canvasEl || !canvasEl.parentElement) return;
        var rect = canvasEl.parentElement.getBoundingClientRect();
        var dpr = window.devicePixelRatio || 1;
        logicalW = rect.width;
        logicalH = rect.height;
        canvasEl.width = Math.round(logicalW * dpr);
        canvasEl.height = Math.round(logicalH * dpr);
        canvasEl.style.width = logicalW + 'px';
        canvasEl.style.height = logicalH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        render();
    }

    function loadWorldData() {
        worldData = A.data.world;
        if (!worldData) {
            status('No world data loaded');
            return;
        }
        W = worldData.world ? worldData.world.widthTiles : 160;
        H = worldData.world ? worldData.world.heightTiles : 90;
        camera = { x: W * 4 / 2, y: H * 4 / 2, zoom: Math.min(logicalW / (W * 4), logicalH / (H * 4)) };
        undoStack = [];
        redoStack = [];
        render();
        renderRegionsList();
        status('Loaded world ' + W + '×' + H);
    }

    async function loadWorldFile() {
        var file = await A.promptFile('.json');
        if (!file) return;
        var text = await A.readFileAsText(file);
        A.data.world = JSON.parse(text);
        loadWorldData();
    }

    function selectTool(id) {
        tool = id;
        sidePanel.querySelectorAll('[data-tool]').forEach(function (b) {
            b.className = 'btn small' + (b.dataset.tool === id ? ' primary' : '');
        });
        renderToolOptions();
        var el2 = document.getElementById('wdTool');
        if (el2) el2.textContent = 'Tool: ' + id;
    }

    function renderToolOptions() {
        toolOptionsEl.innerHTML = '';
        if (tool === 'terrain') {
            TT_NAMES.forEach(function (name, i) {
                var btn = el('button', {
                    className: 'btn small' + (terrainType === i ? ' primary' : ''),
                    textContent: name,
                    style: { borderLeft: '4px solid ' + TT_COLORS[i], marginBottom: '2px' }
                });
                btn.addEventListener('click', function () { terrainType = i; renderToolOptions(); });
                toolOptionsEl.appendChild(btn);
            });
        } else if (tool === 'region') {
            toolOptionsEl.appendChild(el('div', { style: { fontSize: '11px', color: 'var(--muted)', padding: '4px 0' }, textContent: 'Click to place/move a region entry point' }));
            var regionSel = el('select', { id: 'wdRegionNodeSel', style: { width: '100%' } });
            ['na', 'sa', 'eu', 'asia', 'oce'].forEach(function (r) {
                regionSel.appendChild(el('option', { value: r, textContent: r.toUpperCase() }));
            });
            toolOptionsEl.appendChild(regionSel);
        } else if (tool === 'landmark') {
            var lblInp = el('input', { type: 'text', id: 'wdLmLabel', value: 'LANDMARK', style: { width: '100%' } });
            toolOptionsEl.appendChild(el('label', { textContent: 'Label:' }));
            toolOptionsEl.appendChild(lblInp);
        }
    }

    function renderRegionsList() {
        var list = document.getElementById('wdRegionsList');
        if (!list || !worldData || !worldData.regions) return;
        list.innerHTML = '';
        worldData.regions.forEach(function (reg) {
            var item = el('div', { style: { padding: '4px 0', borderBottom: '1px solid var(--border)' } });
            item.appendChild(el('span', { style: { color: 'var(--accent)', fontWeight: '600' }, textContent: reg.label || reg.id }));
            var spawn = reg.spawn || {};
            item.appendChild(el('span', { style: { color: 'var(--muted)', marginLeft: '8px' }, textContent: '(' + (spawn.x || '?') + ', ' + (spawn.y || '?') + ')' }));
            list.appendChild(item);
        });
    }

    // ── Rendering ──
    function render() {
        if (!canvasEl) return;
        var cw = logicalW, ch = logicalH;
        ctx.fillStyle = '#0b0c10';
        ctx.fillRect(0, 0, cw, ch);

        if (!worldData || !worldData.tiles) {
            ctx.fillStyle = '#666';
            ctx.font = '14px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('No world data loaded', cw / 2, ch / 2);
            return;
        }

        var z = camera.zoom;
        var ts = 4 * z;
        var ox = -camera.x * z + cw / 2;
        var oy = -camera.y * z + ch / 2;

        var x0 = Math.max(0, Math.floor(-ox / ts));
        var y0 = Math.max(0, Math.floor(-oy / ts));
        var x1 = Math.min(W, Math.ceil((cw - ox) / ts));
        var y1 = Math.min(H, Math.ceil((ch - oy) / ts));

        var tiles = worldData.tiles;

        for (var y = y0; y < y1; y++) {
            if (!tiles[y]) continue;
            for (var x = x0; x < x1; x++) {
                var t = tiles[y][x];
                ctx.fillStyle = TT_COLORS[t] || TT_COLORS[0];
                ctx.fillRect(ox + x * ts, oy + y * ts, ts + 1, ts + 1);
            }
        }

        // Roads overlay
        (worldData.roads || []).forEach(function (r) {
            ctx.fillStyle = 'rgba(160,160,160,0.7)';
            ctx.fillRect(ox + r.x * ts + 1, oy + r.y * ts + 1, ts - 2, ts - 2);
        });

        // River overlay
        (worldData.river || []).forEach(function (r) {
            ctx.fillStyle = 'rgba(34,85,170,0.5)';
            ctx.fillRect(ox + r.x * ts, oy + r.y * ts, ts, ts);
        });

        // Region nodes
        (worldData.regions || []).forEach(function (reg) {
            if (!reg.spawn) return;
            var rx = ox + reg.spawn.x * ts;
            var ry = oy + reg.spawn.y * ts;
            var nodeSize = Math.max(ts * 2, 12);
            ctx.fillStyle = 'rgba(106,169,255,0.4)';
            ctx.fillRect(rx - nodeSize / 2, ry - nodeSize / 2, nodeSize, nodeSize);
            ctx.strokeStyle = '#6aa9ff';
            ctx.lineWidth = 2;
            ctx.strokeRect(rx - nodeSize / 2, ry - nodeSize / 2, nodeSize, nodeSize);
            ctx.fillStyle = '#fff';
            ctx.font = 'bold ' + Math.max(10, ts * 1.5) + 'px system-ui';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(reg.label || reg.id, rx, ry);
        });

        // Landmarks
        (worldData.landmarks || []).forEach(function (lm) {
            var lx = ox + lm.x * ts + ts / 2;
            var ly = oy + lm.y * ts + ts / 2;
            ctx.fillStyle = '#ff6b6b';
            ctx.beginPath();
            ctx.arc(lx, ly, Math.max(3, ts / 2), 0, Math.PI * 2);
            ctx.fill();
            if (ts >= 4 && lm.label) {
                ctx.fillStyle = '#fff';
                ctx.font = Math.max(8, ts) + 'px system-ui';
                ctx.textAlign = 'center';
                ctx.fillText(lm.label, lx, ly - ts);
            }
        });

        // Grid
        if (ts >= 8) {
            ctx.strokeStyle = 'rgba(255,255,255,0.03)';
            ctx.lineWidth = 0.5;
            for (var gx = x0; gx <= x1; gx++) {
                var px = ox + gx * ts;
                ctx.beginPath(); ctx.moveTo(px, oy + y0 * ts); ctx.lineTo(px, oy + y1 * ts); ctx.stroke();
            }
            for (var gy = y0; gy <= y1; gy++) {
                var py = oy + gy * ts;
                ctx.beginPath(); ctx.moveTo(ox + x0 * ts, py); ctx.lineTo(ox + x1 * ts, py); ctx.stroke();
            }
        }

        var hud = document.getElementById('wdHud');
        if (hud) hud.textContent = 'World Map | ' + W + '×' + H;
        var zoomEl = document.getElementById('wdZoom');
        if (zoomEl) zoomEl.textContent = z.toFixed(1) + 'x';
    }

    // ── Input ──
    function worldPos(e) {
        var rect = canvasEl.getBoundingClientRect();
        var z = camera.zoom;
        var ts = 4 * z;
        var ox = -camera.x * z + logicalW / 2;
        var oy = -camera.y * z + logicalH / 2;
        return {
            tx: Math.floor((e.clientX - rect.left - ox) / ts),
            ty: Math.floor((e.clientY - rect.top - oy) / ts)
        };
    }

    function onMouseDown(e) {
        e.preventDefault();
        var p = worldPos(e);

        if (e.button === 1 || (e.button === 0 && e.altKey)) {
            isPanning = true;
            panStart = { x: e.clientX, y: e.clientY };
            camStart = { x: camera.x, y: camera.y };
            return;
        }

        if (e.button === 2) {
            isDrawing = true;
            eraseTile(p.tx, p.ty);
            render();
            return;
        }

        isDrawing = true;
        pushUndo();
        applyTool(p.tx, p.ty);
        render();
    }

    function onMouseMove(e) {
        var p = worldPos(e);

        var coordsEl = document.getElementById('wdCoords');
        if (coordsEl) coordsEl.textContent = p.tx + ', ' + p.ty;
        var terrEl = document.getElementById('wdTerrain');
        if (terrEl && worldData && worldData.tiles && worldData.tiles[p.ty]) {
            terrEl.textContent = TT_NAMES[worldData.tiles[p.ty][p.tx]] || 'void';
        }

        if (isPanning) {
            var z = camera.zoom;
            camera.x = camStart.x - (e.clientX - panStart.x) / z;
            camera.y = camStart.y - (e.clientY - panStart.y) / z;
            render();
            return;
        }

        if (isDrawing && (tool === 'terrain' || tool === 'road' || tool === 'river' || tool === 'eraser')) {
            applyTool(p.tx, p.ty);
            render();
        }
    }

    function onWheel(e) {
        e.preventDefault();
        var delta = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        camera.zoom = Math.max(0.3, Math.min(30, camera.zoom * delta));
        render();
    }

    // ── Tool application ──
    function applyTool(tx, ty) {
        if (!worldData || !worldData.tiles) return;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) return;

        if (tool === 'terrain') {
            var half = Math.floor(brushSize / 2);
            for (var dy = -half; dy <= half; dy++) {
                for (var dx = -half; dx <= half; dx++) {
                    var nx = tx + dx, ny = ty + dy;
                    if (nx >= 0 && nx < W && ny >= 0 && ny < H && worldData.tiles[ny]) {
                        worldData.tiles[ny][nx] = terrainType;
                    }
                }
            }
        } else if (tool === 'road') {
            if (!worldData.roads) worldData.roads = [];
            var existsR = worldData.roads.find(function (r) { return r.x === tx && r.y === ty; });
            if (!existsR) worldData.roads.push({ x: tx, y: ty });
        } else if (tool === 'river') {
            if (!worldData.river) worldData.river = [];
            var existsV = worldData.river.find(function (r) { return r.x === tx && r.y === ty; });
            if (!existsV) worldData.river.push({ x: tx, y: ty });
        } else if (tool === 'region') {
            var selRegion = document.getElementById('wdRegionNodeSel');
            var regId = selRegion ? selRegion.value : 'na';
            if (!worldData.regions) worldData.regions = [];
            var existing = worldData.regions.find(function (r) { return r.id === regId; });
            if (existing) {
                existing.spawn = { x: tx, y: ty };
            } else {
                worldData.regions.push({ id: regId, label: regId.toUpperCase(), spawn: { x: tx, y: ty }, file: 'data/regions/' + regId + '.json' });
            }
            renderRegionsList();
        } else if (tool === 'landmark') {
            if (!worldData.landmarks) worldData.landmarks = [];
            var lbl = document.getElementById('wdLmLabel');
            var label = lbl ? lbl.value : 'LANDMARK';
            var existsLm = worldData.landmarks.find(function (l) { return l.x === tx && l.y === ty; });
            if (!existsLm) {
                worldData.landmarks.push({ id: 'wlm_' + tx + '_' + ty, x: tx, y: ty, label: label });
            }
        } else if (tool === 'eraser') {
            eraseTile(tx, ty);
        }
    }

    function eraseTile(tx, ty) {
        if (!worldData) return;
        if (worldData.roads) worldData.roads = worldData.roads.filter(function (r) { return !(r.x === tx && r.y === ty); });
        if (worldData.river) worldData.river = worldData.river.filter(function (r) { return !(r.x === tx && r.y === ty); });
        if (worldData.landmarks) worldData.landmarks = worldData.landmarks.filter(function (l) { return !(l.x === tx && l.y === ty); });
    }

    // ── Undo/Redo ──
    function pushUndo() {
        if (!worldData) return;
        undoStack.push(JSON.stringify(worldData));
        if (undoStack.length > 30) undoStack.shift();
        redoStack = [];
    }

    function undo() {
        if (undoStack.length === 0) return;
        redoStack.push(JSON.stringify(worldData));
        worldData = JSON.parse(undoStack.pop());
        A.data.world = worldData;
        render();
    }

    function redo() {
        if (redoStack.length === 0) return;
        undoStack.push(JSON.stringify(worldData));
        worldData = JSON.parse(redoStack.pop());
        A.data.world = worldData;
        render();
    }

    // ── Export ──
    function exportWorld() {
        if (!worldData) return;
        A.downloadJSON(worldData, 'world.json');
        status('Exported world.json');
    }

    function copyJSON() {
        if (!worldData) return;
        navigator.clipboard.writeText(JSON.stringify(worldData, null, 2)).then(function () {
            status('JSON copied');
        });
    }

    function status(msg) {
        if (statusEl) statusEl.textContent = msg;
    }

    A.registerTab('world', init, function () {
        resizeCanvas();
        render();
    });
})();
