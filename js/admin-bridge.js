/* ================================================================
   admin-bridge.js — Sync bridge between Admin Dashboard and Game
   
   Include this script BEFORE game.js in index.html.
   It intercepts fetch() calls for game data files and returns
   admin-edited versions from localStorage when available.
   
   Also applies pattern overrides to NES.PATTERNS after game.js loads.
   ================================================================ */

(function () {
    'use strict';

    var SYNC_PREFIX = 'adminSync_';

    // Check if admin has synced any data
    var timestamp = localStorage.getItem(SYNC_PREFIX + 'timestamp');
    if (!timestamp) return; // No admin data — do nothing, game loads normally

    console.log('[admin-bridge] Admin data found (synced ' + new Date(parseInt(timestamp)).toLocaleString() + ')');

    // Map of fetch URLs to localStorage keys
    var URL_MAP = {
        'data/artists.json':      SYNC_PREFIX + 'artists',
        'data/buildings.json':    SYNC_PREFIX + 'buildings',
        'data/world.json':        SYNC_PREFIX + 'world',
        'data/regions/na.json':   SYNC_PREFIX + 'region_na',
        'data/regions/sa.json':   SYNC_PREFIX + 'region_sa',
        'data/regions/eu.json':   SYNC_PREFIX + 'region_eu',
        'data/regions/asia.json': SYNC_PREFIX + 'region_asia',
        'data/regions/oce.json':  SYNC_PREFIX + 'region_oce'
    };

    // Patch window.fetch to intercept data file requests
    var _origFetch = window.fetch;
    window._origFetch = _origFetch;
    window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');

        // Normalize: strip leading ./ or / and query params
        var cleanUrl = url.replace(/^\.\//, '').replace(/\?.*$/, '');

        var storageKey = URL_MAP[cleanUrl];
        if (storageKey) {
            var stored = localStorage.getItem(storageKey);
            if (stored) {
                // Validate region data before serving from cache
                if (cleanUrl.indexOf('data/regions/') === 0) {
                    try {
                        var parsed = JSON.parse(stored);
                        if (!parsed || !parsed.world || !parsed.terrainGrid ||
                            !Array.isArray(parsed.terrainGrid) || parsed.terrainGrid.length < 10) {
                            console.warn('[admin-bridge] Stale/empty region cache for ' + cleanUrl + ', bypassing');
                            localStorage.removeItem(storageKey);
                            return _origFetch.apply(this, arguments);
                        }
                    } catch (e) {
                        console.warn('[admin-bridge] Invalid JSON in cache for ' + cleanUrl + ', bypassing');
                        localStorage.removeItem(storageKey);
                        return _origFetch.apply(this, arguments);
                    }
                }
                console.log('[admin-bridge] Serving ' + cleanUrl + ' from admin localStorage');
                return Promise.resolve(new Response(stored, {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                }));
            }
        }

        // Fall through to real fetch for everything else
        return _origFetch.apply(this, arguments);
    };

    // Apply pattern overrides after game.js defines NES
    // We use a polling approach since game.js loads asynchronously
    var _patternCheckInterval = setInterval(function () {
        if (typeof NES === 'undefined' || !NES.PATTERNS) return;
        clearInterval(_patternCheckInterval);

        var stored = localStorage.getItem(SYNC_PREFIX + 'patterns');
        if (!stored) return;

        try {
            var patterns = JSON.parse(stored);
            var keys = Object.keys(patterns);
            var applied = 0, skipped = 0;
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                var pat = patterns[k];
                // Skip corrupted patterns: must be a non-empty array of strings
                if (!Array.isArray(pat) || pat.length === 0 || typeof pat[0] !== 'string') {
                    console.warn('[admin-bridge] Skipping corrupted pattern: ' + k);
                    skipped++;
                    continue;
                }
                // If original exists, skip if cached version has wildly different dimensions
                var orig = NES.PATTERNS[k];
                if (orig && Array.isArray(orig) && orig.length > 0) {
                    var origW = orig[0].length, origH = orig.length;
                    var newW = pat[0].length, newH = pat.length;
                    if (Math.abs(newW - origW) > origW || Math.abs(newH - origH) > origH) {
                        console.warn('[admin-bridge] Skipping mismatched pattern ' + k +
                            ': orig=' + origW + 'x' + origH + ', cached=' + newW + 'x' + newH);
                        skipped++;
                        continue;
                    }
                }
                NES.PATTERNS[k] = pat;
                applied++;
            }
            if (NES.invalidateTileCache) NES.invalidateTileCache();
            console.log('[admin-bridge] Applied ' + applied + ' pattern overrides' +
                (skipped ? ', skipped ' + skipped + ' corrupted' : ''));
        } catch (e) {
            console.warn('[admin-bridge] Failed to apply patterns:', e.message);
        }
    }, 50);

    // Safety: stop checking after 10 seconds
    setTimeout(function () { clearInterval(_patternCheckInterval); }, 10000);
})();
