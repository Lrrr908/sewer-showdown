/* ================================================================
   admin.js — Core framework for the Dev Admin Dashboard
   Tab manager, shared palette, data loading, import/export hub
   ================================================================ */

var Admin = (function () {
    'use strict';

    // Palette provided by js/shared/palette.js
    var PAL = window.PAL;
    var PAL_KEYS = window.PALKEYS.concat(['.']);
    var PAL_DRAW_KEYS = window.PALKEYS;

    var activePalKey = 'K';
    var PATTERNS = {};

    // ── Loaded data (shared across tabs) ──
    var data = {
        artists: [],
        buildings: [],
        regions: {},   // keyed by id: na, sa, eu, asia, oce
        world: null,
        levels: {}     // keyed by filename
    };

    // ── Tab system ──
    var currentTab = 'sprites';
    var tabInitializers = {};
    var tabActivators = {};

    function initTabs() {
        var btns = document.querySelectorAll('.tab-btn');
        btns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                switchTab(btn.dataset.tab);
            });
        });
    }

    function switchTab(id) {
        if (id === currentTab) return;
        document.querySelectorAll('#tabBar > .tab-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === id); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + id); });
        currentTab = id;
        if (tabActivators[id]) tabActivators[id]();
    }

    function registerTab(id, initFn, activateFn) {
        tabInitializers[id] = initFn;
        if (activateFn) tabActivators[id] = activateFn;
    }

    // ── Helpers ──
    function $(sel, parent) { return (parent || document).querySelector(sel); }
    function $$(sel, parent) { return Array.from((parent || document).querySelectorAll(sel)); }

    function el(tag, attrs, children) {
        var e = document.createElement(tag);
        if (attrs) {
            for (var k in attrs) {
                if (k === 'className') e.className = attrs[k];
                else if (k === 'textContent') e.textContent = attrs[k];
                else if (k === 'innerHTML') e.innerHTML = attrs[k];
                else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(e.style, attrs[k]);
                else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
                else e.setAttribute(k, attrs[k]);
            }
        }
        if (children) {
            if (!Array.isArray(children)) children = [children];
            children.forEach(function (c) {
                if (typeof c === 'string') e.appendChild(document.createTextNode(c));
                else if (c) e.appendChild(c);
            });
        }
        return e;
    }

    function hexToRgb(hex) {
        var n = parseInt(hex.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function colorDist(r1, g1, b1, r2, g2, b2) {
        var dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
        return dr * dr + dg * dg + db * db;
    }

    function nearestPalKey(r, g, b) {
        var best = '.', bestD = Infinity;
        for (var i = 0; i < PAL_DRAW_KEYS.length; i++) {
            var k = PAL_DRAW_KEYS[i];
            var rgb = hexToRgb(PAL[k]);
            var d = colorDist(r, g, b, rgb[0], rgb[1], rgb[2]);
            if (d < bestD) { bestD = d; best = k; }
        }
        return best;
    }

    function renderPattern(ctx, pat, px, py, scale) {
        for (var r = 0; r < pat.length; r++) {
            var row = pat[r];
            for (var c = 0; c < row.length; c++) {
                var ch = row[c];
                if (ch === '.' || ch === ' ') continue;
                var color = PAL[ch];
                if (!color) continue;
                ctx.fillStyle = color;
                ctx.fillRect(px + c * scale, py + r * scale, scale, scale);
            }
        }
    }

    function renderPatternToCanvas(canvas, pat, scale) {
        var rows = pat.length, cols = pat[0].length;
        var dpr = window.devicePixelRatio || 1;
        var logW = cols * scale, logH = rows * scale;
        canvas.width = Math.round(logW * dpr);
        canvas.height = Math.round(logH * dpr);
        canvas.style.width = logW + 'px';
        canvas.style.height = logH + 'px';
        var ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, logW, logH);
        renderPattern(ctx, pat, 0, 0, scale);
        return ctx;
    }

    function downloadJSON(obj, filename) {
        var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function downloadText(text, filename) {
        var blob = new Blob([text], { type: 'text/plain' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function readFileAsText(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(reader.result); };
            reader.onerror = reject;
            reader.readAsText(file);
        });
    }

    function readFileAsDataURL(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(reader.result); };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function promptFile(accept) {
        return new Promise(function (resolve) {
            var inp = document.getElementById('globalFileInput');
            if (accept) inp.accept = accept;
            inp.value = '';
            inp.onchange = function () { resolve(inp.files[0] || null); };
            inp.click();
        });
    }

    // ── Data loading ──
    async function fetchJSON(url) {
        var resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
        return resp.json();
    }

    function tryLoadFromStorage(key) {
        try {
            var raw = localStorage.getItem(SYNC_PREFIX + key);
            if (raw) return JSON.parse(raw);
        } catch (e) { /* ignore parse errors */ }
        return null;
    }

    async function loadAllData() {
        // Check if we have previously-saved admin data in localStorage
        var hasAdminData = !!localStorage.getItem(SYNC_PREFIX + 'timestamp');

        try {
            var [artists, buildings, world] = await Promise.all([
                fetchJSON('data/artists.json'),
                fetchJSON('data/buildings.json'),
                fetchJSON('data/world.json')
            ]);
            data.artists = artists.artists || artists;
            data.buildings = buildings.buildings || buildings;
            data.world = world;
        } catch (e) {
            console.warn('Failed to load some data:', e.message);
        }

        var regionIds = ['na', 'sa', 'eu', 'asia', 'oce'];
        for (var i = 0; i < regionIds.length; i++) {
            try {
                data.regions[regionIds[i]] = await fetchJSON('data/regions/' + regionIds[i] + '.json');
            } catch (e) {
                console.warn('Region ' + regionIds[i] + ' not loaded:', e.message);
            }
        }

        // Copy patterns from game engine
        if (typeof NES !== 'undefined' && NES.PATTERNS) {
            PATTERNS = NES.PATTERNS;
        }

        // Load level files via manifest
        try {
            var levelIndex = await fetchJSON('data/levels/index.json');
            for (var li = 0; li < levelIndex.length; li++) {
                try {
                    var lvl = await fetchJSON('data/levels/' + levelIndex[li]);
                    var key = lvl.id || levelIndex[li].replace('.json', '');
                    data.levels[key] = lvl;
                } catch (e) {
                    console.warn('Level ' + levelIndex[li] + ' not loaded:', e.message);
                }
            }
        } catch (e) {
            console.warn('Level index not found:', e.message);
        }

        // Restore admin edits from localStorage (overrides file data)
        if (hasAdminData) {
            console.log('Admin: restoring saved edits from localStorage');
            var savedArtists = tryLoadFromStorage('artists');
            if (savedArtists && savedArtists.artists) data.artists = savedArtists.artists;

            var savedBuildings = tryLoadFromStorage('buildings');
            if (savedBuildings && savedBuildings.buildings) data.buildings = savedBuildings.buildings;

            var savedWorld = tryLoadFromStorage('world');
            if (savedWorld) data.world = savedWorld;

            for (var ri = 0; ri < regionIds.length; ri++) {
                var savedRegion = tryLoadFromStorage('region_' + regionIds[ri]);
                if (savedRegion && savedRegion.world &&
                    Array.isArray(savedRegion.terrainGrid) && savedRegion.terrainGrid.length > 10) {
                    data.regions[regionIds[ri]] = savedRegion;
                } else if (savedRegion) {
                    console.warn('Admin: discarding stale/empty cached region ' + regionIds[ri]);
                    localStorage.removeItem(SYNC_PREFIX + 'region_' + regionIds[ri]);
                }
            }

            var savedLevels = tryLoadFromStorage('levels');
            if (savedLevels) {
                var lvlKeys = Object.keys(savedLevels);
                for (var lk = 0; lk < lvlKeys.length; lk++) {
                    data.levels[lvlKeys[lk]] = savedLevels[lvlKeys[lk]];
                }
            }

            var savedPatterns = tryLoadFromStorage('patterns');
            if (savedPatterns) {
                var patKeys = Object.keys(savedPatterns);
                for (var pk = 0; pk < patKeys.length; pk++) {
                    PATTERNS[patKeys[pk]] = savedPatterns[patKeys[pk]];
                }
                if (typeof NES !== 'undefined' && NES.invalidateTileCache) NES.invalidateTileCache();
                console.log('Admin: restored ' + patKeys.length + ' pattern overrides');
            }
        }

        console.log('Admin data loaded:', {
            artists: data.artists.length,
            buildings: data.buildings.length,
            regions: Object.keys(data.regions),
            levels: Object.keys(data.levels).length,
            patterns: Object.keys(PATTERNS).length
        });
    }

    // ── Import/Export hub (Tab 6) ──
    function initDataHub() {
        var panel = document.getElementById('tab-data');
        panel.id = 'tab-data';
        panel.innerHTML = '';
        panel.style.cssText = 'flex-direction:column;gap:12px;padding:20px;';

        var title = el('div', { className: 'panel-title', style: { fontSize: '16px', marginBottom: '12px' } }, 'Import / Export Hub');
        panel.appendChild(title);

        var grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: '12px' } });

        // Export cards
        var exports = [
            { label: 'All Patterns as JS', desc: 'Copy-paste into game.js', fn: exportPatternsJS },
            { label: 'All Patterns as JSON', desc: 'Backup of all NES patterns', fn: exportPatternsJSON },
            { label: 'Artists JSON', desc: 'data/artists.json', fn: function () { downloadJSON({ artists: data.artists }, 'artists.json'); } },
            { label: 'Buildings JSON', desc: 'data/buildings.json', fn: function () { downloadJSON({ buildings: data.buildings }, 'buildings.json'); } },
            { label: 'World JSON', desc: 'data/world.json', fn: function () { if (data.world) downloadJSON(data.world, 'world.json'); } },
            { label: 'Region NA', desc: 'data/regions/na.json', fn: function () { if (data.regions.na) downloadJSON(data.regions.na, 'na.json'); } }
        ];

        exports.forEach(function (exp) {
            var card = el('div', { className: 'panel col', style: { gap: '8px' } });
            card.appendChild(el('div', { className: 'panel-title', textContent: 'Export: ' + exp.label }));
            card.appendChild(el('div', { style: { fontSize: '11px', color: 'var(--muted)' }, textContent: exp.desc }));
            card.appendChild(el('button', { className: 'btn success small', textContent: 'Download', onClick: exp.fn }));
            grid.appendChild(card);
        });

        // Import card
        var importCard = el('div', { className: 'panel col', style: { gap: '8px' } });
        importCard.appendChild(el('div', { className: 'panel-title', textContent: 'Import JSON' }));
        importCard.appendChild(el('div', { style: { fontSize: '11px', color: 'var(--muted)' }, textContent: 'Load any game JSON (artists, buildings, regions, levels, world)' }));
        var importStatus = el('div', { className: 'status-msg' });
        importCard.appendChild(el('button', { className: 'btn primary small', textContent: 'Choose File...', onClick: async function () {
            var file = await promptFile('.json');
            if (!file) return;
            try {
                var text = await readFileAsText(file);
                var obj = JSON.parse(text);
                var imported = identifyAndImport(obj, file.name);
                importStatus.textContent = imported;
            } catch (e) {
                importStatus.textContent = 'Error: ' + e.message;
                importStatus.style.color = 'var(--red)';
            }
        }}));
        importCard.appendChild(importStatus);
        grid.appendChild(importCard);

        // Backup/Restore
        var backupCard = el('div', { className: 'panel col', style: { gap: '8px' } });
        backupCard.appendChild(el('div', { className: 'panel-title', textContent: 'Full Project Snapshot' }));
        backupCard.appendChild(el('div', { style: { fontSize: '11px', color: 'var(--muted)' }, textContent: 'Save/restore complete project state' }));
        var snapRow = el('div', { className: 'btn-row' });
        snapRow.appendChild(el('button', { className: 'btn success small', textContent: 'Save Snapshot', onClick: function () {
            var snapshot = { version: 1, timestamp: Date.now(), data: data, patterns: serializePatterns() };
            downloadJSON(snapshot, 'admin_snapshot_' + Date.now() + '.json');
        }}));
        snapRow.appendChild(el('button', { className: 'btn primary small', textContent: 'Restore Snapshot', onClick: async function () {
            var file = await promptFile('.json');
            if (!file) return;
            try {
                var text = await readFileAsText(file);
                var snap = JSON.parse(text);
                if (snap.data) {
                    if (snap.data.artists) data.artists = snap.data.artists;
                    if (snap.data.buildings) data.buildings = snap.data.buildings;
                    if (snap.data.world) data.world = snap.data.world;
                    if (snap.data.regions) data.regions = snap.data.regions;
                }
                if (snap.patterns) restorePatterns(snap.patterns);
                importStatus.textContent = 'Snapshot restored';
            } catch (e) {
                importStatus.textContent = 'Error: ' + e.message;
            }
        }}));
        backupCard.appendChild(snapRow);
        grid.appendChild(backupCard);

        panel.appendChild(grid);
    }

    function identifyAndImport(obj, filename) {
        if (obj.artists && Array.isArray(obj.artists)) {
            data.artists = obj.artists;
            return 'Imported ' + obj.artists.length + ' artists';
        }
        if (obj.buildings && Array.isArray(obj.buildings)) {
            data.buildings = obj.buildings;
            return 'Imported ' + obj.buildings.length + ' buildings';
        }
        if (obj.world && obj.tiles) {
            data.world = obj;
            return 'Imported world map';
        }
        if (obj.world && obj.terrainGrid) {
            var id = filename.replace('.json', '');
            data.regions[id] = obj;
            return 'Imported region: ' + id;
        }
        if (obj.tilemap && obj.spawns) {
            data.levels[obj.id || filename] = obj;
            return 'Imported level: ' + (obj.name || filename);
        }
        return 'Unknown format — stored as levels/' + filename;
    }

    function serializePatterns() {
        var out = {};
        var keys = Object.keys(PATTERNS);
        for (var i = 0; i < keys.length; i++) {
            out[keys[i]] = PATTERNS[keys[i]];
        }
        return out;
    }

    function restorePatterns(obj) {
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length; i++) {
            PATTERNS[keys[i]] = obj[keys[i]];
        }
    }

    function exportPatternsJS() {
        var lines = ['// ── NES PATTERNS (auto-exported from Admin) ──'];
        var keys = Object.keys(PATTERNS);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i], pat = PATTERNS[k];
            lines.push('    PATTERNS.' + k + ' = [');
            for (var r = 0; r < pat.length; r++) {
                var comma = r < pat.length - 1 ? ',' : '';
                lines.push("        '" + pat[r] + "'" + comma);
            }
            lines.push('    ];');
            lines.push('');
        }
        downloadText(lines.join('\n'), 'patterns_export.js');
    }

    function exportPatternsJSON() {
        downloadJSON(serializePatterns(), 'patterns_export.json');
    }

    // ── localStorage sync ──
    // Persists admin data so the game page can pick it up via admin-bridge.js
    var SYNC_PREFIX = 'adminSync_';
    var _syncTimer = null;

    function scheduleSave() {
        if (_syncTimer) clearTimeout(_syncTimer);
        _syncTimer = setTimeout(saveToLocalStorage, 300);
    }

    function saveToLocalStorage() {
        try {
            if (data.artists && data.artists.length)
                localStorage.setItem(SYNC_PREFIX + 'artists', JSON.stringify({ artists: data.artists }));
            if (data.buildings && data.buildings.length)
                localStorage.setItem(SYNC_PREFIX + 'buildings', JSON.stringify({ buildings: data.buildings }));
            if (data.world)
                localStorage.setItem(SYNC_PREFIX + 'world', JSON.stringify(data.world));

            var regionIds = Object.keys(data.regions);
            for (var i = 0; i < regionIds.length; i++) {
                if (data.regions[regionIds[i]])
                    localStorage.setItem(SYNC_PREFIX + 'region_' + regionIds[i], JSON.stringify(data.regions[regionIds[i]]));
            }

            // Patterns (only those that differ from the originals, or all if we can't tell)
            if (Object.keys(PATTERNS).length > 0)
                localStorage.setItem(SYNC_PREFIX + 'patterns', JSON.stringify(serializePatterns()));

            // Levels
            var levelKeys = Object.keys(data.levels);
            if (levelKeys.length > 0)
                localStorage.setItem(SYNC_PREFIX + 'levels', JSON.stringify(data.levels));

            localStorage.setItem(SYNC_PREFIX + 'timestamp', String(Date.now()));
            console.log('Admin: synced to localStorage');
        } catch (e) {
            console.warn('Admin: localStorage save failed', e.message);
        }
    }

    function clearSync() {
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf(SYNC_PREFIX) === 0) keys.push(k);
        }
        keys.forEach(function (k) { localStorage.removeItem(k); });
        console.log('Admin: cleared sync data (' + keys.length + ' keys)');
    }

    // ── Boot ──
    async function boot() {
        initTabs();
        await loadAllData();

        // Initialize all registered tabs
        var ids = Object.keys(tabInitializers);
        for (var i = 0; i < ids.length; i++) {
            try { tabInitializers[ids[i]](); }
            catch (e) { console.error('Tab init failed for ' + ids[i] + ':', e); }
        }

        initDataHub();

        // Activate current tab
        if (tabActivators[currentTab]) tabActivators[currentTab]();

        // Initial sync to localStorage
        saveToLocalStorage();

        // Show persistence badge
        var ts = localStorage.getItem(SYNC_PREFIX + 'timestamp');
        if (ts) {
            var badge = el('span', {
                className: 'badge badge-green',
                style: { marginLeft: 'auto', marginRight: '8px', alignSelf: 'center', fontSize: '9px' },
                textContent: 'Saved ' + new Date(parseInt(ts)).toLocaleTimeString()
            });
            document.getElementById('tabBar').appendChild(badge);
            _syncBadge = badge;
        }

        console.log('Admin dashboard ready (changes auto-sync to game)');
    }

    var _syncBadge = null;
    function updateSyncBadge() {
        var ts = localStorage.getItem(SYNC_PREFIX + 'timestamp');
        if (_syncBadge && ts) {
            _syncBadge.textContent = 'Saved ' + new Date(parseInt(ts)).toLocaleTimeString();
        }
    }

    var _origSave = saveToLocalStorage;
    saveToLocalStorage = function () {
        _origSave();
        updateSyncBadge();
    };

    document.addEventListener('DOMContentLoaded', boot);

    return {
        PAL: PAL,
        PAL_KEYS: PAL_KEYS,
        PAL_DRAW_KEYS: PAL_DRAW_KEYS,
        PATTERNS: PATTERNS,
        data: data,
        get activePalKey() { return activePalKey; },
        set activePalKey(v) { activePalKey = v; },
        registerTab: registerTab,
        $: $, $$: $$, el: el,
        hexToRgb: hexToRgb,
        nearestPalKey: nearestPalKey,
        renderPattern: renderPattern,
        renderPatternToCanvas: renderPatternToCanvas,
        downloadJSON: downloadJSON,
        downloadText: downloadText,
        readFileAsText: readFileAsText,
        readFileAsDataURL: readFileAsDataURL,
        promptFile: promptFile,
        scheduleSave: scheduleSave,
        saveNow: saveToLocalStorage,
        clearSync: clearSync
    };
})();
