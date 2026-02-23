/* ================================================================
   admin-overview.js — Overview Map Editor Tab
   Region map editor with terrain, road, town, building, landmark tools
   Reimplements editor.js concepts within the admin framework
   ================================================================ */

(function () {
    'use strict';
    var A = Admin;
    var el = A.el;

    var TT = { OCEAN: 0, COAST: 1, LAND: 2, MOUNTAIN: 3, RIVER: 4 };
    var TT_NAMES = ['ocean', 'coast', 'land', 'mountain', 'river'];
    var TT_COLORS = { 0: '#1a3a5c', 1: '#c8b878', 2: '#4a7a3a', 3: '#8a7a6a', 4: '#2a5a8a' };
    var ROAD_COLORS = { 1: '#a0a0a0', 2: '#606060' };
    var FILLER_COLORS = {
        diner: '#e04040', arcade: '#40a0e0', garage: '#808080',
        toy_shop: '#e0a020', warehouse: '#606060', hotel: '#a060c0',
        gallery: '#4ade80'
    };
    var FILLER_TAGS = {
        diner: 'DIN', arcade: 'ARC', garage: 'GAR',
        toy_shop: 'TOY', warehouse: 'WHS', hotel: 'HOT', gallery: 'GAL'
    };

    // State
    var regionData = null;
    var regionId = 'na';
    var W = 120, H = 80;
    var camera = { x: 0, y: 0, zoom: 1 };
    var tool = 'terrain';
    var terrainType = TT.LAND;
    var roadType = 1;
    var fillerType = 'diner';
    var landmarkLabel = 'SIGN';
    var brushSize = 1;
    var isDrawing = false;
    var isPanning = false, panStart = { x: 0, y: 0 }, camStart = { x: 0, y: 0 };
    var undoStack = [], redoStack = [];

    // DOM refs
    var canvasEl, ctx, sidePanel, statusEl, violationsEl, toolOptionsEl;
    var logicalW = 0, logicalH = 0;

    function init() {
        var panel = document.getElementById('tab-overview');
        panel.innerHTML = '';
        panel.style.cssText = '';

        // Canvas area
        var center = el('div', { style: { flex: '1', position: 'relative', overflow: 'hidden', background: '#0b0c10' } });
        canvasEl = el('canvas', { style: { display: 'block', width: '100%', height: '100%', cursor: 'crosshair' } });
        ctx = canvasEl.getContext('2d');
        center.appendChild(canvasEl);

        // HUD
        var hud = el('div', { style: { position: 'absolute', top: '8px', left: '8px', color: 'var(--muted)', fontSize: '11px', fontFamily: 'monospace', background: 'rgba(17,21,33,0.8)', padding: '4px 8px', borderRadius: '4px', pointerEvents: 'none' } });
        hud.id = 'ovHud';
        hud.textContent = 'Overview Map Editor';
        center.appendChild(hud);

        // Status bar
        var statusBar = el('div', { style: { position: 'absolute', bottom: '0', left: '0', right: '0', height: '24px', background: 'rgba(17,21,33,0.9)', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', padding: '0 10px', gap: '16px', fontSize: '11px', fontFamily: 'monospace', color: 'var(--muted)' } });
        statusBar.innerHTML = '<span id="ovCoords">--</span><span id="ovTerrain">--</span><span id="ovTool">--</span><span id="ovZoom">1.0x</span>';
        center.appendChild(statusBar);

        // Sidebar
        sidePanel = el('div', { style: { width: '260px', minWidth: '240px', borderLeft: '1px solid var(--border)', background: 'var(--surface)', overflowY: 'auto', padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px' } });

        // Region loader
        var loadRow = el('div', { className: 'btn-row' });
        var regionSel = el('select', { id: 'ovRegionSel' });
        ['na', 'sa', 'eu', 'asia', 'oce'].forEach(function (r) {
            regionSel.appendChild(el('option', { value: r, textContent: r.toUpperCase() }));
        });
        loadRow.appendChild(regionSel);
        loadRow.appendChild(el('button', { className: 'btn small', textContent: 'Load', onClick: function () {
            regionId = regionSel.value;
            loadRegion(regionId);
        }}));
        loadRow.appendChild(el('button', { className: 'btn small', textContent: 'Load File', onClick: loadRegionFile }));
        sidePanel.appendChild(loadRow);

        sidePanel.appendChild(el('hr'));

        // Tools
        sidePanel.appendChild(el('div', { className: 'panel-title', textContent: 'Tools (1-6)' }));
        var toolRow = el('div', { className: 'btn-row', style: { flexWrap: 'wrap' } });
        var tools = [
            { id: 'terrain', label: '1 Terrain', key: '1' },
            { id: 'road', label: '2 Road', key: '2' },
            { id: 'town', label: '3 Town', key: '3' },
            { id: 'building', label: '4 Building', key: '4' },
            { id: 'landmark', label: '5 Landmark', key: '5' },
            { id: 'eraser', label: '6 Erase', key: '6' }
        ];
        tools.forEach(function (t) {
            var btn = el('button', { className: 'btn small' + (tool === t.id ? ' primary' : ''), textContent: t.label, 'data-tool': t.id });
            btn.addEventListener('click', function () { selectTool(t.id); });
            toolRow.appendChild(btn);
        });
        sidePanel.appendChild(toolRow);

        toolOptionsEl = el('div', { id: 'ovToolOptions' });
        sidePanel.appendChild(toolOptionsEl);

        sidePanel.appendChild(el('hr'));

        // Brush size
        var brushRow = el('div', { className: 'row' });
        brushRow.appendChild(el('label', { textContent: 'Brush:' }));
        var brushSel = el('select');
        [1, 2, 3, 5].forEach(function (s) { brushSel.appendChild(el('option', { value: String(s), textContent: s + 'px' })); });
        brushSel.addEventListener('change', function () { brushSize = parseInt(this.value); });
        brushRow.appendChild(brushSel);
        sidePanel.appendChild(brushRow);

        sidePanel.appendChild(el('hr'));

        // Actions
        var actRow = el('div', { className: 'btn-row', style: { flexWrap: 'wrap' } });
        actRow.appendChild(el('button', { className: 'btn small', textContent: 'Undo (Z)', onClick: undo }));
        actRow.appendChild(el('button', { className: 'btn small', textContent: 'Redo (Y)', onClick: redo }));
        sidePanel.appendChild(actRow);

        var exportRow = el('div', { className: 'btn-row', style: { flexWrap: 'wrap' } });
        exportRow.appendChild(el('button', { className: 'btn small success', textContent: 'Export Full JSON', onClick: exportFull }));
        exportRow.appendChild(el('button', { className: 'btn small', textContent: 'Copy JSON', onClick: copyJSON }));
        sidePanel.appendChild(exportRow);

        statusEl = el('div', { className: 'status-msg' });
        sidePanel.appendChild(statusEl);

        sidePanel.appendChild(el('hr'));
        sidePanel.appendChild(el('div', { className: 'panel-title', textContent: 'Validation' }));
        violationsEl = el('div', { style: { fontSize: '12px', maxHeight: '200px', overflowY: 'auto' } });
        sidePanel.appendChild(violationsEl);

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
        document.addEventListener('keydown', onKeyDown);

        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();
        selectTool('terrain');

        // Load default region
        loadRegion('na');
    }

    function resizeCanvas() {
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

    function loadRegion(id) {
        regionId = id;
        regionData = A.data.regions[id];
        if (!regionData) {
            status('Region "' + id + '" not loaded');
            return;
        }
        W = regionData.world ? regionData.world.widthTiles : 120;
        H = regionData.world ? regionData.world.heightTiles : 80;
        camera = { x: 0, y: 0, zoom: Math.min(logicalW / (W * 8), logicalH / (H * 8)) };
        undoStack = [];
        redoStack = [];
        render();
        validate();
        status('Loaded region: ' + id + ' (' + W + '×' + H + ')');
    }

    async function loadRegionFile() {
        var file = await A.promptFile('.json');
        if (!file) return;
        var text = await A.readFileAsText(file);
        var obj = JSON.parse(text);
        var id = file.name.replace('.json', '');
        A.data.regions[id] = obj;
        loadRegion(id);
    }

    function selectTool(id) {
        tool = id;
        sidePanel.querySelectorAll('[data-tool]').forEach(function (b) {
            b.className = 'btn small' + (b.dataset.tool === id ? ' primary' : '');
        });
        renderToolOptions();
        var toolEl = document.getElementById('ovTool');
        if (toolEl) toolEl.textContent = 'Tool: ' + id;
    }

    function renderToolOptions() {
        toolOptionsEl.innerHTML = '';
        if (tool === 'terrain') {
            TT_NAMES.forEach(function (name, i) {
                var btn = el('button', {
                    className: 'btn small' + (terrainType === i ? ' primary' : ''),
                    textContent: name,
                    style: { borderLeft: '4px solid ' + TT_COLORS[i] }
                });
                btn.addEventListener('click', function () {
                    terrainType = i;
                    renderToolOptions();
                });
                toolOptionsEl.appendChild(btn);
            });
        } else if (tool === 'road') {
            var r1 = el('button', { className: 'btn small' + (roadType === 1 ? ' primary' : ''), textContent: 'Street' });
            r1.addEventListener('click', function () { roadType = 1; renderToolOptions(); });
            var r2 = el('button', { className: 'btn small' + (roadType === 2 ? ' primary' : ''), textContent: 'Highway' });
            r2.addEventListener('click', function () { roadType = 2; renderToolOptions(); });
            toolOptionsEl.appendChild(r1);
            toolOptionsEl.appendChild(r2);
        } else if (tool === 'building') {
            var types = ['gallery', 'diner', 'arcade', 'warehouse', 'garage', 'toy_shop', 'hotel'];
            types.forEach(function (t) {
                var btn = el('button', {
                    className: 'btn small' + (fillerType === t ? ' primary' : ''),
                    textContent: t,
                    style: { borderLeft: '4px solid ' + (FILLER_COLORS[t] || '#666') }
                });
                btn.addEventListener('click', function () { fillerType = t; renderToolOptions(); });
                toolOptionsEl.appendChild(btn);
            });
            // Artist dropdown for gallery placement
            if (fillerType === 'gallery') {
                var artistSel = el('select', { style: { width: '100%', marginTop: '4px' } });
                artistSel.appendChild(el('option', { value: '', textContent: '(no artist)' }));
                (A.data.artists || []).forEach(function (a) {
                    artistSel.appendChild(el('option', { value: a.id, textContent: a.name }));
                });
                toolOptionsEl.appendChild(artistSel);
                toolOptionsEl._artistSel = artistSel;
            }
        } else if (tool === 'landmark') {
            var lblInp = el('input', { type: 'text', value: landmarkLabel, placeholder: 'Label', style: { width: '100%' } });
            lblInp.addEventListener('change', function () { landmarkLabel = this.value; });
            toolOptionsEl.appendChild(el('label', { textContent: 'Label:' }));
            toolOptionsEl.appendChild(lblInp);
        }
    }

    // ── Rendering ──
    function render() {
        if (!canvasEl) return;
        var cw = logicalW, ch = logicalH;
        ctx.fillStyle = '#0b0c10';
        ctx.fillRect(0, 0, cw, ch);

        if (!regionData || !regionData.terrainGrid) {
            ctx.fillStyle = '#666';
            ctx.font = '14px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('No region loaded', cw / 2, ch / 2);
            return;
        }

        var z = camera.zoom;
        var ts = 8 * z;
        var ox = -camera.x * z + cw / 2;
        var oy = -camera.y * z + ch / 2;

        // Visible tile range
        var x0 = Math.max(0, Math.floor(-ox / ts));
        var y0 = Math.max(0, Math.floor(-oy / ts));
        var x1 = Math.min(W, Math.ceil((cw - ox) / ts));
        var y1 = Math.min(H, Math.ceil((ch - oy) / ts));

        var grid = regionData.terrainGrid;

        // Terrain
        for (var y = y0; y < y1; y++) {
            if (!grid[y]) continue;
            for (var x = x0; x < x1; x++) {
                var t = grid[y][x];
                ctx.fillStyle = TT_COLORS[t] || TT_COLORS[0];
                ctx.fillRect(ox + x * ts, oy + y * ts, ts + 1, ts + 1);
            }
        }

        // Roads — build lookup, then draw topology-aware
        var roads = regionData.roads || [];
        var roadSet = {};
        for (var ri0 = 0; ri0 < roads.length; ri0++) {
            roadSet[roads[ri0].y * W + roads[ri0].x] = roads[ri0].type || 1;
        }
        for (var ri = 0; ri < roads.length; ri++) {
            var r = roads[ri];
            var rx = ox + r.x * ts, ry = oy + r.y * ts;
            var rk = r.y * W + r.x;
            var rn = r.y > 0 && roadSet[(r.y-1)*W+r.x] !== undefined;
            var rrs = r.y < H-1 && roadSet[(r.y+1)*W+r.x] !== undefined;
            var rw = r.x > 0 && roadSet[r.y*W+r.x-1] !== undefined;
            var rre = r.x < W-1 && roadSet[r.y*W+r.x+1] !== undefined;
            ctx.fillStyle = ROAD_COLORS[r.type || 1] || ROAD_COLORS[1];
            ctx.fillRect(rx + 1, ry + 1, ts - 2, ts - 2);
            // Edge lines
            ctx.fillStyle = '#505050';
            var rew = Math.max(1, Math.round(ts * 0.08));
            if (!rn) ctx.fillRect(rx + 1, ry + 1, ts - 2, rew);
            if (!rrs) ctx.fillRect(rx + 1, ry + ts - 1 - rew, ts - 2, rew);
            if (!rw) ctx.fillRect(rx + 1, ry + 1, rew, ts - 2);
            if (!rre) ctx.fillRect(rx + ts - 1 - rew, ry + 1, rew, ts - 2);
            // Center dash
            var isH = rw || rre, isV = rn || rrs;
            var nCount = (rn?1:0)+(rrs?1:0)+(rw?1:0)+(rre?1:0);
            ctx.fillStyle = '#d0d000';
            if (isH && !isV) {
                for (var dd = rx + 3; dd < rx + ts - 3; dd += 5)
                    ctx.fillRect(dd, ry + Math.round(ts/2), 3, 1);
            } else if (isV && !isH) {
                for (var dd2 = ry + 3; dd2 < ry + ts - 3; dd2 += 5)
                    ctx.fillRect(rx + Math.round(ts/2), dd2, 1, 3);
            } else if (nCount >= 3) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(rx + Math.round(ts*0.3), ry + Math.round(ts*0.48), Math.round(ts*0.4), 1);
                ctx.fillRect(rx + Math.round(ts*0.48), ry + Math.round(ts*0.3), 1, Math.round(ts*0.4));
            }
        }

        // River overlay
        var river = regionData.river || [];
        for (var vi = 0; vi < river.length; vi++) {
            var rv = river[vi];
            ctx.fillStyle = 'rgba(34,85,170,0.6)';
            ctx.fillRect(ox + rv.x * ts, oy + rv.y * ts, ts, ts);
        }

        // Towns
        var towns = regionData.towns || [];
        for (var ti = 0; ti < towns.length; ti++) {
            var tw = towns[ti];
            var tx = ox + tw.x * ts, ty = oy + tw.y * ts;
            ctx.strokeStyle = '#fcfc00';
            ctx.lineWidth = 2;
            ctx.strokeRect(tx - 2, ty - 2, ts + 4, ts + 4);
            if (ts >= 6) {
                ctx.fillStyle = '#fcfc00';
                ctx.font = Math.max(8, ts * 0.6) + 'px system-ui';
                ctx.textAlign = 'center';
                ctx.fillText(tw.label || tw.id, tx + ts / 2, ty - 4);
            }
        }

        // Building placements
        var placements = regionData.buildingPlacements || [];
        for (var bi = 0; bi < placements.length; bi++) {
            var bp = placements[bi];
            var bx = ox + bp.x * ts, by = oy + bp.y * ts;
            ctx.fillStyle = '#4ade80';
            ctx.globalAlpha = 0.6;
            ctx.fillRect(bx + 1, by + 1, ts - 2, ts - 2);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = '#4ade80';
            ctx.lineWidth = 1;
            ctx.strokeRect(bx + 1, by + 1, ts - 2, ts - 2);
        }

        // Filler buildings
        var fillers = regionData.fillerBuildings || [];
        for (var fi = 0; fi < fillers.length; fi++) {
            var fb = fillers[fi];
            var fx = ox + fb.x * ts, fy = oy + fb.y * ts;
            ctx.fillStyle = FILLER_COLORS[fb.buildingType] || '#666';
            ctx.globalAlpha = 0.6;
            ctx.fillRect(fx + 1, fy + 1, ts - 2, ts - 2);
            ctx.globalAlpha = 1;
            if (ts >= 10) {
                ctx.fillStyle = '#fff';
                ctx.font = Math.max(6, ts * 0.4) + 'px system-ui';
                ctx.textAlign = 'center';
                ctx.fillText(FILLER_TAGS[fb.buildingType] || '?', fx + ts / 2, fy + ts / 2 + 3);
            }
        }

        // Landmarks
        var landmarks = regionData.landmarks || [];
        for (var li = 0; li < landmarks.length; li++) {
            var lm = landmarks[li];
            var lx = ox + lm.x * ts, ly = oy + lm.y * ts;
            ctx.fillStyle = '#ff6b6b';
            ctx.beginPath();
            ctx.arc(lx + ts / 2, ly + ts / 2, Math.max(3, ts / 3), 0, Math.PI * 2);
            ctx.fill();
            if (ts >= 8 && lm.label) {
                ctx.fillStyle = '#fff';
                ctx.font = Math.max(7, ts * 0.5) + 'px system-ui';
                ctx.textAlign = 'center';
                ctx.fillText(lm.label, lx + ts / 2, ly - 2);
            }
        }

        // Grid (at sufficient zoom)
        if (ts >= 12) {
            ctx.strokeStyle = 'rgba(255,255,255,0.04)';
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

        // HUD
        var hud = document.getElementById('ovHud');
        if (hud) hud.textContent = 'Region: ' + regionId.toUpperCase() + ' | ' + W + '×' + H;
        var zoomEl = document.getElementById('ovZoom');
        if (zoomEl) zoomEl.textContent = z.toFixed(1) + 'x';
    }

    // ── Input ──
    function worldPos(e) {
        var rect = canvasEl.getBoundingClientRect();
        var z = camera.zoom;
        var ts = 8 * z;
        var ox = -camera.x * z + logicalW / 2;
        var oy = -camera.y * z + logicalH / 2;
        var mx = e.clientX - rect.left;
        var my = e.clientY - rect.top;
        return {
            tx: Math.floor((mx - ox) / ts),
            ty: Math.floor((my - oy) / ts),
            mx: mx, my: my
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
            // Right-click erases
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

        // Status bar updates
        var coordsEl = document.getElementById('ovCoords');
        if (coordsEl) coordsEl.textContent = p.tx + ', ' + p.ty;
        var terrEl = document.getElementById('ovTerrain');
        if (terrEl && regionData && regionData.terrainGrid && regionData.terrainGrid[p.ty]) {
            var t = regionData.terrainGrid[p.ty][p.tx];
            terrEl.textContent = TT_NAMES[t] || 'void';
        }

        if (isPanning) {
            var z = camera.zoom;
            camera.x = camStart.x - (e.clientX - panStart.x) / z;
            camera.y = camStart.y - (e.clientY - panStart.y) / z;
            render();
            return;
        }

        if (isDrawing) {
            if (tool === 'terrain' || tool === 'road' || tool === 'eraser') {
                applyTool(p.tx, p.ty);
                render();
            }
        }
    }

    function onWheel(e) {
        e.preventDefault();
        var delta = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        camera.zoom = Math.max(0.2, Math.min(20, camera.zoom * delta));
        render();
    }

    function onKeyDown(e) {
        if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
        if (e.key >= '1' && e.key <= '6') {
            var tools = ['terrain', 'road', 'town', 'building', 'landmark', 'eraser'];
            selectTool(tools[parseInt(e.key) - 1]);
        }
        if (e.key === 'z' && e.ctrlKey) { e.preventDefault(); undo(); }
        if (e.key === 'y' && e.ctrlKey) { e.preventDefault(); redo(); }
    }

    // ── Tool application ──
    function applyTool(tx, ty) {
        if (!regionData || tx < 0 || ty < 0 || tx >= W || ty >= H) return;

        if (tool === 'terrain') {
            for (var dy = -Math.floor(brushSize / 2); dy <= Math.floor(brushSize / 2); dy++) {
                for (var dx = -Math.floor(brushSize / 2); dx <= Math.floor(brushSize / 2); dx++) {
                    var nx = tx + dx, ny = ty + dy;
                    if (nx >= 0 && nx < W && ny >= 0 && ny < H && regionData.terrainGrid[ny]) {
                        regionData.terrainGrid[ny][nx] = terrainType;
                    }
                }
            }
        } else if (tool === 'road') {
            if (!regionData.roads) regionData.roads = [];
            var exists = regionData.roads.find(function (r) { return r.x === tx && r.y === ty; });
            if (exists) {
                exists.type = roadType;
            } else {
                regionData.roads.push({ x: tx, y: ty, type: roadType });
            }
        } else if (tool === 'town') {
            if (!regionData.towns) regionData.towns = [];
            var existsTown = regionData.towns.find(function (t) { return t.x === tx && t.y === ty; });
            if (!existsTown) {
                var label = prompt('Town name:', 'NEW TOWN');
                if (!label) return;
                var id = label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
                regionData.towns.push({ id: id, x: tx, y: ty, label: label });
            }
        } else if (tool === 'building') {
            if (fillerType === 'gallery') {
                // Place gallery building
                if (!regionData.buildingPlacements) regionData.buildingPlacements = [];
                var artistId = toolOptionsEl._artistSel ? toolOptionsEl._artistSel.value : '';
                var bId = artistId ? 'b_' + artistId : 'b_custom_' + tx + '_' + ty;
                var existsB = regionData.buildingPlacements.find(function (b) { return b.x === tx && b.y === ty; });
                if (!existsB) {
                    regionData.buildingPlacements.push({ buildingId: bId, x: tx, y: ty });
                }
            } else {
                // Place filler building
                if (!regionData.fillerBuildings) regionData.fillerBuildings = [];
                var existsF = regionData.fillerBuildings.find(function (f) { return f.x === tx && f.y === ty; });
                if (!existsF) {
                    var fId = 'filler_' + fillerType + '_' + tx + '_' + ty;
                    regionData.fillerBuildings.push({ id: fId, x: tx, y: ty, buildingType: fillerType });
                }
            }
        } else if (tool === 'landmark') {
            if (!regionData.landmarks) regionData.landmarks = [];
            var existsLm = regionData.landmarks.find(function (l) { return l.x === tx && l.y === ty; });
            if (!existsLm) {
                var lmId = 'lm_' + landmarkLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + tx;
                regionData.landmarks.push({ id: lmId, x: tx, y: ty, label: landmarkLabel });
            }
        } else if (tool === 'eraser') {
            eraseTile(tx, ty);
        }
    }

    function eraseTile(tx, ty) {
        if (!regionData) return;
        // Remove road at position
        if (regionData.roads) {
            regionData.roads = regionData.roads.filter(function (r) { return !(r.x === tx && r.y === ty); });
        }
        // Remove building placement
        if (regionData.buildingPlacements) {
            regionData.buildingPlacements = regionData.buildingPlacements.filter(function (b) { return !(b.x === tx && b.y === ty); });
        }
        // Remove filler
        if (regionData.fillerBuildings) {
            regionData.fillerBuildings = regionData.fillerBuildings.filter(function (f) { return !(f.x === tx && f.y === ty); });
        }
        // Remove landmark
        if (regionData.landmarks) {
            regionData.landmarks = regionData.landmarks.filter(function (l) { return !(l.x === tx && l.y === ty); });
        }
        // Remove town
        if (regionData.towns) {
            regionData.towns = regionData.towns.filter(function (t) { return !(t.x === tx && t.y === ty); });
        }
    }

    // ── Undo/Redo ──
    function pushUndo() {
        if (!regionData) return;
        var snap = JSON.stringify(regionData);
        undoStack.push(snap);
        if (undoStack.length > 50) undoStack.shift();
        redoStack = [];
    }

    function undo() {
        if (undoStack.length === 0) return;
        redoStack.push(JSON.stringify(regionData));
        regionData = JSON.parse(undoStack.pop());
        A.data.regions[regionId] = regionData;
        render();
    }

    function redo() {
        if (redoStack.length === 0) return;
        undoStack.push(JSON.stringify(regionData));
        regionData = JSON.parse(redoStack.pop());
        A.data.regions[regionId] = regionData;
        render();
    }

    // ── Validation ──
    function validate() {
        if (!violationsEl || !regionData) return;
        violationsEl.innerHTML = '';
        var issues = [];

        // Check road connectivity
        var roads = regionData.roads || [];
        if (roads.length > 0) {
            var roadSet = new Set();
            roads.forEach(function (r) { roadSet.add(r.x + ',' + r.y); });
            var visited = new Set();
            var q = [roads[0].x + ',' + roads[0].y];
            visited.add(q[0]);
            while (q.length > 0) {
                var cur = q.shift();
                var parts = cur.split(',');
                var cx = parseInt(parts[0]), cy = parseInt(parts[1]);
                [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
                    var nk = (cx + d[0]) + ',' + (cy + d[1]);
                    if (roadSet.has(nk) && !visited.has(nk)) {
                        visited.add(nk);
                        q.push(nk);
                    }
                });
            }
            if (visited.size < roadSet.size) {
                issues.push({ type: 'warn', msg: 'Disconnected roads: ' + (roadSet.size - visited.size) + ' tiles unreachable' });
            }
        }

        // Check buildings on land
        (regionData.buildingPlacements || []).forEach(function (bp) {
            if (regionData.terrainGrid && regionData.terrainGrid[bp.y]) {
                var t = regionData.terrainGrid[bp.y][bp.x];
                if (t === 0 || t === 4) {
                    issues.push({ type: 'err', msg: 'Building ' + bp.buildingId + ' on water at (' + bp.x + ',' + bp.y + ')' });
                }
            }
        });

        // Check spawn
        var hasStart = (regionData.landmarks || []).some(function (l) { return l.id === 'lm_start'; });
        if (!hasStart) {
            issues.push({ type: 'warn', msg: 'No lm_start landmark (player spawn)' });
        }

        // Building spacing
        var bps = regionData.buildingPlacements || [];
        for (var i = 0; i < bps.length; i++) {
            for (var j = i + 1; j < bps.length; j++) {
                var dist = Math.abs(bps[i].x - bps[j].x) + Math.abs(bps[i].y - bps[j].y);
                if (dist < 3) {
                    issues.push({ type: 'warn', msg: 'Buildings too close: ' + bps[i].buildingId + ' & ' + bps[j].buildingId });
                }
            }
        }

        if (issues.length === 0) {
            violationsEl.appendChild(el('div', { style: { color: 'var(--green)' }, textContent: '✓ No issues found' }));
        } else {
            issues.forEach(function (issue) {
                var cls = issue.type === 'err' ? 'color:var(--red)' : 'color:var(--yellow)';
                violationsEl.appendChild(el('div', { style: { cssText: cls, marginBottom: '3px', fontSize: '11px' }, textContent: (issue.type === 'err' ? '✗ ' : '⚠ ') + issue.msg }));
            });
        }
    }

    // ── Export ──
    function exportFull() {
        if (!regionData) return;
        A.downloadJSON(regionData, regionId + '.json');
        status('Exported ' + regionId + '.json');
    }

    function copyJSON() {
        if (!regionData) return;
        navigator.clipboard.writeText(JSON.stringify(regionData, null, 2)).then(function () {
            status('JSON copied');
        });
    }

    function status(msg) {
        if (statusEl) statusEl.textContent = msg;
    }

    A.registerTab('overview', init, function () {
        resizeCanvas();
        render();
        validate();
    });
})();
