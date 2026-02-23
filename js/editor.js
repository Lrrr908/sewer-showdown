// js/editor.js — Sewer Showdown Map Editor
// Standalone editor: loads region JSON, provides tile/entity tools, validates, exports.
'use strict';

// ════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════

const TT = { OCEAN:0, COAST:1, LAND:2, MOUNTAIN:3, RIVER:4 };
const TT_NAMES = ['ocean','coast','land','mountain','river'];
const TT_COLORS = { 0:'#1a3a5c', 1:'#c8b878', 2:'#4a7a3a', 3:'#8a7a6a', 4:'#2a5a8a' };

const ROAD_COLORS = { 1:'#a0a0a0', 2:'#606060' };
const ROAD_CENTER = { 1:'#c8c8c8', 2:'#ffff00' };
const BRIDGE_COLOR = '#8b6914';
const RIVER_COLOR  = '#2255aa';

const FILLER_TYPES = ['diner','arcade','garage','toy_shop','warehouse','hotel'];
const FILLER_COLORS = {
    diner:'#e04040', arcade:'#40a0e0', garage:'#808080',
    toy_shop:'#e0a020', warehouse:'#606060', hotel:'#a060c0'
};
const FILLER_TAGS = {
    diner:'DIN', arcade:'ARC', garage:'GAR',
    toy_shop:'TOY', warehouse:'WHS', hotel:'HOT'
};

const TOOL_IDS = ['terrain','road','town','building','landmark','eraser'];
const TOOL_KEYS = { Digit1:0, Digit2:1, Digit3:2, Digit4:3, Digit5:4, Digit6:5 };

// ════════════════════════════════════════════════════════════════
// EDITOR STATE
// ════════════════════════════════════════════════════════════════

const editor = {
    canvas: null, ctx: null, cw: 0, ch: 0,

    state: null,
    originalState: null,

    derived: {
        W: 0, H: 0, TS: 64,
        roadKeyToType: new Map(),
        buildingAt: new Map(),
        townById: new Map(),
        landmarkById: new Map(),
        ROAD_GRID: null,
        ROAD_TYPE_GRID: null,
        RIVER_GRID: null,
        BRIDGE_GRID: null,
        violations: [],
        violationTiles: new Map()
    },

    artists: null,
    buildings: null,

    camera: { x: 0, y: 0, zoom: 1 },

    mouse: { x: 0, y: 0, down: false, button: 0, shift: false, lastTx: -1, lastTy: -1 },
    keys: {},
    panDrag: null,

    cursor: { tx: 0, ty: 0, valid: false },

    tool: {
        id: 'terrain',
        terrainType: TT.LAND,
        roadType: 1,
        buildingMode: 'filler',
        selectedBuildingId: null,
        selectedFillerType: 'diner',
        landmarkLabel: 'SIGN',
        landmarkSprite: null
    },

    selection: null,
    drag: null,

    undoStack: [],
    redoStack: [],
    undoMax: 50,

    dirty: false,

    // Sprite preview (loaded from active pack)
    sprites: {},
    spritesReady: false
};

// ════════════════════════════════════════════════════════════════
// SPRITE PREVIEW (loads active pack for visual editing)
// ════════════════════════════════════════════════════════════════

const EDITOR_SPRITE_KEYS = {
    roadTile: 'sprites/extracted/road_tile.png',
    waterTile: 'sprites/extracted/water_tile.png',
    bridgeTile: 'sprites/extracted/bridge_tile.png',
    groundWest: 'sprites/extracted/ground_west.png',
    groundMountain: 'sprites/extracted/ground_mountain.png',
    groundMidwest: 'sprites/extracted/ground_midwest.png',
    groundSouth: 'sprites/extracted/ground_south.png',
    groundNortheast: 'sprites/extracted/ground_northeast.png',
    buildingDiner: 'sprites/extracted/building_diner.png',
    buildingArcade: 'sprites/extracted/building_arcade.png',
    buildingGarage: 'sprites/extracted/building_garage.png',
    buildingToyShop: 'sprites/extracted/building_toy_shop.png',
    buildingWarehouse: 'sprites/extracted/building_warehouse.png',
    buildingHotel: 'sprites/extracted/building_hotel.png',
    building1: 'sprites/extracted/building_1.png',
    building2: 'sprites/extracted/building_2.png',
    building3: 'sprites/extracted/building_3.png',
    building4: 'sprites/extracted/building_4.png'
};

// District ID -> ground sprite key
const EDITOR_DISTRICT_GROUND = {
    west_coast: 'groundWest', mountain: 'groundMountain',
    midwest: 'groundMidwest', south: 'groundSouth', northeast: 'groundNortheast'
};

// Filler type -> sprite key
const EDITOR_FILLER_SPRITE = {
    diner: 'buildingDiner', arcade: 'buildingArcade', garage: 'buildingGarage',
    toy_shop: 'buildingToyShop', warehouse: 'buildingWarehouse', hotel: 'buildingHotel'
};

async function loadEditorSprites() {
    var packId = 'default';
    try {
        var u = new URL(window.location.href);
        var p = u.searchParams.get('pack');
        if (p && p.length < 64) packId = p;
    } catch (_) {}

    // Load pack manifest
    var manifest = Object.assign({}, EDITOR_SPRITE_KEYS);
    try {
        var r = await fetch('sprites/packs/' + packId + '/manifest.json', { cache: 'no-store' });
        if (r.ok) {
            var m = await r.json();
            if (m && m.overrides) {
                for (var k in m.overrides) {
                    if (typeof m.overrides[k] === 'string') {
                        manifest[k] = 'sprites/packs/' + packId + '/' + m.overrides[k];
                    }
                }
            }
        }
    } catch (_) {}

    // Dedup + load
    var urlToKeys = {};
    for (var key in manifest) {
        var url = manifest[key];
        if (!urlToKeys[url]) urlToKeys[url] = [];
        urlToKeys[url].push(key);
    }
    var urls = Object.keys(urlToKeys);
    await Promise.all(urls.map(function(url) {
        return new Promise(function(resolve) {
            var img = new Image();
            img.onload = function() {
                var keys = urlToKeys[url];
                for (var i = 0; i < keys.length; i++) editor.sprites[keys[i]] = img;
                resolve();
            };
            img.onerror = function() { resolve(); };
            img.src = url;
        });
    }));
    editor.spritesReady = true;
    console.log('Editor sprites loaded: ' + Object.keys(editor.sprites).length + ' keys | pack=' + packId);
}

// ════════════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════════════

function getEditorDistrictForTile(tx, ty) {
    var dists = editor.state && editor.state.districts;
    if (!dists) return null;
    for (var i = 0; i < dists.length; i++) {
        var d = dists[i];
        if (typeof d.x0 === 'number') {
            if (tx >= d.x0 && tx <= d.x1) return d.id;
        } else if (typeof d.y0 === 'number') {
            if (ty >= d.y0 && ty <= d.y1) return d.id;
        }
    }
    return null;
}

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

async function fetchJSON(path) {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) throw new Error('fetch failed: ' + path + ' ' + r.status);
    return r.json();
}

function bresenham(x0, y0, x1, y1, fn) {
    x0 = Math.round(x0); y0 = Math.round(y0);
    x1 = Math.round(x1); y1 = Math.round(y1);
    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
        fn(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

function setStatus(msg) {
    const el = document.getElementById('exportStatus');
    if (el) { el.textContent = msg; setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000); }
}

// ════════════════════════════════════════════════════════════════
// DATA LOADING
// ════════════════════════════════════════════════════════════════

async function boot() {
    editor.canvas = document.getElementById('c');
    editor.ctx = editor.canvas.getContext('2d', { alpha: false });

    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    wireUI();
    wireInput();
    selectTool('terrain');

    await loadAll('data/regions/na.json');
    loadEditorSprites();
    requestAnimationFrame(drawLoop);
}

async function loadAll(regionPath) {
    try {
        const [region, buildings, artists] = await Promise.all([
            fetchJSON(regionPath),
            fetchJSON('data/buildings.json'),
            fetchJSON('data/artists.json')
        ]);
        editor.buildings = buildings;
        editor.artists = artists;
        setState(region);
        setStatus('Loaded: ' + regionPath);
    } catch (e) {
        console.error('loadAll failed:', e);
        setStatus('Load error: ' + e.message);
    }
}

function setState(regionData) {
    editor.state = deepClone(regionData);
    editor.originalState = deepClone(regionData);
    editor.selection = null;
    editor.drag = null;
    editor.undoStack = [];
    editor.redoStack = [];
    rebuildAll();
    centerCamera();
    pushUndo('load');
    updateToolOptions();
}

function centerCamera() {
    const d = editor.derived;
    editor.camera.x = (d.W * d.TS) / 2 - editor.cw / 2;
    editor.camera.y = (d.H * d.TS) / 2 - editor.ch / 2;
    editor.camera.zoom = 1;
}

function resizeCanvas() {
    const wrap = document.getElementById('canvasWrap');
    editor.cw = wrap.clientWidth;
    editor.ch = wrap.clientHeight;
    editor.canvas.width = editor.cw;
    editor.canvas.height = editor.ch;
}

// ════════════════════════════════════════════════════════════════
// REBUILD DERIVED GRIDS (after every edit)
// ════════════════════════════════════════════════════════════════

function rebuildAll() {
    const st = editor.state;
    if (!st || !st.world) return;
    const d = editor.derived;
    d.W = st.world.widthTiles | 0;
    d.H = st.world.heightTiles | 0;
    d.TS = st.world.tileSize | 0;
    const n = d.W * d.H;

    d.roadKeyToType.clear();
    d.buildingAt.clear();
    d.townById.clear();
    d.landmarkById.clear();
    d.violationTiles.clear();

    // RIVER_GRID from terrainGrid
    d.RIVER_GRID = new Uint8Array(n);
    if (Array.isArray(st.terrainGrid)) {
        for (let y = 0; y < d.H; y++) {
            const row = st.terrainGrid[y];
            if (!row) continue;
            for (let x = 0; x < d.W; x++) {
                if ((row[x] | 0) === TT.RIVER) d.RIVER_GRID[y * d.W + x] = 1;
            }
        }
    }

    // ROAD_GRID + ROAD_TYPE_GRID from roadTiles
    d.ROAD_GRID = new Uint8Array(n);
    d.ROAD_TYPE_GRID = new Uint8Array(n);
    if (Array.isArray(st.roadTiles)) {
        for (const rt of st.roadTiles) {
            const x = rt.x | 0, y = rt.y | 0;
            if (x < 0 || x >= d.W || y < 0 || y >= d.H) continue;
            const key = y * d.W + x;
            const type = rt.type === 2 ? 2 : 1;
            d.ROAD_GRID[key] = 1;
            d.ROAD_TYPE_GRID[key] = type;
            d.roadKeyToType.set(key, type);
        }
    }

    // Town expansion
    if (Array.isArray(st.towns)) {
        for (const t of st.towns) d.townById.set(t.id, t);
        expandTownsIntoRoads();
    }

    // Bridges
    computeBridgeGrid();

    // Building index
    if (Array.isArray(st.buildingPlacements)) {
        for (const p of st.buildingPlacements) {
            d.buildingAt.set((p.y | 0) * d.W + (p.x | 0), { kind: 'artist', ref: p });
        }
    }
    if (Array.isArray(st.fillerBuildings)) {
        for (const fb of st.fillerBuildings) {
            d.buildingAt.set((fb.y | 0) * d.W + (fb.x | 0), { kind: 'filler', ref: fb });
        }
    }

    // Landmark index
    if (Array.isArray(st.landmarks)) {
        for (const lm of st.landmarks) d.landmarkById.set(lm.id, lm);
    }

    // Validation
    d.violations = validateAll();
    for (const v of d.violations) {
        if (typeof v.key === 'number') d.violationTiles.set(v.key, v.level);
    }

    renderViolationsPanel();
    renderSelectionPanel();
}

function expandTownsIntoRoads() {
    const st = editor.state;
    const d = editor.derived;
    if (!Array.isArray(st.towns)) return;

    for (const t of st.towns) {
        const cx = t.x | 0, cy = t.y | 0;
        const r = t.radius || 3;
        const isGrid5 = t.pattern === 'grid5';
        const streets = isGrid5 ? [-r, 0, r] : [-r, r];

        for (const sy of streets) {
            for (let dx = -r; dx <= r; dx++) tryAddStreet(cx + dx, cy + sy);
        }
        for (const sx of streets) {
            for (let dy = -r; dy <= r; dy++) tryAddStreet(cx + sx, cy + dy);
        }
    }

    function tryAddStreet(x, y) {
        const d2 = editor.derived;
        if (x < 0 || x >= d2.W || y < 0 || y >= d2.H) return;
        const tt = st.terrainGrid[y]?.[x] | 0;
        if (tt === TT.OCEAN || tt === TT.COAST || tt === TT.RIVER) return;
        const key = y * d2.W + x;
        d2.ROAD_GRID[key] = 1;
        if (d2.ROAD_TYPE_GRID[key] === 0) d2.ROAD_TYPE_GRID[key] = 1;
        if (!d2.roadKeyToType.has(key)) d2.roadKeyToType.set(key, 1);
    }
}

function computeBridgeGrid() {
    const d = editor.derived;
    const n = d.W * d.H;
    d.BRIDGE_GRID = new Uint8Array(n);
    for (let y = 1; y < d.H - 1; y++) {
        for (let x = 1; x < d.W - 1; x++) {
            const key = y * d.W + x;
            if (!d.ROAD_GRID[key] || d.RIVER_GRID[key]) continue;
            const left = d.RIVER_GRID[key - 1], right = d.RIVER_GRID[key + 1];
            const up = d.RIVER_GRID[key - d.W], down = d.RIVER_GRID[key + d.W];
            if ((left && right) || (up && down)) d.BRIDGE_GRID[key] = 1;
        }
    }
}

// ════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════

function validateAll() {
    const st = editor.state;
    const d = editor.derived;
    if (!st) return [];
    const v = [];
    const seenIds = new Set();

    function checkId(id, kind) {
        if (!id || typeof id !== 'string') { v.push({ level: 'error', msg: kind + ' missing id' }); return; }
        if (seenIds.has(id)) v.push({ level: 'error', msg: 'Duplicate id: ' + id });
        seenIds.add(id);
    }

    // Towns
    if (Array.isArray(st.towns)) {
        for (const t of st.towns) {
            checkId(t.id, 'town');
            const tt = st.terrainGrid?.[t.y]?.[t.x];
            if (tt !== TT.LAND && tt !== TT.MOUNTAIN) {
                v.push({ level: 'error', msg: 'Town not on land: ' + t.id, key: (t.y | 0) * d.W + (t.x | 0) });
            }
        }
    }

    // Landmarks
    if (Array.isArray(st.landmarks)) {
        for (const lm of st.landmarks) checkId(lm.id, 'landmark');
    }

    // Filler IDs
    if (Array.isArray(st.fillerBuildings)) {
        for (const fb of st.fillerBuildings) checkId(fb.id, 'filler');
    }

    // All buildings: terrain + adjacency + moat
    const allB = [];
    if (Array.isArray(st.buildingPlacements)) {
        for (const p of st.buildingPlacements) allB.push({ kind: 'artist', id: p.buildingId, x: p.x | 0, y: p.y | 0 });
    }
    if (Array.isArray(st.fillerBuildings)) {
        for (const fb of st.fillerBuildings) allB.push({ kind: 'filler', id: fb.id, x: fb.x | 0, y: fb.y | 0 });
    }

    // Occupancy + moat
    const occ = new Map();
    for (const b of allB) {
        const key = b.y * d.W + b.x;
        if (occ.has(key)) v.push({ level: 'error', msg: 'Two buildings same tile: ' + occ.get(key) + ' & ' + b.id, key });
        occ.set(key, b.id);
    }
    for (const b of allB) {
        const k = b.y * d.W + b.x;
        let moatFail = false;
        for (let oy = -1; oy <= 1 && !moatFail; oy++) {
            for (let ox = -1; ox <= 1 && !moatFail; ox++) {
                if (ox === 0 && oy === 0) continue;
                const nk = (b.y + oy) * d.W + (b.x + ox);
                if (nk >= 0 && nk < d.W * d.H && occ.has(nk) && occ.get(nk) !== b.id) {
                    v.push({ level: 'error', msg: 'Moat: ' + b.id + ' near ' + occ.get(nk), key: k });
                    moatFail = true;
                }
            }
        }
    }

    // Per-building checks
    for (const b of allB) {
        const tt = st.terrainGrid?.[b.y]?.[b.x];
        const key = b.y * d.W + b.x;
        if (tt !== TT.LAND && tt !== TT.MOUNTAIN) {
            v.push({ level: 'error', msg: 'Building not on land: ' + b.id, key });
        }
        if (b.kind === 'artist') {
            const adj = (b.x > 0 && d.ROAD_GRID[key - 1]) ||
                        (b.x < d.W - 1 && d.ROAD_GRID[key + 1]) ||
                        (b.y > 0 && d.ROAD_GRID[key - d.W]) ||
                        (b.y < d.H - 1 && d.ROAD_GRID[key + d.W]);
            if (!adj) v.push({ level: 'error', msg: 'Artist not road-adjacent: ' + b.id, key });
        }
    }

    // Roads on ocean
    for (const [key] of d.roadKeyToType) {
        const x = key % d.W, y = (key / d.W) | 0;
        if ((st.terrainGrid?.[y]?.[x] | 0) === TT.OCEAN) {
            v.push({ level: 'warn', msg: 'Road on ocean at ' + x + ',' + y, key });
        }
    }

    return v;
}

// ════════════════════════════════════════════════════════════════
// UNDO / REDO
// ════════════════════════════════════════════════════════════════

function pushUndo(label) {
    editor.undoStack.push(deepClone(editor.state));
    if (editor.undoStack.length > editor.undoMax) editor.undoStack.shift();
    editor.redoStack = [];
}

function undo() {
    if (editor.undoStack.length <= 1) return;
    editor.redoStack.push(editor.undoStack.pop());
    editor.state = deepClone(editor.undoStack[editor.undoStack.length - 1]);
    rebuildAll();
}

function redo() {
    if (editor.redoStack.length === 0) return;
    const snap = editor.redoStack.pop();
    editor.undoStack.push(snap);
    editor.state = deepClone(snap);
    rebuildAll();
}

function commitEdit(label) {
    pushUndo(label);
    rebuildAll();
    editor.dirty = true;
}

// ════════════════════════════════════════════════════════════════
// CAMERA + COORDINATE CONVERSION
// ════════════════════════════════════════════════════════════════

function screenToTile(mx, my) {
    const d = editor.derived;
    const z = editor.camera.zoom;
    const wx = editor.camera.x + mx / z;
    const wy = editor.camera.y + my / z;
    const tx = Math.floor(wx / d.TS);
    const ty = Math.floor(wy / d.TS);
    return { tx, ty, valid: tx >= 0 && tx < d.W && ty >= 0 && ty < d.H };
}

function tileToScreen(tx, ty) {
    const d = editor.derived;
    const z = editor.camera.zoom;
    return {
        sx: (tx * d.TS - editor.camera.x) * z,
        sy: (ty * d.TS - editor.camera.y) * z
    };
}

// ════════════════════════════════════════════════════════════════
// INPUT WIRING
// ════════════════════════════════════════════════════════════════

function wireInput() {
    const c = editor.canvas;

    c.addEventListener('mousemove', (e) => {
        const rect = c.getBoundingClientRect();
        editor.mouse.x = e.clientX - rect.left;
        editor.mouse.y = e.clientY - rect.top;
        editor.mouse.shift = e.shiftKey;

        const t = screenToTile(editor.mouse.x, editor.mouse.y);
        editor.cursor = t;

        // Pan drag
        if (editor.panDrag) {
            editor.camera.x = editor.panDrag.camX - (e.clientX - editor.panDrag.startX) / editor.camera.zoom;
            editor.camera.y = editor.panDrag.camY - (e.clientY - editor.panDrag.startY) / editor.camera.zoom;
            return;
        }

        // Entity drag
        if (editor.drag && editor.mouse.down && t.valid) {
            handleDragMove(t.tx, t.ty);
            return;
        }

        // Paint while dragging
        if (editor.mouse.down && editor.mouse.button === 0 && t.valid) {
            if (t.tx !== editor.mouse.lastTx || t.ty !== editor.mouse.lastTy) {
                if (editor.tool.id === 'terrain' || editor.tool.id === 'road') {
                    applyToolAt(t.tx, t.ty);
                }
                editor.mouse.lastTx = t.tx;
                editor.mouse.lastTy = t.ty;
            }
        }
    });

    c.addEventListener('mousedown', (e) => {
        e.preventDefault();
        editor.mouse.down = true;
        editor.mouse.button = e.button;
        editor.mouse.shift = e.shiftKey;

        // Middle mouse = pan
        if (e.button === 1) {
            editor.panDrag = {
                startX: e.clientX, startY: e.clientY,
                camX: editor.camera.x, camY: editor.camera.y
            };
            return;
        }

        if (e.button === 0) {
            const t = screenToTile(editor.mouse.x, editor.mouse.y);
            if (!t.valid) return;
            editor.mouse.lastTx = t.tx;
            editor.mouse.lastTy = t.ty;
            handleClick(t.tx, t.ty, e.shiftKey);
        }
    });

    c.addEventListener('mouseup', (e) => {
        if (editor.panDrag && e.button === 1) {
            editor.panDrag = null;
        }
        if (e.button === 0 && editor.mouse.down) {
            if (editor.drag) {
                finishDrag();
            }
            finishStroke();
        }
        editor.mouse.down = false;
    });

    c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const oldZ = editor.camera.zoom;
        if (e.deltaY < 0) editor.camera.zoom = Math.min(4, oldZ + 0.25);
        else editor.camera.zoom = Math.max(0.25, oldZ - 0.25);

        // Zoom toward mouse cursor
        const factor = editor.camera.zoom / oldZ;
        editor.camera.x += editor.mouse.x / oldZ - editor.mouse.x / editor.camera.zoom;
        editor.camera.y += editor.mouse.y / oldZ - editor.mouse.y / editor.camera.zoom;
    }, { passive: false });

    c.addEventListener('contextmenu', (e) => e.preventDefault());

    // Drag-and-drop JSON import
    c.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    c.addEventListener('drop', async (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (!file || !file.name.endsWith('.json')) { setStatus('Drop a .json file'); return; }
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (data.version && data.regionId) {
                applyPatchToState(data);
                commitEdit('drop patch');
                setStatus('Patch applied: ' + file.name);
            } else if (data.world) {
                setState(data);
                setStatus('Loaded: ' + file.name);
            } else {
                setStatus('Unknown JSON format');
            }
        } catch (err) { setStatus('Drop error: ' + err.message); }
    });

    document.addEventListener('keydown', (e) => {
        const tag = (e.target.tagName || '').toLowerCase();
        const inInput = tag === 'input' || tag === 'select' || tag === 'textarea';

        if (!inInput) editor.keys[e.code] = true;

        // Undo/redo (always available)
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { e.preventDefault(); redo(); return; }

        // Skip hotkeys when typing in inputs
        if (inInput) return;

        // Tool hotkeys
        if (TOOL_KEYS[e.code] !== undefined) {
            selectTool(TOOL_IDS[TOOL_KEYS[e.code]]);
            return;
        }
    });

    document.addEventListener('keyup', (e) => {
        delete editor.keys[e.code];
    });

    // Clear keys on window blur to prevent stuck keys
    window.addEventListener('blur', () => { editor.keys = {}; });
}

// ════════════════════════════════════════════════════════════════
// TOOL ACTIONS
// ════════════════════════════════════════════════════════════════

let strokeActive = false;
let lineStart = null;

function handleClick(tx, ty, shift) {
    const tool = editor.tool.id;

    if (tool === 'terrain' || tool === 'road') {
        if (shift && lineStart) {
            bresenham(lineStart.tx, lineStart.ty, tx, ty, (lx, ly) => applyToolAt(lx, ly));
            lineStart = { tx, ty };
            commitEdit('line paint');
        } else {
            strokeActive = true;
            lineStart = { tx, ty };
            applyToolAt(tx, ty);
        }
        return;
    }

    if (tool === 'town') {
        handleTownClick(tx, ty);
        return;
    }

    if (tool === 'building') {
        handleBuildingClick(tx, ty);
        return;
    }

    if (tool === 'landmark') {
        handleLandmarkClick(tx, ty);
        return;
    }

    if (tool === 'eraser') {
        handleEraser(tx, ty);
        return;
    }
}

function finishStroke() {
    if (strokeActive) {
        strokeActive = false;
        commitEdit('paint');
    }
}

function applyToolAt(tx, ty) {
    const st = editor.state;
    const d = editor.derived;
    if (tx < 0 || tx >= d.W || ty < 0 || ty >= d.H) return;

    if (editor.tool.id === 'terrain') {
        st.terrainGrid[ty][tx] = editor.tool.terrainType;
        return;
    }

    if (editor.tool.id === 'road') {
        const key = ty * d.W + tx;
        const type = editor.tool.roadType;
        if (type === 0) {
            st.roadTiles = st.roadTiles.filter(r => !(r.x === tx && r.y === ty));
            d.ROAD_GRID[key] = 0;
            d.ROAD_TYPE_GRID[key] = 0;
        } else {
            const existing = st.roadTiles.find(r => r.x === tx && r.y === ty);
            if (existing) {
                existing.type = type;
            } else {
                st.roadTiles.push({ x: tx, y: ty, type });
            }
            d.ROAD_GRID[key] = 1;
            d.ROAD_TYPE_GRID[key] = type;
        }
        return;
    }
}

function handleTownClick(tx, ty) {
    // Check if clicking on existing town to select + start drag
    for (const t of editor.state.towns || []) {
        if (Math.abs(t.x - tx) <= 1 && Math.abs(t.y - ty) <= 1) {
            editor.selection = { kind: 'town', id: t.id };
            editor.drag = { kind: 'town', id: t.id, origX: t.x, origY: t.y };
            renderSelectionPanel();
            return;
        }
    }
    editor.selection = null;
    editor.drag = null;
    renderSelectionPanel();
}

function handleBuildingClick(tx, ty) {
    const d = editor.derived;
    const key = ty * d.W + tx;

    // If clicking existing building, select + start drag
    if (d.buildingAt.has(key)) {
        const b = d.buildingAt.get(key);
        const kind = b.kind === 'artist' ? 'building' : 'filler';
        const id = b.ref.id || b.ref.buildingId;
        editor.selection = { kind, id };
        editor.drag = { kind, id, origX: tx, origY: ty };
        renderSelectionPanel();
        return;
    }

    // Place new building
    const st = editor.state;
    if (editor.tool.buildingMode === 'artist' && editor.tool.selectedBuildingId) {
        if (!Array.isArray(st.buildingPlacements)) st.buildingPlacements = [];
        const bId = editor.tool.selectedBuildingId;
        if (st.buildingPlacements.some(p => p.buildingId === bId)) {
            setStatus('Artist building already placed: ' + bId);
            return;
        }
        st.buildingPlacements.push({ buildingId: bId, x: tx, y: ty, buildingType: 'gallery' });
        commitEdit('place artist');
    } else {
        if (!Array.isArray(st.fillerBuildings)) st.fillerBuildings = [];
        const fType = editor.tool.selectedFillerType || 'diner';
        const newId = 'filler_editor_' + Date.now() + '_' + tx + '_' + ty;
        st.fillerBuildings.push({ id: newId, x: tx, y: ty, buildingType: fType });
        commitEdit('place filler');
    }
}

function handleLandmarkClick(tx, ty) {
    // Check if clicking existing landmark to select + start drag
    for (const lm of editor.state.landmarks || []) {
        if (lm.x === tx && lm.y === ty) {
            editor.selection = { kind: 'landmark', id: lm.id };
            editor.drag = { kind: 'landmark', id: lm.id, origX: lm.x, origY: lm.y };
            renderSelectionPanel();
            return;
        }
    }

    // Place new landmark
    const st = editor.state;
    if (!Array.isArray(st.landmarks)) st.landmarks = [];
    const newId = 'lm_editor_' + Date.now();
    st.landmarks.push({
        id: newId, x: tx, y: ty,
        label: editor.tool.landmarkLabel || 'SIGN',
        sprite: editor.tool.landmarkSprite || null
    });
    commitEdit('place landmark');
}

function handleEraser(tx, ty) {
    const st = editor.state;
    const d = editor.derived;
    const key = ty * d.W + tx;

    // Try to erase building
    if (d.buildingAt.has(key)) {
        const b = d.buildingAt.get(key);
        if (b.kind === 'filler') {
            st.fillerBuildings = st.fillerBuildings.filter(f => !(f.x === tx && f.y === ty));
        } else {
            st.buildingPlacements = st.buildingPlacements.filter(p => !(p.x === tx && p.y === ty));
        }
        commitEdit('erase building');
        return;
    }

    // Try to erase landmark
    for (let i = 0; i < (st.landmarks || []).length; i++) {
        if (st.landmarks[i].x === tx && st.landmarks[i].y === ty) {
            st.landmarks.splice(i, 1);
            commitEdit('erase landmark');
            return;
        }
    }

    // Try to erase road
    const roadIdx = st.roadTiles.findIndex(r => r.x === tx && r.y === ty);
    if (roadIdx !== -1) {
        st.roadTiles.splice(roadIdx, 1);
        commitEdit('erase road');
        return;
    }
}

// ════════════════════════════════════════════════════════════════
// DRAG SUPPORT
// ════════════════════════════════════════════════════════════════

function handleDragMove(tx, ty) {
    const drag = editor.drag;
    if (!drag) return;
    const st = editor.state;

    if (drag.kind === 'town') {
        const t = (st.towns || []).find(t2 => t2.id === drag.id);
        if (t) { t.x = tx; t.y = ty; }
    } else if (drag.kind === 'building') {
        const bp = (st.buildingPlacements || []).find(p => p.buildingId === drag.id);
        if (bp) { bp.x = tx; bp.y = ty; }
    } else if (drag.kind === 'filler') {
        const fb = (st.fillerBuildings || []).find(f => f.id === drag.id);
        if (fb) { fb.x = tx; fb.y = ty; }
    } else if (drag.kind === 'landmark') {
        const lm = (st.landmarks || []).find(l => l.id === drag.id);
        if (lm) { lm.x = tx; lm.y = ty; }
    }

    rebuildAll();
}

function finishDrag() {
    if (!editor.drag) return;
    commitEdit('drag ' + editor.drag.kind);
    editor.drag = null;
}

// ════════════════════════════════════════════════════════════════
// RENDERING
// ════════════════════════════════════════════════════════════════

function drawLoop() {
    draw();
    updateStatusBar();
    updateCameraPan();
    requestAnimationFrame(drawLoop);
}

function updateCameraPan() {
    const speed = 8 / editor.camera.zoom;
    if (editor.keys['KeyW'] || editor.keys['ArrowUp']) editor.camera.y -= speed;
    if (editor.keys['KeyS'] || editor.keys['ArrowDown']) editor.camera.y += speed;
    if (editor.keys['KeyA'] || editor.keys['ArrowLeft']) editor.camera.x -= speed;
    if (editor.keys['KeyD'] || editor.keys['ArrowRight']) editor.camera.x += speed;
}

// ── Procedural building facades ─────────────────────────────────

function drawArtistBuilding(ctx, sx, sy, ts, z, ref) {
    const m = 4 * z;
    const w = ts - m * 2, h = ts - m * 2;
    const bx = sx + m, by = sy + m;

    // Gallery base: warm yellow
    ctx.fillStyle = '#ffcc00';
    ctx.fillRect(bx, by, w, h);

    // Door
    ctx.fillStyle = '#996600';
    ctx.fillRect(bx + w * 0.35, by + h * 0.55, w * 0.3, h * 0.45);

    // Gallery window
    ctx.fillStyle = '#ffffaa';
    ctx.fillRect(bx + w * 0.15, by + h * 0.15, w * 0.7, h * 0.3);
    ctx.strokeStyle = '#996600';
    ctx.lineWidth = z;
    ctx.strokeRect(bx + w * 0.15, by + h * 0.15, w * 0.7, h * 0.3);

    // Label
    ctx.fillStyle = '#000000';
    ctx.font = Math.max(7, 8 * z) + 'px monospace';
    ctx.textAlign = 'center';
    const label = (ref.buildingId || '').replace('b_', '').substring(0, 6);
    ctx.fillText(label, sx + ts / 2, by + h * 0.52);
    ctx.textAlign = 'left';
}

function drawFillerBuilding(ctx, sx, sy, ts, z, ref) {
    const fType = ref.buildingType || 'shop';
    const m = 4 * z;
    const w = ts - m * 2, h = ts - m * 2;
    const bx = sx + m, by = sy + m;
    const hash = simpleHash(ref.id || (ref.x + ',' + ref.y)) >>> 0;

    // Base wall
    const baseColor = FILLER_COLORS[fType] || '#888888';
    ctx.fillStyle = baseColor;
    ctx.fillRect(bx, by, w, h);

    // Sign band (top 20%)
    const bandH = Math.max(4 * z, h * 0.2);
    ctx.fillStyle = darken(baseColor, 30);
    ctx.fillRect(bx, by, w, bandH);

    // Sign text
    ctx.fillStyle = '#ffffff';
    ctx.font = Math.max(6, 7 * z) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(FILLER_TAGS[fType] || fType.substring(0, 3).toUpperCase(), sx + ts / 2, by + bandH - 2 * z);

    // Type-specific facade details
    if (fType === 'diner') {
        // Awning stripes
        const stripeW = w / 6;
        for (let i = 0; i < 6; i++) {
            ctx.fillStyle = i % 2 === 0 ? '#ff6060' : '#ffffff';
            ctx.fillRect(bx + i * stripeW, by + bandH, stripeW, 3 * z);
        }
        // "OPEN" neon
        ctx.fillStyle = '#00ff00';
        ctx.font = Math.max(5, 6 * z) + 'px monospace';
        ctx.fillText('OPEN', sx + ts / 2, by + h * 0.65);
    } else if (fType === 'arcade') {
        // Neon border
        ctx.strokeStyle = '#00ffff';
        ctx.lineWidth = 1.5 * z;
        ctx.strokeRect(bx + 2 * z, by + bandH + 2 * z, w - 4 * z, h - bandH - 4 * z);
        // Dark screen face
        ctx.fillStyle = '#0a0a2a';
        ctx.fillRect(bx + 4 * z, by + bandH + 4 * z, w - 8 * z, h * 0.35);
    } else if (fType === 'hotel') {
        // Window columns (2 columns of windows)
        const winW = w * 0.2, winH = h * 0.12;
        const cols = 2, rows = Math.min(3, 1 + (hash % 3));
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const wx = bx + w * 0.15 + c * w * 0.5;
                const wy = by + bandH + 3 * z + r * (winH + 3 * z);
                ctx.fillStyle = (hash + r + c) % 3 === 0 ? '#ffff80' : '#4060a0';
                ctx.fillRect(wx, wy, winW, winH);
            }
        }
    } else if (fType === 'warehouse') {
        // Corrugation lines
        ctx.strokeStyle = darken(baseColor, 20);
        ctx.lineWidth = z;
        const lineCount = 4;
        for (let i = 0; i < lineCount; i++) {
            const ly = by + bandH + 4 * z + i * ((h - bandH - 8 * z) / lineCount);
            ctx.beginPath();
            ctx.moveTo(bx + 2 * z, ly);
            ctx.lineTo(bx + w - 2 * z, ly);
            ctx.stroke();
        }
        // Loading dock
        ctx.fillStyle = '#333333';
        ctx.fillRect(bx + w * 0.25, by + h * 0.7, w * 0.5, h * 0.3);
    } else if (fType === 'garage') {
        // Roll-up door slats
        ctx.fillStyle = '#555555';
        const doorW = w * 0.6, doorH = h * 0.5;
        const doorX = bx + (w - doorW) / 2, doorY = by + h - doorH;
        ctx.fillRect(doorX, doorY, doorW, doorH);
        ctx.strokeStyle = '#444444';
        ctx.lineWidth = z;
        for (let i = 0; i < 4; i++) {
            const sly = doorY + i * doorH / 4;
            ctx.beginPath(); ctx.moveTo(doorX, sly); ctx.lineTo(doorX + doorW, sly); ctx.stroke();
        }
        // Oil stain (small dark circle)
        ctx.fillStyle = 'rgba(40,30,20,0.4)';
        ctx.beginPath();
        ctx.arc(bx + w * 0.3, by + h * 0.85, 3 * z, 0, Math.PI * 2);
        ctx.fill();
    } else if (fType === 'toy_shop') {
        // Big display window
        ctx.fillStyle = '#ffffcc';
        ctx.fillRect(bx + w * 0.1, by + bandH + 3 * z, w * 0.8, h * 0.35);
        ctx.strokeStyle = '#996600';
        ctx.lineWidth = z;
        ctx.strokeRect(bx + w * 0.1, by + bandH + 3 * z, w * 0.8, h * 0.35);
        // "TOYS" in window
        ctx.fillStyle = '#ff4400';
        ctx.font = Math.max(6, 7 * z) + 'px monospace';
        ctx.fillText('TOYS', sx + ts / 2, by + bandH + h * 0.25);
    }

    // Door (universal, at bottom center)
    ctx.fillStyle = '#4a3520';
    ctx.fillRect(bx + w * 0.38, by + h * 0.75, w * 0.24, h * 0.25);

    ctx.textAlign = 'left';
}

function darken(hex, amount) {
    const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
    const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
    const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
    return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
}

function draw() {
    const ctx = editor.ctx;
    const d = editor.derived;
    const st = editor.state;
    if (!st || !d.W) return;

    const z = editor.camera.zoom;
    const ts = d.TS * z;

    ctx.fillStyle = '#0b0c10';
    ctx.fillRect(0, 0, editor.cw, editor.ch);

    // Visible tile range
    const startX = Math.max(0, Math.floor(editor.camera.x / d.TS));
    const startY = Math.max(0, Math.floor(editor.camera.y / d.TS));
    const endX = Math.min(d.W, Math.ceil((editor.camera.x + editor.cw / z) / d.TS) + 1);
    const endY = Math.min(d.H, Math.ceil((editor.camera.y + editor.ch / z) / d.TS) + 1);

    // Draw tiles
    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
            const sx = (x * d.TS - editor.camera.x) * z;
            const sy = (y * d.TS - editor.camera.y) * z;
            const key = y * d.W + x;

            // Terrain base (sprite if available, else colored rect)
            const tt = st.terrainGrid?.[y]?.[x] | 0;
            var drawnSprite = false;
            if (editor.spritesReady && tt === TT.LAND) {
                var distId = getEditorDistrictForTile(x, y);
                var gKey = distId ? EDITOR_DISTRICT_GROUND[distId] : null;
                var gSprite = gKey ? editor.sprites[gKey] : null;
                if (gSprite) { ctx.drawImage(gSprite, sx, sy, ts + 1, ts + 1); drawnSprite = true; }
            }
            if (!drawnSprite) {
                ctx.fillStyle = TT_COLORS[tt] || TT_COLORS[0];
                ctx.fillRect(sx, sy, ts + 1, ts + 1);
            }

            // River overlay (sprite or colored rect)
            if (d.RIVER_GRID[key]) {
                var waterSprite = editor.spritesReady ? editor.sprites.waterTile : null;
                if (waterSprite) { ctx.drawImage(waterSprite, sx + 2 * z, sy + 2 * z, ts - 4 * z, ts - 4 * z); }
                else { ctx.fillStyle = RIVER_COLOR; ctx.fillRect(sx + 2 * z, sy + 2 * z, ts - 4 * z, ts - 4 * z); }
            }

            // Bridge overlay
            if (d.BRIDGE_GRID[key]) {
                ctx.fillStyle = BRIDGE_COLOR;
                ctx.fillRect(sx + 1 * z, sy + 1 * z, ts - 2 * z, ts - 2 * z);
            }

            // Road overlay with topology-aware rendering
            if (d.ROAD_GRID[key] && !d.BRIDGE_GRID[key]) {
                var roadSprite = editor.spritesReady ? editor.sprites.roadTile : null;
                if (roadSprite) {
                    ctx.drawImage(roadSprite, sx + 2 * z, sy + 2 * z, ts - 4 * z, ts - 4 * z);
                } else {
                    const rType = d.ROAD_TYPE_GRID[key] || 1;
                    const rx = key % d.W, ry = (key / d.W) | 0;
                    const rn = ry > 0        && !!d.ROAD_GRID[key - d.W];
                    const rs = ry < d.H - 1  && !!d.ROAD_GRID[key + d.W];
                    const rw = rx > 0        && !!d.ROAD_GRID[key - 1];
                    const re = rx < d.W - 1  && !!d.ROAD_GRID[key + 1];
                    const rc = (rn?1:0)+(rs?1:0)+(rw?1:0)+(re?1:0);
                    const ew = Math.max(1, Math.round(z * 0.5));
                    // Base fill
                    ctx.fillStyle = ROAD_COLORS[rType];
                    ctx.fillRect(sx + ew, sy + ew, ts - ew*2, ts - ew*2);
                    // Curb edges where no neighbor
                    ctx.fillStyle = '#505050';
                    if (!rn) ctx.fillRect(sx + ew, sy + ew, ts - ew*2, ew);
                    if (!rs) ctx.fillRect(sx + ew, sy + ts - ew*2, ts - ew*2, ew);
                    if (!rw) ctx.fillRect(sx + ew, sy + ew, ew, ts - ew*2);
                    if (!re) ctx.fillRect(sx + ts - ew*2, sy + ew, ew, ts - ew*2);
                    // Center dashes
                    ctx.fillStyle = ROAD_CENTER[rType];
                    var isH = rw || re, isV = rn || rs;
                    if (isH && !isV) {
                        var ccy = sy + Math.round(ts/2) - Math.round(z*0.3);
                        for (var dd = sx + 3*z; dd < sx + ts - 3*z; dd += 4*z)
                            ctx.fillRect(dd, ccy, 2*z, Math.max(1, Math.round(z*0.6)));
                    } else if (isV && !isH) {
                        var ccx = sx + Math.round(ts/2) - Math.round(z*0.3);
                        for (var dd2 = sy + 3*z; dd2 < sy + ts - 3*z; dd2 += 4*z)
                            ctx.fillRect(ccx, dd2, Math.max(1, Math.round(z*0.6)), 2*z);
                    } else if (rc >= 3) {
                        // Intersection: crosshatch mark
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(sx + Math.round(ts*0.3), sy + Math.round(ts*0.45), Math.round(ts*0.4), Math.max(1, Math.round(z*0.6)));
                        ctx.fillRect(sx + Math.round(ts*0.45), sy + Math.round(ts*0.3), Math.max(1, Math.round(z*0.6)), Math.round(ts*0.4));
                    } else if (isH && isV && rc === 2) {
                        // Corner: L-shaped dash at center
                        ctx.fillStyle = ROAD_CENTER[rType];
                        var mid = Math.round(ts/2), dw = Math.max(1, Math.round(z*0.6));
                        if (rs && re) { ctx.fillRect(sx+mid, sy+ew*2, dw, mid-ew*2); ctx.fillRect(sx+mid, sy+mid, ts-mid-ew*2, dw); }
                        if (rs && rw) { ctx.fillRect(sx+mid, sy+ew*2, dw, mid-ew*2); ctx.fillRect(sx+ew*2, sy+mid, mid-ew*2, dw); }
                        if (rn && re) { ctx.fillRect(sx+mid, sy+mid, dw, ts-mid-ew*2); ctx.fillRect(sx+mid, sy+mid, ts-mid-ew*2, dw); }
                        if (rn && rw) { ctx.fillRect(sx+mid, sy+mid, dw, ts-mid-ew*2); ctx.fillRect(sx+ew*2, sy+mid, mid-ew*2, dw); }
                    }
                }
            }

            // Violation highlight
            if (d.violationTiles.has(key)) {
                ctx.strokeStyle = d.violationTiles.get(key) === 'error' ? '#ff4444' : '#ffaa00';
                ctx.lineWidth = 2;
                ctx.strokeRect(sx + 1, sy + 1, ts - 2, ts - 2);
            }
        }
    }

    // Draw towns
    if (Array.isArray(st.towns)) {
        for (const t of st.towns) {
            const { sx, sy } = tileToScreen(t.x, t.y);
            const r = (t.radius || 3) * d.TS * z;
            ctx.strokeStyle = t.tier === 'A' ? '#ff8800' : '#88aaff';
            ctx.lineWidth = 2;
            ctx.strokeRect(sx - r, sy - r, r * 2 + ts, r * 2 + ts);
            // Label
            ctx.fillStyle = '#ffffff';
            ctx.font = Math.max(10, 12 * z) + 'px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(t.label || t.id, sx + ts / 2, sy - 4 * z);
            ctx.textAlign = 'left';
        }
    }

    // Draw background buildings (non-enterable city mass)
    if (Array.isArray(st.bgBuildings)) {
        for (var bgi = 0; bgi < st.bgBuildings.length; bgi++) {
            var bg = st.bgBuildings[bgi];
            if (bg.x < startX - 1 || bg.x >= endX || bg.y < startY - 1 || bg.y >= endY) continue;
            var bsx = (bg.x * d.TS - editor.camera.x) * z;
            var bsy = (bg.y * d.TS - editor.camera.y) * z;
            var bgH = ts * 0.8;
            ctx.fillStyle = '#4a4a5a';
            ctx.fillRect(bsx + 2 * z, bsy + ts - bgH, ts - 4 * z, bgH);
            ctx.fillStyle = '#3a3a4a';
            ctx.fillRect(bsx, bsy + ts - bgH - 2 * z, ts, 3 * z);
            // Tiny label
            if (z >= 0.8) {
                ctx.fillStyle = '#888';
                ctx.font = Math.max(6, 7 * z) + 'px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(bg.kind.replace('_', ''), bsx + ts / 2, bsy + ts - 2 * z);
                ctx.textAlign = 'left';
            }
        }
    }

    // Draw buildings
    for (const [key, b] of d.buildingAt) {
        const bx = key % d.W, by = (key / d.W) | 0;
        const { sx, sy } = tileToScreen(bx, by);
        if (sx < -ts || sx > editor.cw || sy < -ts || sy > editor.ch) continue;

        if (b.kind === 'artist') {
            // Try building sprite first
            var artistSprite = editor.spritesReady ? editor.sprites['building' + (1 + ((bx + by) % 4))] : null;
            if (artistSprite) { ctx.drawImage(artistSprite, sx, sy, ts, ts); }
            else drawArtistBuilding(ctx, sx, sy, ts, z, b.ref);
        } else {
            var fType = b.ref.buildingType || 'diner';
            var fSpriteKey = EDITOR_FILLER_SPRITE[fType];
            var fSprite = (editor.spritesReady && fSpriteKey) ? editor.sprites[fSpriteKey] : null;
            if (fSprite) { ctx.drawImage(fSprite, sx, sy, ts, ts); }
            else drawFillerBuilding(ctx, sx, sy, ts, z, b.ref);
        }

        // Selection highlight
        const sel = editor.selection;
        if (sel) {
            const sid = b.kind === 'artist' ? b.ref.buildingId : b.ref.id;
            if (sid === sel.id) {
                ctx.strokeStyle = '#00ff00';
                ctx.lineWidth = 3;
                ctx.strokeRect(sx + 2 * z, sy + 2 * z, ts - 4 * z, ts - 4 * z);
            }
        }
    }

    // Draw landmarks
    if (Array.isArray(st.landmarks)) {
        for (const lm of st.landmarks) {
            const { sx, sy } = tileToScreen(lm.x, lm.y);
            if (sx < -ts || sx > editor.cw || sy < -ts || sy > editor.ch) continue;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(sx + ts / 2 - 3 * z, sy + ts / 2 - 3 * z, 6 * z, 6 * z);
            ctx.fillStyle = '#ffffff';
            ctx.font = Math.max(8, 9 * z) + 'px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(lm.label || lm.id, sx + ts / 2, sy - 2 * z);
            ctx.textAlign = 'left';
        }
    }

    // Draw cursor
    if (editor.cursor.valid) {
        const { sx, sy } = tileToScreen(editor.cursor.tx, editor.cursor.ty);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx, sy, ts, ts);
    }

    // Grid lines (subtle, only at higher zoom)
    if (z >= 1.5) {
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        for (let x = startX; x <= endX; x++) {
            const sx = (x * d.TS - editor.camera.x) * z;
            ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, editor.ch); ctx.stroke();
        }
        for (let y = startY; y <= endY; y++) {
            const sy = (y * d.TS - editor.camera.y) * z;
            ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(editor.cw, sy); ctx.stroke();
        }
    }
}

function updateStatusBar() {
    const c = editor.cursor;
    const d = editor.derived;
    const st = editor.state;
    document.getElementById('sbCoords').textContent = c.valid ? c.tx + ', ' + c.ty : '--';
    if (c.valid && st && st.terrainGrid) {
        const tt = st.terrainGrid[c.ty]?.[c.tx] | 0;
        document.getElementById('sbTerrain').textContent = TT_NAMES[tt] || '?';
    } else {
        document.getElementById('sbTerrain').textContent = '--';
    }
    document.getElementById('sbTool').textContent = editor.tool.id;
    document.getElementById('sbZoom').textContent = editor.camera.zoom.toFixed(2) + 'x';
}

// ════════════════════════════════════════════════════════════════
// UI WIRING
// ════════════════════════════════════════════════════════════════

function wireUI() {
    // Tool buttons
    document.querySelectorAll('[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => selectTool(btn.dataset.tool));
    });

    // Load region
    document.getElementById('btnLoad').addEventListener('click', () => {
        const input = document.getElementById('fileInput');
        input.onchange = async () => {
            if (!input.files[0]) return;
            const text = await input.files[0].text();
            try {
                const data = JSON.parse(text);
                if (!data.world) throw new Error('Not a region JSON');
                setState(data);
                setStatus('Loaded file: ' + input.files[0].name);
            } catch (e) { setStatus('Load error: ' + e.message); }
            input.value = '';
        };
        input.click();
    });

    // Load patch
    document.getElementById('btnLoadPatch').addEventListener('click', () => {
        const input = document.getElementById('fileInput');
        input.onchange = async () => {
            if (!input.files[0]) return;
            const text = await input.files[0].text();
            try {
                const patch = JSON.parse(text);
                if (!patch.version) throw new Error('Not a patch JSON');
                applyPatchToState(patch);
                commitEdit('apply patch');
                setStatus('Patch applied: ' + input.files[0].name);
            } catch (e) { setStatus('Patch error: ' + e.message); }
            input.value = '';
        };
        input.click();
    });

    // Export
    document.getElementById('btnExportFull').addEventListener('click', exportFull);
    document.getElementById('btnExportPatch').addEventListener('click', exportPatch);
    document.getElementById('btnCopy').addEventListener('click', () => {
        syncRoadTilesFromMap();
        navigator.clipboard.writeText(JSON.stringify(editor.state, null, 2))
            .then(() => setStatus('Copied to clipboard'))
            .catch(() => setStatus('Copy failed'));
    });

    // Undo/redo
    document.getElementById('btnUndo').addEventListener('click', undo);
    document.getElementById('btnRedo').addEventListener('click', redo);
}

function selectTool(id) {
    if (!TOOL_IDS.includes(id)) return;
    editor.tool.id = id;
    editor.selection = null;
    document.querySelectorAll('[data-tool]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tool === id);
    });
    updateToolOptions();
    renderSelectionPanel();
}

function updateToolOptions() {
    const el = document.getElementById('toolOptions');
    const t = editor.tool;

    if (t.id === 'terrain') {
        el.innerHTML = '<div class="label">Terrain Type</div>' +
            '<select id="optTerrainType">' +
            TT_NAMES.map((n, i) => '<option value="' + i + '"' + (i === t.terrainType ? ' selected' : '') + '>' + i + ' ' + n + '</option>').join('') +
            '</select>';
        document.getElementById('optTerrainType').addEventListener('change', (e) => {
            t.terrainType = parseInt(e.target.value);
        });
    } else if (t.id === 'road') {
        el.innerHTML = '<div class="label">Road Type</div>' +
            '<select id="optRoadType">' +
            '<option value="1"' + (t.roadType === 1 ? ' selected' : '') + '>1 Street</option>' +
            '<option value="2"' + (t.roadType === 2 ? ' selected' : '') + '>2 Highway</option>' +
            '<option value="0"' + (t.roadType === 0 ? ' selected' : '') + '>0 Erase</option>' +
            '</select>';
        document.getElementById('optRoadType').addEventListener('change', (e) => {
            t.roadType = parseInt(e.target.value);
        });
    } else if (t.id === 'building') {
        let html = '<div class="label">Mode</div>' +
            '<select id="optBuildingMode">' +
            '<option value="filler"' + (t.buildingMode === 'filler' ? ' selected' : '') + '>Filler</option>' +
            '<option value="artist"' + (t.buildingMode === 'artist' ? ' selected' : '') + '>Artist</option>' +
            '</select>';
        if (t.buildingMode === 'filler') {
            html += '<div class="label">Filler Type</div>' +
                '<select id="optFillerType">' +
                FILLER_TYPES.map(ft => '<option value="' + ft + '"' + (ft === t.selectedFillerType ? ' selected' : '') + '>' + ft + '</option>').join('') +
                '</select>';
        } else {
            const bList = editor.buildings && editor.buildings.buildings ? editor.buildings.buildings : [];
            html += '<div class="label">Artist Building</div>' +
                '<select id="optArtistBuilding">' +
                bList.map(b => '<option value="' + b.id + '"' + (b.id === t.selectedBuildingId ? ' selected' : '') + '>' + b.id.replace('b_', '') + '</option>').join('') +
                '</select>';
        }
        el.innerHTML = html;
        document.getElementById('optBuildingMode').addEventListener('change', (e) => {
            t.buildingMode = e.target.value;
            updateToolOptions();
        });
        if (t.buildingMode === 'filler') {
            document.getElementById('optFillerType').addEventListener('change', (e) => {
                t.selectedFillerType = e.target.value;
            });
        } else {
            const sel = document.getElementById('optArtistBuilding');
            if (sel) {
                if (!t.selectedBuildingId && sel.options.length) t.selectedBuildingId = sel.value;
                sel.addEventListener('change', (e) => { t.selectedBuildingId = e.target.value; });
            }
        }
    } else if (t.id === 'landmark') {
        el.innerHTML = '<div class="label">Label</div>' +
            '<input type="text" id="optLmLabel" value="' + (t.landmarkLabel || 'SIGN') + '" />';
        document.getElementById('optLmLabel').addEventListener('input', (e) => {
            t.landmarkLabel = e.target.value;
        });
    } else {
        el.innerHTML = '';
    }
}

function renderSelectionPanel() {
    const el = document.getElementById('selection');
    const sel = editor.selection;
    if (!sel) { el.textContent = 'none'; return; }

    const st = editor.state;
    if (sel.kind === 'town') {
        const t = editor.derived.townById.get(sel.id);
        if (!t) { el.textContent = 'town not found'; return; }
        const artistCount = t.artists ? t.artists.length : 0;
        const nearFillers = (st.fillerBuildings || []).filter(f =>
            Math.abs(f.x - t.x) <= 15 && Math.abs(f.y - t.y) <= 15
        ).length;

        el.innerHTML =
            '<div>Town: ' + t.id + '</div>' +
            '<div>Pos: ' + t.x + ', ' + t.y + ' | Tier: ' + t.tier + '</div>' +
            '<div class="row"><span class="label" style="margin:0">Pattern:</span>' +
            '<select id="selTownPattern"><option value="grid3"' + (t.pattern === 'grid3' ? ' selected' : '') + '>grid3</option>' +
            '<option value="grid5"' + (t.pattern === 'grid5' ? ' selected' : '') + '>grid5</option></select></div>' +
            '<div class="row"><span class="label" style="margin:0">Radius:</span>' +
            '<input type="number" id="selTownRadius" value="' + t.radius + '" min="2" max="8" style="width:60px"/></div>' +
            '<div class="label">Artists: ' + artistCount + ' | Fillers nearby: ' + nearFillers + '</div>' +

            // Automation: Spread Artists
            '<hr/>' +
            '<div class="label">Spread Artists</div>' +
            '<div class="row"><span class="label" style="margin:0">Radius:</span>' +
            '<input type="number" id="autoSpreadRadius" value="14" min="6" max="24" style="width:60px"/></div>' +
            '<div class="row"><span class="label" style="margin:0">Min spacing:</span>' +
            '<input type="number" id="autoSpreadSpacing" value="2" min="1" max="6" style="width:60px"/></div>' +
            '<div class="row">' +
            '<label style="font-size:12px;color:#aeb6cc"><input type="checkbox" id="autoSpreadHwy" checked /> Prefer highway</label></div>' +
            '<div class="row">' +
            '<label style="font-size:12px;color:#aeb6cc"><input type="checkbox" id="autoSpreadCore" checked /> Keep 35% near core</label></div>' +
            '<div class="row"><button id="btnSpreadArtists" class="btn small">Spread Artists</button></div>' +

            // Automation: Add Fillers
            '<div class="label">Add Filler Buildings</div>' +
            '<div class="row"><span class="label" style="margin:0">Count:</span>' +
            '<select id="autoFillerCount"><option value="5">5</option><option value="10" selected>10</option><option value="20">20</option></select></div>' +
            '<div class="row"><span class="label" style="margin:0">Mix:</span>' +
            '<select id="autoFillerPreset">' +
            FILLER_PRESET_NAMES.map(n => '<option value="' + n + '">' + n + '</option>').join('') +
            '</select></div>' +
            '<div class="row"><span class="label" style="margin:0">Radius:</span>' +
            '<input type="number" id="autoFillerRadius" value="12" min="6" max="24" style="width:60px"/></div>' +
            '<div class="row">' +
            '<label style="font-size:12px;color:#aeb6cc"><input type="checkbox" id="autoFillerAvoid" checked /> Avoid artist streets</label></div>' +
            '<div class="row"><button id="btnAddFillers" class="btn small">Add Fillers</button></div>';

        document.getElementById('selTownPattern').addEventListener('change', (e) => {
            t.pattern = e.target.value;
            t.radius = t.pattern === 'grid5' ? 5 : 3;
            commitEdit('town pattern');
            renderSelectionPanel();
        });
        document.getElementById('selTownRadius').addEventListener('change', (e) => {
            t.radius = Math.max(2, Math.min(8, parseInt(e.target.value) || 3));
            commitEdit('town radius');
        });

        // Spread artists button
        document.getElementById('btnSpreadArtists').addEventListener('click', () => {
            const opts = {
                radius: parseInt(document.getElementById('autoSpreadRadius').value) || 14,
                minSpacing: parseInt(document.getElementById('autoSpreadSpacing').value) || 2,
                preferHighway: document.getElementById('autoSpreadHwy').checked,
                keepNearCore: document.getElementById('autoSpreadCore').checked
            };
            const n = spreadArtistsInTown(sel.id, opts);
            commitEdit('spread artists');
            setStatus('Spread ' + n + '/' + artistCount + ' artists in ' + t.label);
            renderSelectionPanel();
        });

        // Add fillers button
        document.getElementById('btnAddFillers').addEventListener('click', () => {
            const opts = {
                count: parseInt(document.getElementById('autoFillerCount').value) || 10,
                preset: document.getElementById('autoFillerPreset').value || 'downtown',
                radius: parseInt(document.getElementById('autoFillerRadius').value) || 12,
                avoidArtistStreet: document.getElementById('autoFillerAvoid').checked
            };
            const n = addFillersToTown(sel.id, opts);
            commitEdit('add fillers');
            setStatus('Added ' + n + ' fillers near ' + t.label);
            renderSelectionPanel();
        });

        // Background buildings automation
        el.innerHTML +=
            '<div class="label" style="margin:8px 0 4px">Background Buildings</div>' +
            '<div class="row">' +
            '<button id="btnBgLight" class="btn small">+ Light</button>' +
            '<button id="btnBgMedium" class="btn small">+ Medium</button>' +
            '<button id="btnBgHeavy" class="btn small">+ Heavy</button>' +
            '</div>' +
            '<div class="row">' +
            '<button id="btnBgClear" class="btn small">Clear BG</button>' +
            '<button id="btnConvertToBg" class="btn small">Fillers → BG</button>' +
            '</div>';

        ['Light', 'Medium', 'Heavy'].forEach(function(level) {
            document.getElementById('btnBg' + level).addEventListener('click', function() {
                var n = addBgBuildingsToTown(sel.id, level.toLowerCase());
                commitEdit('add bg buildings');
                setStatus('Added ' + n + ' bg buildings near ' + t.label);
                renderSelectionPanel();
            });
        });
        document.getElementById('btnBgClear').addEventListener('click', function() {
            var n = clearBgBuildingsInTown(sel.id);
            commitEdit('clear bg buildings');
            setStatus('Cleared ' + n + ' bg buildings near ' + t.label);
            renderSelectionPanel();
        });
        document.getElementById('btnConvertToBg').addEventListener('click', function() {
            var n = convertFillersToBg(sel.id);
            commitEdit('convert fillers to bg');
            setStatus('Converted ' + n + ' fillers to bg near ' + t.label);
            renderSelectionPanel();
        });

        // Town Health readout (includes bg building count now)
        renderTownHealth(el, t);
    } else if (sel.kind === 'filler') {
        const fb = (st.fillerBuildings || []).find(f => f.id === sel.id);
        if (!fb) { el.textContent = 'filler not found'; return; }
        el.innerHTML =
            '<div>Filler: ' + fb.id + '</div>' +
            '<div>Pos: ' + fb.x + ', ' + fb.y + '</div>' +
            '<div>Type: ' + fb.buildingType + '</div>';
    } else if (sel.kind === 'building') {
        const bp = (st.buildingPlacements || []).find(p => p.buildingId === sel.id);
        if (!bp) { el.textContent = 'building not found'; return; }
        el.innerHTML =
            '<div>Artist Building: ' + bp.buildingId + '</div>' +
            '<div>Pos: ' + bp.x + ', ' + bp.y + '</div>';
    } else if (sel.kind === 'landmark') {
        const lm = editor.derived.landmarkById.get(sel.id);
        if (!lm) { el.textContent = 'landmark not found'; return; }
        el.innerHTML =
            '<div>Landmark: ' + lm.id + '</div>' +
            '<div>Pos: ' + lm.x + ', ' + lm.y + '</div>' +
            '<div>Label: ' + lm.label + '</div>';
    } else {
        el.textContent = 'none';
    }
}

function renderViolationsPanel() {
    const el = document.getElementById('violations');
    const vs = editor.derived.violations;
    if (vs.length === 0) {
        el.innerHTML = '<div style="color:#7adb7a">All checks pass</div>';
        return;
    }
    const errors = vs.filter(v => v.level === 'error');
    const warns = vs.filter(v => v.level === 'warn');
    let html = '';
    if (errors.length > 0) html += '<div class="vErr">' + errors.length + ' errors</div>';
    if (warns.length > 0) html += '<div class="vWarn">' + warns.length + ' warnings</div>';
    for (const v of errors.slice(0, 20)) html += '<div class="vErr">' + v.msg + '</div>';
    for (const v of warns.slice(0, 10)) html += '<div class="vWarn">' + v.msg + '</div>';
    if (errors.length > 20) html += '<div class="vErr">... and ' + (errors.length - 20) + ' more</div>';
    el.innerHTML = html;
}

// ════════════════════════════════════════════════════════════════
// TOWN HEALTH READOUT
// ════════════════════════════════════════════════════════════════

function renderTownHealth(parentEl, town) {
    const st = editor.state;
    const d = editor.derived;
    const W = d.W, H = d.H;

    // Count artist placements for this town
    const townHandles = new Set((town.artists || []).map(h => 'b_' + h.toLowerCase().replace(/\./g, '_')));
    const townPlacements = (st.buildingPlacements || []).filter(p => townHandles.has(p.buildingId));
    const placed = townPlacements.length;
    const expected = town.artists ? town.artists.length : 0;

    // Count fillers near town
    const searchR = 15;
    const nearFillers = (st.fillerBuildings || []).filter(f =>
        Math.abs(f.x - town.x) <= searchR && Math.abs(f.y - town.y) <= searchR
    );

    // Road adjacency failures
    let adjFails = 0;
    for (const p of townPlacements) {
        const k = p.y * W + p.x;
        const adj = (p.x > 0 && d.ROAD_GRID[k - 1]) || (p.x < W - 1 && d.ROAD_GRID[k + 1]) ||
                    (p.y > 0 && d.ROAD_GRID[k - W]) || (p.y < H - 1 && d.ROAD_GRID[k + W]);
        if (!adj) adjFails++;
    }

    // Moat violations within town area
    let moatFails = 0;
    const allB = [...townPlacements.map(p => ({ x: p.x, y: p.y })), ...nearFillers.map(f => ({ x: f.x, y: f.y }))];
    for (let i = 0; i < allB.length; i++) {
        for (let j = i + 1; j < allB.length; j++) {
            if (Math.abs(allB[i].x - allB[j].x) <= 1 && Math.abs(allB[i].y - allB[j].y) <= 1) moatFails++;
        }
    }

    // Road tiles in town radius
    let roadCount = 0;
    const r = town.radius + 2;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const nx = town.x + dx, ny = town.y + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H && d.ROAD_GRID[ny * W + nx]) roadCount++;
    }

    const ok = adjFails === 0 && moatFails === 0 && placed === expected;
    const color = ok ? '#7adb7a' : '#ff6b6b';

    const healthDiv = document.createElement('div');
    healthDiv.style.cssText = 'margin-top:8px; padding:6px; background:#0f1420; border-radius:4px; font-size:11px; font-family:monospace; color:' + color;
    // Count bg buildings near town
    var nearBg = (st.bgBuildings || []).filter(function(bg) {
        return Math.abs(bg.x - town.x) <= searchR && Math.abs(bg.y - town.y) <= searchR;
    });

    healthDiv.innerHTML =
        '<div class="label" style="margin:0 0 4px">Town Health</div>' +
        '<div>Profile: ' + (town.profile || 'suburb') + ' | Density: ' + (town.density || '?') + '</div>' +
        '<div>Artists placed: ' + placed + '/' + expected + (placed < expected ? ' <span style="color:#ff6b6b">MISSING</span>' : ' OK') + '</div>' +
        '<div>Fillers nearby: ' + nearFillers.length + '</div>' +
        '<div>BG buildings: ' + nearBg.length + '</div>' +
        '<div>Road-adj fails: ' + adjFails + (adjFails > 0 ? ' <span style="color:#ff6b6b">FIX</span>' : '') + '</div>' +
        '<div>Moat violations: ' + moatFails + (moatFails > 0 ? ' <span style="color:#ff6b6b">FIX</span>' : '') + '</div>' +
        '<div>Local roads: ' + roadCount + (roadCount < 4 ? ' <span style="color:#ffd36a">LOW</span>' : '') + '</div>';

    parentEl.appendChild(healthDiv);
}

// ════════════════════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════════════════════

function syncRoadTilesFromMap() {
    // Rebuild roadTiles from the authoritative roadKeyToType map
    // (captures both generator roads and town-expanded roads as persisted data)
    // Note: we only export the roads from state.roadTiles, not town-expanded ones
    // Town expansion is deterministic from towns[] and happens in engine at load time
}

function exportFull() {
    const vs = editor.derived.violations.filter(v => v.level === 'error');
    if (vs.length > 0) {
        setStatus('Cannot export: ' + vs.length + ' errors');
        return;
    }
    const data = deepClone(editor.state);
    downloadJSON(data, 'na.json');
    setStatus('Exported na.json');
}

function exportPatch() {
    const vs = editor.derived.violations.filter(v => v.level === 'error');
    if (vs.length > 0) {
        setStatus('Cannot export patch: ' + vs.length + ' errors');
        return;
    }

    const orig = editor.originalState;
    const curr = editor.state;
    const patch = { version: 1, regionId: 'na', overrides: {}, adds: {}, deletes: {}, terrainOverrides: [] };

    // Terrain diffs
    if (Array.isArray(orig.terrainGrid) && Array.isArray(curr.terrainGrid)) {
        for (let y = 0; y < curr.terrainGrid.length; y++) {
            for (let x = 0; x < (curr.terrainGrid[y] || []).length; x++) {
                if (curr.terrainGrid[y][x] !== orig.terrainGrid[y]?.[x]) {
                    patch.terrainOverrides.push({ x, y, type: curr.terrainGrid[y][x] });
                }
            }
        }
    }

    // Road diffs
    diffArrayById(orig.roadTiles || [], curr.roadTiles || [],
        r => r.x + ',' + r.y,
        (o, c) => o.type !== c.type,
        'roadTiles', patch);

    // Town diffs
    diffArrayById(orig.towns || [], curr.towns || [],
        t => t.id,
        (o, c) => JSON.stringify(o) !== JSON.stringify(c),
        'towns', patch);

    // Building placement diffs
    diffArrayById(orig.buildingPlacements || [], curr.buildingPlacements || [],
        p => p.buildingId,
        (o, c) => o.x !== c.x || o.y !== c.y,
        'buildingPlacements', patch);

    // Filler diffs
    diffArrayById(orig.fillerBuildings || [], curr.fillerBuildings || [],
        f => f.id,
        (o, c) => JSON.stringify(o) !== JSON.stringify(c),
        'fillerBuildings', patch);

    // Landmark diffs
    diffArrayById(orig.landmarks || [], curr.landmarks || [],
        l => l.id,
        (o, c) => JSON.stringify(o) !== JSON.stringify(c),
        'landmarks', patch);

    // Clean up empty sections
    if (patch.terrainOverrides.length === 0) delete patch.terrainOverrides;
    for (const section of ['overrides', 'adds', 'deletes']) {
        const obj = patch[section];
        for (const key of Object.keys(obj)) {
            if (Array.isArray(obj[key]) && obj[key].length === 0) delete obj[key];
            else if (typeof obj[key] === 'object' && !Array.isArray(obj[key]) && Object.keys(obj[key]).length === 0) delete obj[key];
        }
        if (Object.keys(obj).length === 0) delete patch[section];
    }

    downloadJSON(patch, 'na.patch.json');
    setStatus('Exported na.patch.json');
}

function diffArrayById(origArr, currArr, keyFn, changedFn, collection, patch) {
    const origMap = new Map();
    for (const item of origArr) origMap.set(keyFn(item), item);

    const currMap = new Map();
    for (const item of currArr) currMap.set(keyFn(item), item);

    // Overrides: items in both but changed
    if (!patch.overrides[collection]) patch.overrides[collection] = {};
    for (const [k, cItem] of currMap) {
        const oItem = origMap.get(k);
        if (oItem && changedFn(oItem, cItem)) {
            patch.overrides[collection][k] = cItem;
        }
    }
    if (Object.keys(patch.overrides[collection]).length === 0) delete patch.overrides[collection];

    // Adds: items in curr but not orig
    const adds = [];
    for (const [k, cItem] of currMap) {
        if (!origMap.has(k)) adds.push(cItem);
    }
    if (adds.length > 0) {
        if (!patch.adds[collection]) patch.adds[collection] = [];
        patch.adds[collection].push(...adds);
    }

    // Deletes: items in orig but not curr
    const deletes = [];
    for (const [k] of origMap) {
        if (!currMap.has(k)) deletes.push(k);
    }
    if (deletes.length > 0) {
        if (!patch.deletes[collection]) patch.deletes[collection] = [];
        patch.deletes[collection].push(...deletes);
    }
}

// ════════════════════════════════════════════════════════════════
// PATCH APPLY (editor-side, for "Load Patch" button)
// ════════════════════════════════════════════════════════════════

function applyPatchToState(patch) {
    const st = editor.state;

    // Terrain overrides
    if (Array.isArray(patch.terrainOverrides)) {
        for (const to of patch.terrainOverrides) {
            if (st.terrainGrid[to.y]) st.terrainGrid[to.y][to.x] = to.type;
        }
    }

    // Overrides (by ID)
    if (patch.overrides) {
        for (const [collection, overrides] of Object.entries(patch.overrides)) {
            const arr = st[collection];
            if (!Array.isArray(arr)) continue;
            for (const [key, vals] of Object.entries(overrides)) {
                const item = arr.find(a => (a.id || a.buildingId || (a.x + ',' + a.y)) === key);
                if (item) Object.assign(item, vals);
            }
        }
    }

    // Adds
    if (patch.adds) {
        for (const [collection, items] of Object.entries(patch.adds)) {
            if (!Array.isArray(st[collection])) st[collection] = [];
            st[collection].push(...items);
        }
    }

    // Deletes
    if (patch.deletes) {
        for (const [collection, ids] of Object.entries(patch.deletes)) {
            if (!Array.isArray(st[collection])) continue;
            const idSet = new Set(ids);
            st[collection] = st[collection].filter(item => {
                const key = item.id || item.buildingId || (item.x + ',' + item.y);
                return !idSet.has(key);
            });
        }
    }
}

// ════════════════════════════════════════════════════════════════
// AUTOMATION: SPREAD ARTISTS
// ════════════════════════════════════════════════════════════════

const SPREAD_DEFAULTS = { radius: 14, minSpacing: 2, preferHighway: true, keepNearCore: true };

function spreadArtistsInTown(townId, opts) {
    const st = editor.state;
    const d = editor.derived;
    const town = (st.towns || []).find(t => t.id === townId);
    if (!town || !town.artists || town.artists.length === 0) {
        setStatus('No artists in town: ' + townId);
        return 0;
    }

    const cx = town.x | 0, cy = town.y | 0;
    const radius = opts.radius || SPREAD_DEFAULTS.radius;
    const minSpace = opts.minSpacing || SPREAD_DEFAULTS.minSpacing;
    const prefHwy = opts.preferHighway !== undefined ? opts.preferHighway : SPREAD_DEFAULTS.preferHighway;
    const nearCore = opts.keepNearCore !== undefined ? opts.keepNearCore : SPREAD_DEFAULTS.keepNearCore;

    // Build artist handle -> buildingId map
    const handleToBuildingId = new Map();
    for (const bp of st.buildingPlacements || []) {
        const bid = bp.buildingId || '';
        const handle = bid.replace(/^b_/, '');
        handleToBuildingId.set(handle, bid);
    }

    // Get artist buildings for this town
    const townArtistIds = [];
    for (const handle of town.artists) {
        const bid = handleToBuildingId.get(handle.toLowerCase().replace(/\./g, '_'));
        if (bid) townArtistIds.push(bid);
    }
    if (townArtistIds.length === 0) {
        setStatus('No placed buildings for town artists');
        return 0;
    }

    // Build occupancy grid (all buildings except the ones we're about to move)
    const movingSet = new Set(townArtistIds);
    const occupied = new Set();
    for (const bp of st.buildingPlacements || []) {
        if (!movingSet.has(bp.buildingId)) {
            addMoatOccupancy(occupied, bp.x, bp.y, d.W, d.H);
        }
    }
    for (const fb of st.fillerBuildings || []) {
        addMoatOccupancy(occupied, fb.x, fb.y, d.W, d.H);
    }

    // Generate candidate tiles in rings around town
    const candidates = [];
    for (let r = 1; r <= radius; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                const tx = cx + dx, ty = cy + dy;
                if (tx < 0 || tx >= d.W || ty < 0 || ty >= d.H) continue;
                const tt = st.terrainGrid[ty]?.[tx] | 0;
                if (tt !== TT.LAND && tt !== TT.MOUNTAIN) continue;
                const key = ty * d.W + tx;
                if (occupied.has(key)) continue;

                // Road adjacency check
                let streetAdj = false, highwayAdj = false;
                const neighbors = [
                    tx > 0 ? key - 1 : -1,
                    tx < d.W - 1 ? key + 1 : -1,
                    ty > 0 ? key - d.W : -1,
                    ty < d.H - 1 ? key + d.W : -1
                ];
                for (const nk of neighbors) {
                    if (nk < 0) continue;
                    if (d.ROAD_TYPE_GRID[nk] === 2) highwayAdj = true;
                    else if (d.ROAD_GRID[nk]) streetAdj = true;
                }
                if (!streetAdj && !highwayAdj) continue;

                // Compute angle bucket (8 buckets for distribution)
                const angle = Math.atan2(dy, dx);
                const bucket = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;

                // Score: higher is better
                const dist = Math.abs(dx) + Math.abs(dy);
                let score = 100 - dist;
                if (streetAdj) score += 20;
                if (highwayAdj && prefHwy) score += 10;
                if (nearCore && dist <= town.radius + 2) score += 15;

                candidates.push({ tx, ty, key, score, bucket, dist, streetAdj, highwayAdj });
            }
        }
    }

    // Sort by score descending, then by bucket for variety
    candidates.sort((a, b) => b.score - a.score || a.bucket - b.bucket);

    // Assign buildings using angle-bucket distribution
    const usedBuckets = new Map();
    const placed = new Set();
    let count = 0;

    // If keepNearCore, first 35% go to closer tiles
    const coreCount = nearCore ? Math.ceil(townArtistIds.length * 0.35) : 0;
    const coreCandidates = candidates.filter(c => c.dist <= town.radius + 2);
    const outerCandidates = candidates.filter(c => c.dist > town.radius + 2);

    function tryPlace(buildingId, candList) {
        for (const c of candList) {
            if (placed.has(c.key)) continue;
            // Check min spacing from already-placed buildings in this batch
            let tooClose = false;
            for (const pk of placed) {
                const px = pk % d.W, py = (pk / d.W) | 0;
                if (Math.abs(c.tx - px) + Math.abs(c.ty - py) < minSpace) {
                    tooClose = true;
                    break;
                }
            }
            if (tooClose) continue;

            // Prefer spreading across angle buckets
            const bucketCount = usedBuckets.get(c.bucket) || 0;
            if (bucketCount >= 2 && candList.some(other =>
                !placed.has(other.key) && (usedBuckets.get(other.bucket) || 0) < bucketCount
            )) continue;

            // Place it
            const bp = (st.buildingPlacements || []).find(p => p.buildingId === buildingId);
            if (bp) {
                bp.x = c.tx;
                bp.y = c.ty;
            }
            placed.add(c.key);
            addMoatOccupancy(occupied, c.tx, c.ty, d.W, d.H);
            usedBuckets.set(c.bucket, bucketCount + 1);
            count++;
            return true;
        }
        return false;
    }

    // Sort artist IDs deterministically by hash
    townArtistIds.sort((a, b) => simpleHash(a) - simpleHash(b));

    // Place core artists first, then outer
    for (let i = 0; i < townArtistIds.length; i++) {
        const bid = townArtistIds[i];
        if (i < coreCount) {
            if (!tryPlace(bid, coreCandidates)) tryPlace(bid, outerCandidates);
        } else {
            if (!tryPlace(bid, outerCandidates)) tryPlace(bid, coreCandidates);
        }
    }

    return count;
}

// ════════════════════════════════════════════════════════════════
// AUTOMATION: ADD FILLER BUILDINGS
// ════════════════════════════════════════════════════════════════

const FILLER_PRESETS = {
    downtown: ['arcade', 'diner', 'toy_shop', 'arcade', 'diner', 'warehouse', 'toy_shop', 'arcade', 'diner', 'garage'],
    industrial: ['warehouse', 'garage', 'warehouse', 'garage', 'diner', 'warehouse', 'garage', 'warehouse', 'hotel', 'garage'],
    tourist: ['hotel', 'diner', 'arcade', 'hotel', 'diner', 'toy_shop', 'arcade', 'hotel', 'diner', 'toy_shop']
};
const FILLER_PRESET_NAMES = Object.keys(FILLER_PRESETS);

const FILLER_DEFAULTS = { count: 10, preset: 'downtown', radius: 12, avoidArtistStreet: true };

function addFillersToTown(townId, opts) {
    const st = editor.state;
    const d = editor.derived;
    const town = (st.towns || []).find(t => t.id === townId);
    if (!town) { setStatus('Town not found: ' + townId); return 0; }

    const cx = town.x | 0, cy = town.y | 0;
    const count = opts.count || FILLER_DEFAULTS.count;
    const preset = FILLER_PRESETS[opts.preset] || FILLER_PRESETS.downtown;
    const radius = opts.radius || FILLER_DEFAULTS.radius;
    const avoidArtist = opts.avoidArtistStreet !== undefined ? opts.avoidArtistStreet : FILLER_DEFAULTS.avoidArtistStreet;

    // Build occupancy grid
    const occupied = new Set();
    for (const bp of st.buildingPlacements || []) {
        addMoatOccupancy(occupied, bp.x, bp.y, d.W, d.H);
    }
    for (const fb of st.fillerBuildings || []) {
        addMoatOccupancy(occupied, fb.x, fb.y, d.W, d.H);
    }

    // Build "artist road set" if avoiding artist frontage
    const artistRoadSet = new Set();
    if (avoidArtist) {
        for (const bp of st.buildingPlacements || []) {
            const k = (bp.y | 0) * d.W + (bp.x | 0);
            for (const nk of [k - 1, k + 1, k - d.W, k + d.W]) {
                if (nk >= 0 && nk < d.W * d.H && d.ROAD_GRID[nk]) {
                    artistRoadSet.add(nk);
                }
            }
        }
    }

    // Generate candidate tiles
    const candidates = [];
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            const tx = cx + dx, ty = cy + dy;
            if (tx < 0 || tx >= d.W || ty < 0 || ty >= d.H) continue;
            const tt = st.terrainGrid[ty]?.[tx] | 0;
            if (tt !== TT.LAND && tt !== TT.MOUNTAIN) continue;
            const key = ty * d.W + tx;
            if (occupied.has(key)) continue;

            // Road adjacency
            let adj = false;
            for (const nk of [key - 1, key + 1, key - d.W, key + d.W]) {
                if (nk >= 0 && nk < d.W * d.H && d.ROAD_GRID[nk]) { adj = true; break; }
            }
            if (!adj) continue;

            // Score: prefer secondary streets over artist frontage
            const dist = Math.abs(dx) + Math.abs(dy);
            let score = 100 - dist;
            if (avoidArtist) {
                let nearArtistRoad = false;
                for (const nk of [key - 1, key + 1, key - d.W, key + d.W]) {
                    if (artistRoadSet.has(nk)) { nearArtistRoad = true; break; }
                }
                if (nearArtistRoad) score -= 40;
            }

            candidates.push({ tx, ty, key, score, dist });
        }
    }

    candidates.sort((a, b) => b.score - a.score);

    // Place fillers
    if (!Array.isArray(st.fillerBuildings)) st.fillerBuildings = [];
    const placed = new Set();
    let added = 0;
    const existingIds = new Set((st.fillerBuildings || []).map(f => f.id));

    for (let i = 0; i < count; i++) {
        const fType = preset[i % preset.length];
        let didPlace = false;
        for (const c of candidates) {
            if (placed.has(c.key) || occupied.has(c.key)) continue;

            // Check min spacing from this batch
            let tooClose = false;
            for (const pk of placed) {
                const px = pk % d.W, py = (pk / d.W) | 0;
                if (Math.abs(c.tx - px) <= 1 && Math.abs(c.ty - py) <= 1) { tooClose = true; break; }
            }
            if (tooClose) continue;

            // Generate unique ID
            let fId = 'filler_' + townId + '_' + fType + '_' + i;
            let suffix = 0;
            while (existingIds.has(fId)) { fId = 'filler_' + townId + '_' + fType + '_' + i + '_' + (++suffix); }

            st.fillerBuildings.push({ id: fId, x: c.tx, y: c.ty, buildingType: fType });
            existingIds.add(fId);
            placed.add(c.key);
            addMoatOccupancy(occupied, c.tx, c.ty, d.W, d.H);
            added++;
            didPlace = true;
            break;
        }
        if (!didPlace) break;
    }

    return added;
}

// ════════════════════════════════════════════════════════════════
// AUTOMATION: BACKGROUND BUILDINGS
// ════════════════════════════════════════════════════════════════

const BG_KINDS = ['apt_small', 'apt_tall', 'office', 'house', 'shopfront', 'warehouse_bg'];
const BG_PROFILE_MIX = {
    downtown:      ['apt_tall', 'office', 'apt_tall', 'shopfront', 'office', 'apt_small'],
    industrial:    ['warehouse_bg', 'warehouse_bg', 'apt_small', 'warehouse_bg', 'office', 'apt_small'],
    tourist:       ['shopfront', 'house', 'shopfront', 'apt_small', 'house', 'shopfront'],
    suburb:        ['house', 'house', 'apt_small', 'house', 'house', 'shopfront'],
    arts_district: ['shopfront', 'apt_tall', 'apt_small', 'shopfront', 'office', 'apt_tall']
};

function addBgBuildingsToTown(townId, density) {
    const st = editor.state;
    const d = editor.derived;
    const town = (st.towns || []).find(t => t.id === townId);
    if (!town) { setStatus('Town not found: ' + townId); return 0; }

    const cx = town.x | 0, cy = town.y | 0;
    const profile = town.profile || 'suburb';
    const mix = BG_PROFILE_MIX[profile] || BG_PROFILE_MIX.suburb;

    // density: 'light'=6, 'medium'=12, 'heavy'=20
    var count = density === 'heavy' ? 20 : density === 'medium' ? 12 : 6;
    var bgRadius = (town.radius || 5) + (town.tier === 'A' ? 6 : 3);

    // Build occupancy from all building types
    var occupied = new Set();
    for (const bp of st.buildingPlacements || []) occupied.add(bp.y * d.W + bp.x);
    for (const fb of st.fillerBuildings || []) occupied.add(fb.y * d.W + fb.x);
    for (const bg of st.bgBuildings || []) occupied.add(bg.y * d.W + bg.x);

    var cands = [];
    for (var dy = -bgRadius; dy <= bgRadius; dy++) {
        for (var dx = -bgRadius; dx <= bgRadius; dx++) {
            var tx = cx + dx, ty = cy + dy;
            if (tx < 0 || tx >= d.W || ty < 0 || ty >= d.H) continue;
            var tt = st.terrainGrid[ty] ? (st.terrainGrid[ty][tx] | 0) : 0;
            if (tt !== TT.LAND && tt !== TT.MOUNTAIN) continue;
            var key = ty * d.W + tx;
            if (occupied.has(key)) continue;
            if (d.ROAD_GRID[key]) continue;
            // Near a road (within 2 tiles)
            var nearRoad = false;
            for (var ndy = -2; ndy <= 2 && !nearRoad; ndy++) {
                for (var ndx = -2; ndx <= 2 && !nearRoad; ndx++) {
                    var nk = (ty + ndy) * d.W + (tx + ndx);
                    if (nk >= 0 && nk < d.W * d.H && d.ROAD_GRID[nk]) nearRoad = true;
                }
            }
            if (!nearRoad) continue;
            cands.push({ tx: tx, ty: ty, key: key, dist: Math.abs(dx) + Math.abs(dy) });
        }
    }
    cands.sort(function(a, b) { return a.dist - b.dist; });

    if (!Array.isArray(st.bgBuildings)) st.bgBuildings = [];
    var placed = new Set();
    var added = 0;
    for (var i = 0; i < cands.length && added < count; i++) {
        var c = cands[i];
        if (placed.has(c.key)) continue;
        var tooClose = false;
        for (var pk of placed) {
            var px = pk % d.W, py = (pk / d.W) | 0;
            if (Math.abs(c.tx - px) <= 1 && Math.abs(c.ty - py) <= 1) { tooClose = true; break; }
        }
        if (tooClose) continue;
        st.bgBuildings.push({ x: c.tx, y: c.ty, kind: mix[added % mix.length] });
        placed.add(c.key);
        added++;
    }
    return added;
}

function clearBgBuildingsInTown(townId) {
    const st = editor.state;
    const town = (st.towns || []).find(t => t.id === townId);
    if (!town || !st.bgBuildings) return 0;
    var r = (town.radius || 5) + 8;
    var before = st.bgBuildings.length;
    st.bgBuildings = st.bgBuildings.filter(function(bg) {
        return Math.abs(bg.x - town.x) > r || Math.abs(bg.y - town.y) > r;
    });
    return before - st.bgBuildings.length;
}

function convertFillersToBg(townId) {
    const st = editor.state;
    const town = (st.towns || []).find(t => t.id === townId);
    if (!town) return 0;
    var r = (town.radius || 5) + 8;
    if (!Array.isArray(st.bgBuildings)) st.bgBuildings = [];

    var toConvert = [];
    var keep = [];
    for (var i = 0; i < (st.fillerBuildings || []).length; i++) {
        var f = st.fillerBuildings[i];
        if (Math.abs(f.x - town.x) <= r && Math.abs(f.y - town.y) <= r) {
            toConvert.push(f);
        } else {
            keep.push(f);
        }
    }
    for (var j = 0; j < toConvert.length; j++) {
        var kind = BG_KINDS[simpleHash(toConvert[j].id) % BG_KINDS.length];
        st.bgBuildings.push({ x: toConvert[j].x, y: toConvert[j].y, kind: kind });
    }
    st.fillerBuildings = keep;
    return toConvert.length;
}

// ════════════════════════════════════════════════════════════════
// AUTOMATION: SHARED HELPERS
// ════════════════════════════════════════════════════════════════

function addMoatOccupancy(set, x, y, W, H) {
    for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
            const nx = x + ox, ny = y + oy;
            if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                set.add(ny * W + nx);
            }
        }
    }
}

function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h >>> 0;
}

// ════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', boot);
