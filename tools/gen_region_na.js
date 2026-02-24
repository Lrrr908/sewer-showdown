#!/usr/bin/env node
// tools/gen_region_na.js
// Generates data/regions/na.json — USA driving map with real geography.
// Depends on: tools/geo_cache/ (Natural Earth, cached by gen_world_map.js)
//             data/artist_locations.json
//             data/buildings.json
//
// Usage: node tools/gen_region_na.js
// Run gen_world_map.js first to cache Natural Earth data.

'use strict';

const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────
const CFG = {
    gridW: 120,
    gridH: 80,
    tileSize: 64,
    // USA-focused bbox
    latMin: 18,  latMax: 50,
    lonMin: -130, lonMax: -60,
};

const CACHE_DIR  = path.join(__dirname, 'geo_cache');
const DATA_DIR   = path.join(__dirname, '..', 'data');
const OUTPUT     = path.join(DATA_DIR, 'regions', 'na.json');
const OUTPUT_MAP = path.join(DATA_DIR, 'map.json');

// Tile types (same as world gen)
const OCEAN = 0, COAST = 1, LAND = 2, MOUNTAIN = 3, RIVER = 4;

// ── Projection ─────────────────────────────────────────────────
function projectToRegion(lat, lon) {
    const x = (lon - CFG.lonMin) / (CFG.lonMax - CFG.lonMin);
    const y = (CFG.latMax - lat) / (CFG.latMax - CFG.latMin);
    return {
        tx: Math.min(CFG.gridW - 1, Math.max(0, Math.floor(x * CFG.gridW))),
        ty: Math.min(CFG.gridH - 1, Math.max(0, Math.floor(y * CFG.gridH)))
    };
}

function regionTileToLonLat(tx, ty) {
    return {
        lon: CFG.lonMin + ((tx + 0.5) / CFG.gridW) * (CFG.lonMax - CFG.lonMin),
        lat: CFG.latMax - ((ty + 0.5) / CFG.gridH) * (CFG.latMax - CFG.latMin)
    };
}

// ── Geometry (reused from gen_world_map.js) ────────────────────
function computeFeatureBBoxes(features) {
    for (const f of features) {
        let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
        function scan(ring) {
            for (const pt of ring) {
                if (pt[0] < minLon) minLon = pt[0]; if (pt[0] > maxLon) maxLon = pt[0];
                if (pt[1] < minLat) minLat = pt[1]; if (pt[1] > maxLat) maxLat = pt[1];
            }
        }
        const g = f.geometry;
        if (g.type === 'Polygon') for (const r of g.coordinates) scan(r);
        else if (g.type === 'MultiPolygon') for (const p of g.coordinates) for (const r of p) scan(r);
        f._bbox = { minLon, maxLon, minLat, maxLat };
    }
}

function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function pointInPolygon(lon, lat, coords) {
    if (!pointInRing(lon, lat, coords[0])) return false;
    for (let i = 1; i < coords.length; i++) { if (pointInRing(lon, lat, coords[i])) return false; }
    return true;
}

function isOnLand(lon, lat, features) {
    for (const f of features) {
        const bb = f._bbox;
        if (bb && (lon < bb.minLon || lon > bb.maxLon || lat < bb.minLat || lat > bb.maxLat)) continue;
        const g = f.geometry;
        if (g.type === 'Polygon') { if (pointInPolygon(lon, lat, g.coordinates)) return true; }
        else if (g.type === 'MultiPolygon') { for (const p of g.coordinates) if (pointInPolygon(lon, lat, p)) return true; }
    }
    return false;
}

function bresenhamLine(x0, y0, x1, y1, cb) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) { cb(x0, y0); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 > -dy) { err -= dy; x0 += sx; } if (e2 < dx) { err += dx; y0 += sy; } }
}

// Deterministic integer hash
function ihash(a, b) { return (((a * 73856093) ^ (b * 19349663)) >>> 0); }

// ── Load Natural Earth (cached) ────────────────────────────────
function loadNaturalEarth() {
    const landPath  = path.join(CACHE_DIR, 'ne_110m_land.geojson');
    const riverPath = path.join(CACHE_DIR, 'ne_110m_rivers.geojson');
    if (!fs.existsSync(landPath) || !fs.existsSync(riverPath)) {
        console.error('Natural Earth cache missing. Run: node tools/gen_world_map.js');
        process.exit(1);
    }
    const land  = JSON.parse(fs.readFileSync(landPath, 'utf8'));
    const river = JSON.parse(fs.readFileSync(riverPath, 'utf8'));
    computeFeatureBBoxes(land.features);
    return { landFeatures: land.features, riverFeatures: river.features };
}

// ── Pass 1: Terrain ────────────────────────────────────────────
function rasterizeTerrain(landFeatures, riverFeatures) {
    const W = CFG.gridW, H = CFG.gridH;
    const grid = [];
    let landCount = 0;

    // 1a. Land
    for (let ty = 0; ty < H; ty++) {
        grid[ty] = new Array(W).fill(OCEAN);
        for (let tx = 0; tx < W; tx++) {
            const { lon, lat } = regionTileToLonLat(tx, ty);
            if (isOnLand(lon, lat, landFeatures)) { grid[ty][tx] = LAND; landCount++; }
        }
    }
    console.log('  Land: ' + landCount);

    // 1b. Mountains (interior land, deterministic hash)
    let mtnCount = 0;
    for (let ty = 0; ty < H; ty++) {
        for (let tx = 0; tx < W; tx++) {
            if (grid[ty][tx] !== LAND) continue;
            let n = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const ny = ty + dy, nx = tx + dx;
                if (ny >= 0 && ny < H && nx >= 0 && nx < W && grid[ny][nx] >= LAND) n++;
            }
            if (n < 8) continue;
            if (ihash(tx, ty) % 8 === 0) { grid[ty][tx] = MOUNTAIN; mtnCount++; }
        }
    }
    console.log('  Mountains: ' + mtnCount);

    // 1c. Rivers
    let rivCount = 0;
    function setRiver(x, y) {
        if (x < 0 || x >= W || y < 0 || y >= H) return;
        if (grid[y][x] < LAND) return; // never overwrite ocean/coast
        if (grid[y][x] === RIVER) return;
        grid[y][x] = RIVER; rivCount++;
    }
    for (const f of riverFeatures) {
        const g = f.geometry;
        let lines = [];
        if (g.type === 'LineString') lines = [g.coordinates];
        else if (g.type === 'MultiLineString') lines = g.coordinates;
        const rank = (f.properties && typeof f.properties.scalerank === 'number') ? f.properties.scalerank : 99;
        const thick = rank <= 4;
        for (const line of lines) {
            for (let i = 0; i < line.length - 1; i++) {
                const a = projectToRegion(line[i][1], line[i][0]);
                const b = projectToRegion(line[i + 1][1], line[i + 1][0]);
                bresenhamLine(a.tx, a.ty, b.tx, b.ty, setRiver);
                if (thick) {
                    const ddx = b.tx - a.tx, ddy = b.ty - a.ty;
                    const offX = Math.abs(ddy) >= Math.abs(ddx) ? 1 : 0;
                    const offY = Math.abs(ddx) >= Math.abs(ddy) ? 1 : 0;
                    bresenhamLine(a.tx + offX, a.ty + offY, b.tx + offX, b.ty + offY, setRiver);
                }
            }
        }
    }
    console.log('  Rivers: ' + rivCount);

    // 1d. Coast (ocean adjacent to land, last phase, never overwrites river)
    let coastCount = 0;
    const coastMask = [];
    for (let ty = 0; ty < H; ty++) {
        coastMask[ty] = new Uint8Array(W);
        for (let tx = 0; tx < W; tx++) {
            if (grid[ty][tx] !== OCEAN) continue;
            let adj = false;
            for (let dy = -1; dy <= 1 && !adj; dy++) for (let dx = -1; dx <= 1 && !adj; dx++) {
                if (dx === 0 && dy === 0) continue;
                const ny = ty + dy, nx = tx + dx;
                if (ny >= 0 && ny < H && nx >= 0 && nx < W && grid[ny][nx] >= LAND) adj = true;
            }
            if (adj) { coastMask[ty][tx] = 1; coastCount++; }
        }
    }
    for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) { if (coastMask[ty][tx]) grid[ty][tx] = COAST; }
    console.log('  Coast: ' + coastCount);

    return grid;
}

// ── Pass 2: Highways + Towns ───────────────────────────────────
function canRoadOccupy(terrain, tx, ty) {
    if (tx < 0 || tx >= CFG.gridW || ty < 0 || ty >= CFG.gridH) return false;
    const t = terrain[ty][tx];
    // LAND, MOUNTAIN, RIVER all OK — rivers under roads become bridges in engine
    return t === LAND || t === MOUNTAIN || t === RIVER;
}

function canHighwayOccupy(terrain, tx, ty) {
    if (tx < 0 || tx >= CFG.gridW || ty < 0 || ty >= CFG.gridH) return false;
    // At 120x80 resolution, ocean tiles between land masses are narrow straits.
    // Place highways unconditionally; engine renders ocean-highway as bridge.
    return true;
}

function drawNoisySegment(fromTile, toTile, terrain, isHorizontal, amp, freq) {
    const tiles = [];
    const keySet = new Set();
    function emit(x, y) {
        x = Math.max(0, Math.min(CFG.gridW - 1, x));
        y = Math.max(0, Math.min(CFG.gridH - 1, y));
        const k = y * CFG.gridW + x;
        if (keySet.has(k)) return;
        keySet.add(k);
        if (canRoadOccupy(terrain, x, y)) tiles.push({ x, y, type: 2 });
    }

    // Collect noisy waypoints
    const waypoints = [];
    bresenhamLine(fromTile.tx, fromTile.ty, toTile.tx, toTile.ty, (x, y) => {
        let nx = x, ny = y;
        if (isHorizontal) {
            ny = y + Math.round(Math.sin(x * freq) * amp);
        } else {
            nx = x + Math.round(Math.sin(y * freq) * amp);
        }
        waypoints.push({ x: nx, y: ny });
    });

    // Connect consecutive waypoints with Bresenham to guarantee adjacency
    for (let i = 0; i < waypoints.length; i++) {
        if (i === 0) { emit(waypoints[0].x, waypoints[0].y); continue; }
        bresenhamLine(waypoints[i - 1].x, waypoints[i - 1].y, waypoints[i].x, waypoints[i].y, emit);
    }
    return tiles;
}

function genHighways(terrain) {
    const W = CFG.gridW, H = CFG.gridH;
    const roadTiles = [];
    const keySet = new Set();
    function addTile(t) {
        const k = t.y * W + t.x;
        if (keySet.has(k)) return;
        keySet.add(k);
        roadTiles.push(t);
    }

    // Helper: draw a straight highway segment (no noise) to guarantee adjacency
    function drawStraight(fromTx, fromTy, toTx, toTy) {
        bresenhamLine(fromTx, fromTy, toTx, toTy, (x, y) => {
            if (canHighwayOccupy(terrain, x, y)) addTile({ x, y, type: 2 });
        });
    }

    // I-10/I-40 belt (horizontal, lat ~34)
    const beltA = projectToRegion(34, -125), beltB = projectToRegion(34, -65);
    drawStraight(beltA.tx, beltA.ty, beltB.tx, beltB.ty);

    // I-35 corridor (vertical, lon ~-97)
    const i35A = projectToRegion(48, -97), i35B = projectToRegion(20, -97);
    drawStraight(i35A.tx, i35A.ty, i35B.tx, i35B.ty);

    // I-95 corridor (vertical, lon ~-77)
    const i95A = projectToRegion(48, -77), i95B = projectToRegion(22, -77);
    drawStraight(i95A.tx, i95A.ty, i95B.tx, i95B.ty);

    // West coast corridor (vertical, lon ~-122)
    const wcA = projectToRegion(48, -122), wcB = projectToRegion(33, -118);
    drawStraight(wcA.tx, wcA.ty, wcB.tx, wcB.ty);

    // Northern belt (Chicago→NYC, lat ~41)
    const nbA = projectToRegion(41, -88), nbB = projectToRegion(41, -74);
    drawStraight(nbA.tx, nbA.ty, nbB.tx, nbB.ty);

    // Denver→I-35
    const dvA = projectToRegion(39, -105), dvB = projectToRegion(35, -97);
    drawStraight(dvA.tx, dvA.ty, dvB.tx, dvB.ty);

    // Chicago→Atlanta→Miami
    const chiA = projectToRegion(42, -88), atlB = projectToRegion(34, -84), miaC = projectToRegion(26, -80);
    drawStraight(chiA.tx, chiA.ty, atlB.tx, atlB.ty);
    drawStraight(atlB.tx, atlB.ty, miaC.tx, miaC.ty);

    // I-10 spur: belt→Dallas
    const dalP = projectToRegion(33, -97);
    drawStraight(dalP.tx, dalP.ty, dalP.tx, dalP.ty); // single tile, spur will connect

    // Verify connectivity — BFS with 8-neighbor (Bresenham produces diagonal steps)
    const DIR8 = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    function findComponents() {
        const visited = new Set();
        const comps = [];
        for (const k of keySet) {
            if (visited.has(k)) continue;
            const comp = new Set();
            const queue = [k];
            comp.add(k);
            while (queue.length > 0) {
                const cur = queue.shift();
                const cx = cur % W, cy = (cur / W) | 0;
                for (const [dx, dy] of DIR8) {
                    const nk = (cy + dy) * W + (cx + dx);
                    if (keySet.has(nk) && !comp.has(nk)) { comp.add(nk); queue.push(nk); }
                }
            }
            comps.push(comp);
            for (const c of comp) visited.add(c);
        }
        return comps;
    }

    // Bridge components until only 1 remains (re-compute after each bridge)
    for (let iter = 0; iter < 50; iter++) {
        const components = findComponents();
        if (components.length <= 1) break;
        // Find closest pair between largest component and any other
        components.sort((a, b) => b.size - a.size);
        const main = components[0];
        let bestDist = Infinity, bestMainK = 0, bestOtherK = 0;
        for (let ci = 1; ci < components.length; ci++) {
            for (const ok of components[ci]) {
                const ox = ok % W, oy = (ok / W) | 0;
                for (const mk of main) {
                    const mx = mk % W, my = (mk / W) | 0;
                    const d = Math.abs(mx - ox) + Math.abs(my - oy);
                    if (d < bestDist) { bestDist = d; bestMainK = mk; bestOtherK = ok; }
                }
            }
        }
        const mx = bestMainK % W, my = (bestMainK / W) | 0;
        const ox = bestOtherK % W, oy = (bestOtherK / W) | 0;
        drawStraight(mx, my, ox, oy);
        console.log('  Bridged highway gap: dist=' + bestDist);
    }

    console.log('  Highway tiles: ' + roadTiles.length);
    return { roadTiles, highwayKeySet: keySet };
}

// Tier A major towns (always created)
const TIER_A_CITIES = [
    { id: 'la',       label: 'LOS ANGELES', lat: 34.05,  lon: -118.24 },
    { id: 'sf',       label: 'SAN FRANCISCO',lat: 37.77,  lon: -122.42 },
    { id: 'seattle',  label: 'SEATTLE',      lat: 47.61,  lon: -122.33 },
    { id: 'portland', label: 'PORTLAND',      lat: 45.52,  lon: -122.68 },
    { id: 'denver',   label: 'DENVER',       lat: 39.74,  lon: -104.99 },
    { id: 'dallas',   label: 'DALLAS',       lat: 32.78,  lon: -96.80 },
    { id: 'chicago',  label: 'CHICAGO',      lat: 41.88,  lon: -87.63 },
    { id: 'nyc',      label: 'NEW YORK',     lat: 40.71,  lon: -74.01 },
    { id: 'atlanta',  label: 'ATLANTA',      lat: 33.75,  lon: -84.39 },
    { id: 'miami',    label: 'MIAMI',        lat: 25.76,  lon: -80.19 },
    { id: 'boston',    label: 'BOSTON',        lat: 42.36,  lon: -71.06 },
    { id: 'montreal', label: 'MONTREAL',     lat: 45.50,  lon: -73.57 },
];

function genTowns(terrain, artistLocations) {
    const W = CFG.gridW, H = CFG.gridH;
    const towns = [];

    // Create Tier A towns
    for (const c of TIER_A_CITIES) {
        const t = projectToRegion(c.lat, c.lon);
        // Nudge onto land
        let tx = t.tx, ty = t.ty;
        if (!canRoadOccupy(terrain, tx, ty)) {
            let found = false;
            for (let r = 1; r <= 6 && !found; r++) {
                for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r && !found; dx++) {
                    if (canRoadOccupy(terrain, tx + dx, ty + dy)) { tx += dx; ty += dy; found = true; }
                }
            }
        }
        towns.push({ id: c.id, x: tx, y: ty, label: c.label, pattern: 'grid5', radius: 5, tier: 'A', artists: [] });
    }

    // Load NA artist locations
    const naArtists = artistLocations.filter(a =>
        a.lat !== null && a.lon !== null &&
        a.lat >= CFG.latMin && a.lat <= CFG.latMax &&
        a.lon >= CFG.lonMin && a.lon <= CFG.lonMax
    );

    // Assign artists to nearest town, track unassigned
    const unassigned = [];
    for (const a of naArtists) {
        const p = projectToRegion(a.lat, a.lon);
        let bestDist = Infinity, bestTown = null;
        for (const t of towns) {
            const d = Math.abs(p.tx - t.x) + Math.abs(p.ty - t.y);
            if (d < bestDist) { bestDist = d; bestTown = t; }
        }
        if (bestTown && bestDist <= 12) {
            bestTown.artists.push(a.handle);
        } else {
            unassigned.push(a);
        }
    }

    // Create Tier B towns for unassigned artists (city has 2+ artists or >12 tiles from Tier A)
    const tierBCities = {};
    for (const a of unassigned) {
        const key = a.city + ',' + a.country;
        if (!tierBCities[key]) tierBCities[key] = { lat: a.lat, lon: a.lon, city: a.city, artists: [] };
        tierBCities[key].artists.push(a.handle);
    }
    for (const [key, info] of Object.entries(tierBCities)) {
        const p = projectToRegion(info.lat, info.lon);
        // Check distance to existing towns
        let nearDist = Infinity;
        for (const t of towns) nearDist = Math.min(nearDist, Math.abs(p.tx - t.x) + Math.abs(p.ty - t.y));
        if (info.artists.length >= 2 || nearDist > 12) {
            let tx = p.tx, ty = p.ty;
            if (!canRoadOccupy(terrain, tx, ty)) {
                for (let r = 1; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                    if (canRoadOccupy(terrain, tx + dx, ty + dy)) { tx += dx; ty += dy; r = 99; dy = 99; break; }
                }
            }
            const townId = info.city.toLowerCase().replace(/[^a-z0-9]/g, '_');
            towns.push({ id: townId, x: tx, y: ty, label: info.city.toUpperCase(), pattern: 'grid3', radius: 3, tier: 'B', artists: info.artists });
        } else {
            // Merge into nearest existing town
            let bestTown = towns[0];
            let bestDist = Infinity;
            for (const t of towns) {
                const d = Math.abs(p.tx - t.x) + Math.abs(p.ty - t.y);
                if (d < bestDist) { bestDist = d; bestTown = t; }
            }
            for (const h of info.artists) bestTown.artists.push(h);
        }
    }

    // Auto-shrink town pattern if too many tiles would be invalid terrain
    for (const t of towns) {
        if (t.pattern === 'grid5') {
            let invalid = 0, total = 0;
            for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
                total++;
                if (!canRoadOccupy(terrain, t.x + dx, t.y + dy)) invalid++;
            }
            if (invalid / total > 0.25) {
                t.pattern = 'grid3';
                t.radius = 3;
                console.log('  Town ' + t.id + ': downgraded to grid3 (terrain)');
            }
        }
    }

    console.log('  Towns: ' + towns.length + ' (Tier A: ' + towns.filter(t => t.tier === 'A').length + ', Tier B: ' + towns.filter(t => t.tier === 'B').length + ')');
    let totalArtists = 0;
    for (const t of towns) totalArtists += t.artists.length;
    console.log('  Artists assigned: ' + totalArtists + ' / ' + naArtists.length);

    return { towns, naArtistCount: naArtists.length };
}

function genSpurs(terrain, towns, highwayKeySet) {
    const spurTiles = [];
    const keySet = new Set(highwayKeySet);
    for (const t of towns) {
        // Find nearest highway tile
        let bestDist = Infinity, bestX = -1, bestY = -1;
        for (const k of highwayKeySet) {
            const hx = k % CFG.gridW, hy = (k / CFG.gridW) | 0;
            const d = Math.abs(hx - t.x) + Math.abs(hy - t.y);
            if (d < bestDist) { bestDist = d; bestX = hx; bestY = hy; }
        }
        if (bestDist === 0) continue; // Town is on highway
        // Bresenham from town center to nearest highway tile
        // Allow coast/river crossing for spurs (same logic as highways)
        bresenhamLine(t.x, t.y, bestX, bestY, (x, y) => {
            const k = y * CFG.gridW + x;
            if (keySet.has(k)) return;
            if (!canHighwayOccupy(terrain, x, y)) return;
            keySet.add(k);
            spurTiles.push({ x, y, type: 1 });
        });
    }
    console.log('  Spur tiles: ' + spurTiles.length);
    return spurTiles;
}

// ── Pass 3: Placement + Fillers ────────────────────────────────
function spiralSearch(cx, cy, maxR, isValid) {
    if (isValid(cx, cy)) return { x: cx, y: cy };
    for (let r = 1; r <= maxR; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // perimeter only
                if (isValid(cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
            }
        }
    }
    return null;
}

function placeBuildings(terrain, allRoadTiles, towns, buildingDefs) {
    const W = CFG.gridW, H = CFG.gridH, N = W * H;

    // Build road grids for fast lookup
    const ROAD_GRID = new Uint8Array(N);
    const ROAD_TYPE = new Uint8Array(N);
    for (const r of allRoadTiles) {
        const k = r.y * W + r.x;
        if (k >= 0 && k < N) { ROAD_GRID[k] = 1; ROAD_TYPE[k] = r.type === 2 ? 2 : 1; }
    }

    // Occupancy grid: 1 = building tile, moat tiles flagged by markOccupied
    const occupied = new Uint8Array(N);

    // Pre-mark highway buffer: no buildings within 2 tiles of any highway
    // The player van (128px sprite, 80px collision) extends ~1.25 tiles,
    // so buildings must be >=2 tiles from highways to keep them drivable.
    for (let k = 0; k < N; k++) {
        if (ROAD_TYPE[k] === 2) {
            const hx = k % W, hy = (k / W) | 0;
            for (let by = -2; by <= 2; by++) for (let bx = -2; bx <= 2; bx++) {
                const nx = hx + bx, ny = hy + by;
                if (nx >= 0 && nx < W && ny >= 0 && ny < H) occupied[ny * W + nx] = 1;
            }
        }
    }

    function markOccupied(tx, ty) {
        for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
            const nx = tx + ox, ny = ty + oy;
            if (nx >= 0 && nx < W && ny >= 0 && ny < H) occupied[ny * W + nx] = 1;
        }
    }

    // Build building ID -> def mapping
    const defById = {};
    if (buildingDefs && Array.isArray(buildingDefs.buildings)) {
        for (const b of buildingDefs.buildings) defById[b.id] = b;
    }

    // ── Candidate generation for a town ─────────────────────────
    // Generates ranked candidate tiles in rings around town center
    function generateCandidates(cx, cy, maxRadius, preferStreetFirst, town) {
        const cands = [];
        for (let r = 1; r <= maxRadius; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                    const tx = cx + dx, ty = cy + dy;
                    if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
                    const t = terrain[ty][tx];
                    if (t !== LAND && t !== MOUNTAIN) continue;
                    const k = ty * W + tx;
                    if (occupied[k]) continue;
                    if (ROAD_GRID[k]) continue;

                    // Road adjacency (4-neighbor)
                    let streetAdj = false, highwayAdj = false;
                    for (const nk of [k - 1, k + 1, k - W, k + W]) {
                        if (nk < 0 || nk >= N) continue;
                        if (ROAD_TYPE[nk] === 2) highwayAdj = true;
                        else if (ROAD_GRID[nk]) streetAdj = true;
                    }
                    if (!streetAdj && !highwayAdj) continue;

                    // Angle bucket (8 directions) for spread distribution
                    const angle = Math.atan2(dy, dx);
                    const bucket = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;

                    const dist = Math.abs(dx) + Math.abs(dy);
                    let score = 200 - dist * 3;
                    if (streetAdj) score += 30;
                    if (highwayAdj) score += 10;

                    // Main-street frontage bonus: tiles adjacent to the main street
                    // get a significant boost so artists cluster along the "gallery strip"
                    for (const nk of [k - 1, k + 1, k - W, k + W]) {
                        if (town && town.mainStreetKeys && town.mainStreetKeys.has(nk)) {
                            score += 40;
                            break;
                        }
                    }

                    cands.push({ tx, ty, key: k, score, bucket, dist, streetAdj });
                }
            }
        }
        cands.sort((a, b) => b.score - a.score || a.bucket - b.bucket);
        return cands;
    }

    // ── Artist placement with neighborhoods ──────────────────────
    // Towns with >= 6 artists get 2-3 block centers for "gallery districts"
    const placements = [];
    const MIN_ARTIST_SPACING = 4;
    const NEIGHBORHOOD_THRESHOLD = 6;

    function tryPlaceArtistAt(buildingId, candList, placedKeys, usedBuckets) {
        for (const c of candList) {
            if (placedKeys.has(c.key) || occupied[c.key]) continue;

            let tooClose = false;
            for (const pk of placedKeys) {
                const px = pk % W, py = (pk / W) | 0;
                if (Math.abs(c.tx - px) + Math.abs(c.ty - py) < MIN_ARTIST_SPACING) { tooClose = true; break; }
            }
            if (tooClose) continue;

            const bc = usedBuckets.get(c.bucket) || 0;
            if (bc >= 2 && candList.some(other => !placedKeys.has(other.key) && !occupied[other.key] && (usedBuckets.get(other.bucket) || 0) < bc)) continue;

            placements.push({ buildingId, x: c.tx, y: c.ty });
            markOccupied(c.tx, c.ty);
            placedKeys.add(c.key);
            usedBuckets.set(c.bucket, bc + 1);
            return true;
        }
        return false;
    }

    for (const t of towns) {
        if (!t.artists || t.artists.length === 0) continue;
        const cx = t.x, cy = t.y;
        const spreadRadius = t.tier === 'A' ? 14 : 10;

        const sortedArtists = [...t.artists].sort((a, b) => ihash(a.length, a.charCodeAt(0)) - ihash(b.length, b.charCodeAt(0)));

        const placedKeys = new Set();
        const usedBuckets = new Map();

        if (sortedArtists.length >= NEIGHBORHOOD_THRESHOLD) {
            // Create 2-4 neighborhood blocks ALIGNED TO MAIN STREET
            const numBlocks = sortedArtists.length >= 10 ? 4 : sortedArtists.length >= 7 ? 3 : 2;
            const blockDist = t.radius + 3;
            const isHoriz = t.mainStreetAxis === 'h';
            const blocks = [];
            for (let bi = 0; bi < numBlocks; bi++) {
                // Distribute blocks along the main street axis
                const along = -blockDist + Math.round((2 * blockDist * (bi + 0.5)) / numBlocks);
                // Alternate sides of the street for readability
                const perp = (bi % 2 === 0 ? 1 : -1) * (2 + ihash(t.x + bi, t.y) % 3);
                blocks.push({
                    cx: cx + (isHoriz ? along : perp),
                    cy: cy + (isHoriz ? perp : along),
                    label: 'block_' + bi
                });
            }

            // Assign artists to blocks round-robin
            const blockAssign = sortedArtists.map((_, i) => i % numBlocks);

            for (let i = 0; i < sortedArtists.length; i++) {
                const handle = sortedArtists[i];
                const bid = 'b_' + handle.toLowerCase().replaceAll('.', '_');
                if (!defById[bid]) { console.warn('  No building def for: ' + bid); continue; }

                const block = blocks[blockAssign[i]];
                const blockCands = generateCandidates(block.cx, block.cy, 8, true, t);
                const fallbackCands = generateCandidates(cx, cy, spreadRadius, true, t);

                if (!tryPlaceArtistAt(bid, blockCands, placedKeys, usedBuckets)) {
                    tryPlaceArtistAt(bid, fallbackCands, placedKeys, usedBuckets);
                }
            }

            console.log('  Town ' + t.id + ': ' + numBlocks + ' neighborhoods, ' + placedKeys.size + '/' + sortedArtists.length + ' placed');
        } else {
            // Small town: spread across core/outer as before
            const cands = generateCandidates(cx, cy, spreadRadius, true, t);
            const coreR = t.radius + 2;
            const coreCands = cands.filter(c => c.dist <= coreR);
            const outerCands = cands.filter(c => c.dist > coreR);
            const coreCount = Math.ceil(sortedArtists.length * 0.35);

            for (let i = 0; i < sortedArtists.length; i++) {
                const handle = sortedArtists[i];
                const bid = 'b_' + handle.toLowerCase().replaceAll('.', '_');
                if (!defById[bid]) { console.warn('  No building def for: ' + bid); continue; }

                if (i < coreCount) {
                    if (!tryPlaceArtistAt(bid, coreCands, placedKeys, usedBuckets)) {
                        tryPlaceArtistAt(bid, outerCands, placedKeys, usedBuckets);
                    }
                } else {
                    if (!tryPlaceArtistAt(bid, outerCands, placedKeys, usedBuckets)) {
                        tryPlaceArtistAt(bid, coreCands, placedKeys, usedBuckets);
                    }
                }
            }
        }

        const placed = placedKeys.size;
        const expected = sortedArtists.length;
        if (placed < expected) console.warn('  Town ' + t.id + ': placed ' + placed + '/' + expected + ' artists');
    }

    // ── Filler placement with preset mixes + avoid-artist-streets ──
    const FILLER_PRESETS = {
        downtown: ['arcade', 'diner', 'toy_shop', 'arcade', 'diner', 'warehouse', 'toy_shop', 'arcade', 'diner', 'garage'],
        industrial: ['warehouse', 'garage', 'warehouse', 'garage', 'diner', 'warehouse', 'garage', 'warehouse', 'hotel', 'garage'],
        tourist: ['hotel', 'diner', 'arcade', 'hotel', 'diner', 'toy_shop', 'arcade', 'hotel', 'diner', 'toy_shop']
    };

    // Build "artist road set" for avoid-artist-streets logic
    const artistRoadSet = new Set();
    for (const p of placements) {
        const k = p.y * W + p.x;
        for (const nk of [k - 1, k + 1, k - W, k + W]) {
            if (nk >= 0 && nk < N && ROAD_GRID[nk]) artistRoadSet.add(nk);
        }
    }

    const fillers = [];
    let fillerGlobalIdx = 0;

    for (const t of towns) {
        const cx = t.x, cy = t.y;
        const count = t.tier === 'A' ? (8 + ihash(t.x, t.y) % 5) : (2 + ihash(t.y, t.x) % 3);
        const fillerRadius = t.tier === 'A' ? 12 : 8;

        // Pick preset by town hash
        const presetKeys = Object.keys(FILLER_PRESETS);
        const preset = FILLER_PRESETS[presetKeys[ihash(t.x + t.y, t.id.length) % presetKeys.length]];

        // Generate candidates with artist-avoidance scoring
        const cands = [];
        for (let dy = -fillerRadius; dy <= fillerRadius; dy++) {
            for (let dx = -fillerRadius; dx <= fillerRadius; dx++) {
                const tx = cx + dx, ty = cy + dy;
                if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
                if (terrain[ty][tx] !== LAND && terrain[ty][tx] !== MOUNTAIN) continue;
                const k = ty * W + tx;
                if (occupied[k]) continue;
                if (ROAD_GRID[k]) continue;

                let adj = false;
                for (const nk of [k - 1, k + 1, k - W, k + W]) {
                    if (nk >= 0 && nk < N && ROAD_GRID[nk]) { adj = true; break; }
                }
                if (!adj) continue;

                const dist = Math.abs(dx) + Math.abs(dy);
                let score = 150 - dist * 2;
                // Penalize tiles adjacent to artist-fronting roads
                let nearArtistRoad = false;
                for (const nk of [k - 1, k + 1, k - W, k + W]) {
                    if (artistRoadSet.has(nk)) { nearArtistRoad = true; break; }
                }
                if (nearArtistRoad) score -= 50;
                cands.push({ tx, ty, key: k, score, dist });
            }
        }
        cands.sort((a, b) => b.score - a.score);

        let added = 0;
        const localPlaced = new Set();
        for (let i = 0; i < count; i++) {
            const fType = preset[i % preset.length];
            for (const c of cands) {
                if (localPlaced.has(c.key) || occupied[c.key]) continue;
                // Moat spacing from this batch
                let tooClose = false;
                for (const pk of localPlaced) {
                    const px = pk % W, py = (pk / W) | 0;
                    if (Math.abs(c.tx - px) <= 2 && Math.abs(c.ty - py) <= 2) { tooClose = true; break; }
                }
                if (tooClose) continue;

                fillers.push({
                    id: 'filler_' + t.id + '_' + fType + '_' + fillerGlobalIdx,
                    x: c.tx, y: c.ty,
                    buildingType: fType
                });
                markOccupied(c.tx, c.ty);
                localPlaced.add(c.key);
                fillerGlobalIdx++;
                added++;
                break;
            }
        }
    }

    // ── Dimension X Toys building (Phase 5) ─────────────────────
    // Place near NYC area (northeast) as a special building
    const dimXTowns = towns.filter(t => t.label && (t.label.includes('New York') || t.label.includes('NYC')));
    let dimXTown = dimXTowns.length > 0 ? dimXTowns[0] : towns[towns.length - 1];
    let dimXPlaced = false;
    for (let dxr = 1; dxr <= 5 && !dimXPlaced; dxr++) {
        for (let dxa = 0; dxa < 8 && !dimXPlaced; dxa++) {
            const dxx = dimXTown.x + Math.round(Math.cos(dxa * Math.PI / 4) * dxr);
            const dxy = dimXTown.y + Math.round(Math.sin(dxa * Math.PI / 4) * dxr);
            if (dxx < 1 || dxx >= W - 1 || dxy < 1 || dxy >= H - 1) continue;
            const dxKey = dxy * W + dxx;
            if (occupied[dxKey]) continue;
            if (ROAD_GRID[dxKey]) continue;
            if (terrain[dxy][dxx] < 2) continue;
            fillers.push({
                id: 'dimension_x_toys',
                x: dxx, y: dxy,
                buildingType: 'dimension_x'
            });
            markOccupied(dxx, dxy);
            dimXPlaced = true;
        }
    }
    if (!dimXPlaced) {
        // Fallback: place at a fixed position
        fillers.push({ id: 'dimension_x_toys', x: 54, y: 10, buildingType: 'dimension_x' });
    }
    console.log('  Dimension X Toys placed: ' + dimXPlaced);

    console.log('  Artist buildings placed: ' + placements.length);
    console.log('  Filler buildings placed: ' + fillers.length);

    // ── Town profiles + density ──────────────────────────────────
    for (const t of towns) {
        const numArtists = t.artists ? t.artists.length : 0;
        if (numArtists >= 6)        t.profile = 'arts_district';
        else if (t.tier === 'A')    t.profile = 'downtown';
        else {
            const ph = ihash(t.x + t.y, t.label ? t.label.length : 0);
            const profiles = ['industrial', 'tourist', 'suburb'];
            t.profile = profiles[ph % profiles.length];
        }
        t.density = t.tier === 'A' ? (4 + ihash(t.x, t.y) % 2) : (2 + ihash(t.y, t.x) % 2);
        if (t.profile === 'arts_district' && t.density < 4) t.density = 4;
    }

    // ── Background buildings (non-enterable city mass) ───────────
    const BG_KINDS = ['apt_small', 'apt_tall', 'office', 'house', 'shopfront', 'warehouse_bg'];
    const PROFILE_BG_MIX = {
        downtown:      ['apt_tall', 'office', 'apt_tall', 'shopfront', 'office', 'apt_small'],
        industrial:    ['warehouse_bg', 'warehouse_bg', 'apt_small', 'warehouse_bg', 'office', 'apt_small'],
        tourist:       ['shopfront', 'house', 'shopfront', 'apt_small', 'house', 'shopfront'],
        suburb:        ['house', 'house', 'apt_small', 'house', 'house', 'shopfront'],
        arts_district: ['shopfront', 'apt_tall', 'apt_small', 'shopfront', 'office', 'apt_tall']
    };

    const PROFILE_ZONE_MAP = {
        downtown: 'downtown', industrial: 'industrial',
        tourist: 'commercial', suburb: 'residential', arts_district: 'commercial'
    };

    const KIND_WIDTH_RANGE = {
        house: [1, 1], apt_small: [1, 1], shopfront: [1, 2],
        apt_tall: [2, 2], office: [2, 3], warehouse_bg: [3, 4]
    };

    const bgBuildings = [];
    let bgIdx = 0;
    for (const t of towns) {
        const bgCount = t.density * 3 + ihash(t.x, t.y) % 3;
        const bgRadius = t.radius + (t.tier === 'A' ? 6 : 3);
        const mix = PROFILE_BG_MIX[t.profile] || PROFILE_BG_MIX.suburb;
        const bgZone = PROFILE_ZONE_MAP[t.profile] || 'residential';
        const bgCands = [];

        for (let dy = -bgRadius; dy <= bgRadius; dy++) {
            for (let dx = -bgRadius; dx <= bgRadius; dx++) {
                const tx = t.x + dx, ty = t.y + dy;
                if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
                if (terrain[ty][tx] !== LAND && terrain[ty][tx] !== MOUNTAIN) continue;
                const k = ty * W + tx;
                if (occupied[k]) continue;
                if (ROAD_GRID[k]) continue;
                let nearRoad = false;
                for (let ndy = -2; ndy <= 2 && !nearRoad; ndy++) {
                    for (let ndx = -2; ndx <= 2 && !nearRoad; ndx++) {
                        const nk = (ty + ndy) * W + (tx + ndx);
                        if (nk >= 0 && nk < N && ROAD_GRID[nk]) nearRoad = true;
                    }
                }
                if (!nearRoad) continue;
                const dist = Math.abs(dx) + Math.abs(dy);
                bgCands.push({ tx, ty, key: k, dist });
            }
        }
        bgCands.sort((a, b) => a.dist - b.dist);

        let bgAdded = 0;
        const bgPlaced = new Set();
        for (let i = 0; i < bgCands.length && bgAdded < bgCount; i++) {
            const c = bgCands[i];
            if (bgPlaced.has(c.key)) continue;
            let tooClose = false;
            for (const pk of bgPlaced) {
                const px = pk % W, py = (pk / W) | 0;
                if (Math.abs(c.tx - px) <= 1 && Math.abs(c.ty - py) <= 1) { tooClose = true; break; }
            }
            if (tooClose) continue;
            const bKind = mix[bgAdded % mix.length];
            const wRange = KIND_WIDTH_RANGE[bKind] || [1, 1];
            const bW = wRange[0] + (ihash(c.tx, c.ty) % (wRange[1] - wRange[0] + 1));
            const entry = { x: c.tx, y: c.ty, kind: bKind, zone: bgZone };
            if (bW > 1) entry.fp = { w: bW, h: 1 };
            bgBuildings.push(entry);
            bgPlaced.add(c.key);
            bgAdded++;
            bgIdx++;
        }
    }
    console.log('  Background buildings placed: ' + bgBuildings.length);

    // ── Streetscape props (deterministic per town profile) ───────
    const townProps = [];
    const PROFILE_PROPS = {
        downtown:      ['lamppost', 'lamppost', 'lamppost'],
        industrial:    ['dumpster', 'vent', 'dumpster'],
        tourist:       ['palm', 'palm', 'tree'],
        suburb:        ['tree', 'tree', 'tree'],
        arts_district: ['lamppost', 'tree', 'lamppost']
    };

    for (const t of towns) {
        const propMix = PROFILE_PROPS[t.profile] || PROFILE_PROPS.suburb;
        const propInterval = Math.max(3, 7 - t.density);
        const r = t.radius + 2;
        let propIdx = 0;

        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const tx = t.x + dx, ty = t.y + dy;
                if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
                const k = ty * W + tx;
                if (!ROAD_GRID[k]) continue;
                const h = ihash(tx, ty);
                if (h % propInterval !== 0) continue;
                // Don't place on occupied tiles
                if (occupied[k]) continue;
                // Check no building or bg at this tile
                let blocked = false;
                for (const bg of bgBuildings) { if (bg.x === tx && bg.y === ty) { blocked = true; break; } }
                if (blocked) continue;

                const propKind = propMix[propIdx % propMix.length];
                townProps.push({ x: tx, y: ty, kind: propKind });
                propIdx++;
            }
        }
    }
    console.log('  Town props placed: ' + townProps.length);

    return { placements, fillers, ROAD_GRID, ROAD_TYPE, occupied, bgBuildings, townProps };
}

// ── Districts ──────────────────────────────────────────────────
function computeDistrictXBands() {
    const lonBands = [
        { id: 'west_coast', lonMin: -130, lonMax: -108 },
        { id: 'mountain',   lonMin: -108, lonMax: -94  },
        { id: 'midwest',    lonMin: -94,  lonMax: -82  },
        { id: 'south',      lonMin: -82,  lonMax: -70  },
        { id: 'northeast',  lonMin: -70,  lonMax: -60  },
    ];
    return lonBands.map(b => ({
        id: b.id,
        x0: Math.floor(((b.lonMin - CFG.lonMin) / (CFG.lonMax - CFG.lonMin)) * (CFG.gridW - 1)),
        x1: Math.floor(((b.lonMax - CFG.lonMin) / (CFG.lonMax - CFG.lonMin)) * (CFG.gridW - 1))
    }));
}

// ── Landmarks ──────────────────────────────────────────────────
function genLandmarks(towns, terrain, highwayKeySet) {
    const landmarks = [];
    const W = CFG.gridW, H = CFG.gridH;

    // START near LA — find a highway tile nearby that's not occupied by a building
    const la = towns.find(t => t.id === 'la');
    let startX = 1, startY = 1;
    if (la) {
        let found = false;
        for (let sr = 0; sr <= 10 && !found; sr++) {
            for (let sdy = -sr; sdy <= sr && !found; sdy++) {
                for (let sdx = -sr; sdx <= sr && !found; sdx++) {
                    if (Math.abs(sdx) !== sr && Math.abs(sdy) !== sr) continue;
                    const sx = la.x + sdx, sy = la.y + sdy;
                    if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
                    const sk = sy * W + sx;
                    if (highwayKeySet.has(sk)) { startX = sx; startY = sy; found = true; }
                }
            }
        }
        if (!found) { startX = la.x + 1; startY = la.y + 1; }
    }
    landmarks.push({ id: 'lm_start', x: startX, y: startY, label: 'START', sprite: null });

    // Town labels for Tier A
    for (const t of towns) {
        if (t.tier === 'A') {
            landmarks.push({ id: 'lm_town_' + t.id, x: t.x, y: t.y - 1, label: t.label, sprite: null });
        }
    }

    // Track used positions to avoid landmark overlaps
    const usedPos = new Set();
    for (const lm of landmarks) usedPos.add(lm.x + ',' + lm.y);

    // Welcome signs for Tier A towns (Phase 7.1)
    // Placed just outside the town grid radius on the approach side
    for (const t of towns) {
        if (t.tier !== 'A') continue;
        const offsets = [
            { dx: 0, dy: t.radius + 2 },   // south
            { dx: 0, dy: -(t.radius + 2) }, // north
            { dx: t.radius + 2, dy: 0 },    // east
            { dx: -(t.radius + 2), dy: 0 }, // west
            { dx: 1, dy: t.radius + 2 },    // south-east
            { dx: -1, dy: -(t.radius + 2) },// north-west
        ];
        let placed = false;
        for (const off of offsets) {
            const wx = t.x + off.dx, wy = t.y + off.dy;
            if (wx < 0 || wx >= W || wy < 0 || wy >= H) continue;
            const tt = terrain[wy][wx];
            if (tt !== LAND && tt !== MOUNTAIN) continue;
            const posKey = wx + ',' + wy;
            if (usedPos.has(posKey)) continue;
            landmarks.push({ id: 'lm_welcome_' + t.id, x: wx, y: wy, label: t.label, sprite: null });
            usedPos.add(posKey);
            placed = true;
            break;
        }
        if (!placed) {
            console.warn('  Could not place welcome sign for: ' + t.id);
        }
    }

    // Highway signs at notable points along corridors (Phase 7.1)
    // Multiple signs per corridor so players can orient while driving
    const hwSigns = [
        // I-10/I-40 belt (horizontal, lat ~34)
        { label: 'I-10', lat: 34, lon: -115 },
        { label: 'I-10', lat: 34, lon: -100 },
        { label: 'I-40', lat: 34, lon: -85 },
        { label: 'I-10', lat: 34, lon: -72 },
        // I-35 corridor (vertical, lon ~-97)
        { label: 'I-35', lat: 42, lon: -97 },
        { label: 'I-35', lat: 30, lon: -97 },
        // I-95 corridor (vertical, lon ~-77)
        { label: 'I-95', lat: 44, lon: -77 },
        { label: 'I-95', lat: 34, lon: -77 },
        // West coast
        { label: 'I-5', lat: 44, lon: -122 },
        { label: 'I-5', lat: 37, lon: -122 },
        // Northern belt
        { label: 'I-90', lat: 41, lon: -82 },
    ];
    let hwIdx = 0;
    for (const s of hwSigns) {
        const p = projectToRegion(s.lat, s.lon);
        let tx = p.tx, ty = p.ty;
        if (tx >= 0 && tx < W && ty >= 0 && ty < H) {
            // Nudge onto land and away from existing landmarks
            if (terrain[ty][tx] < LAND || usedPos.has(tx + ',' + ty)) {
                let found = false;
                for (let r = 1; r <= 4 && !found; r++) {
                    for (let dy = -r; dy <= r && !found; dy++) {
                        for (let dx = -r; dx <= r && !found; dx++) {
                            const nx = tx + dx, ny = ty + dy;
                            if (nx >= 0 && nx < W && ny >= 0 && ny < H &&
                                terrain[ny][nx] >= LAND && !usedPos.has(nx + ',' + ny)) {
                                tx = nx; ty = ny; found = true;
                            }
                        }
                    }
                }
            }
            const posKey = tx + ',' + ty;
            if (!usedPos.has(posKey)) {
                landmarks.push({
                    id: 'lm_hw_' + s.label.replace('-', '') + '_' + hwIdx,
                    x: tx, y: ty,
                    label: s.label,
                    sprite: null
                });
                usedPos.add(posKey);
                hwIdx++;
            }
        }
    }

    // Level entrance landmarks (Phase 9.0)
    const levelEntrances = [
        { id: 'lm_sewer', townId: 'nyc', offset: { dx: -3, dy: 2 }, label: 'SEWER', sprite: null }
    ];
    for (const le of levelEntrances) {
        const t = towns.find(tw => tw.id === le.townId);
        if (!t) continue;
        let lx = t.x + le.offset.dx, ly = t.y + le.offset.dy;
        if (lx >= 0 && lx < W && ly >= 0 && ly < H && terrain[ly][lx] >= LAND) {
            const posKey = lx + ',' + ly;
            if (!usedPos.has(posKey)) {
                landmarks.push({ id: le.id, x: lx, y: ly, label: le.label, sprite: le.sprite });
                usedPos.add(posKey);
            }
        }
    }

    // Blimp ports (Phase 7.3 prep) at 5 major towns
    const blimpTowns = ['la', 'chicago', 'nyc', 'miami', 'seattle'];
    for (const tid of blimpTowns) {
        const t = towns.find(tw => tw.id === tid);
        if (!t) continue;
        let bx = t.x + 2, by = t.y;
        const bKey = bx + ',' + by;
        if (usedPos.has(bKey)) { bx = t.x - 2; }
        landmarks.push({ id: 'lm_blimp_' + tid, x: bx, y: by, label: 'BLIMP PORT', sprite: null });
        usedPos.add(bx + ',' + by);
    }

    console.log('  Landmarks: ' + landmarks.length + ' (towns: ' + towns.filter(t => t.tier === 'A').length + ', welcome: ' + landmarks.filter(l => l.id.indexOf('lm_welcome_') === 0).length + ', highway: ' + hwIdx + ', blimp: ' + blimpTowns.length + ')');
    return landmarks;
}

// ── Verification gates ─────────────────────────────────────────
function verify(terrain, allRoadTiles, towns, placements, fillers, districts) {
    const W = CFG.gridW, H = CFG.gridH;
    let ok = true;
    function gate(cond, msg) { if (!cond) { console.error('GATE FAIL: ' + msg); ok = false; } }

    // Build road key set
    const roadKeys = new Set();
    const hwKeys = new Set();
    for (const r of allRoadTiles) {
        roadKeys.add(r.y * W + r.x);
        if (r.type === 2) hwKeys.add(r.y * W + r.x);
    }

    // 1. All artist buildings road-adjacent
    let notAdj = 0;
    for (const p of placements) {
        let adj = false;
        for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
            if (roadKeys.has((p.y + dy) * W + (p.x + dx))) adj = true;
        }
        if (!adj) notAdj++;
    }
    gate(notAdj === 0, notAdj + ' artist buildings not road-adjacent');

    // 2. All filler buildings road-adjacent
    let fillerNotAdj = 0;
    for (const f of fillers) {
        let adj = false;
        for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
            if (roadKeys.has((f.y + dy) * W + (f.x + dx))) adj = true;
        }
        if (!adj) fillerNotAdj++;
    }
    gate(fillerNotAdj === 0, fillerNotAdj + ' filler buildings not road-adjacent');

    // 3. BFS connectivity (8-neighbor, matching Bresenham adjacency)
    const DIR8 = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    if (hwKeys.size > 0) {
        const visited = new Set();
        const queue = [hwKeys.values().next().value];
        visited.add(queue[0]);
        while (queue.length > 0) {
            const k = queue.shift();
            const kx = k % W, ky = (k / W) | 0;
            for (const [dx, dy] of DIR8) {
                const nk = (ky + dy) * W + (kx + dx);
                if (roadKeys.has(nk) && !visited.has(nk)) { visited.add(nk); queue.push(nk); }
            }
        }
        // Check all towns reachable
        let unreachable = 0;
        for (const t of towns) {
            const tk = t.y * W + t.x;
            let townReachable = visited.has(tk);
            if (!townReachable) {
                for (let dy = -t.radius; dy <= t.radius && !townReachable; dy++) {
                    for (let dx = -t.radius; dx <= t.radius && !townReachable; dx++) {
                        if (visited.has((t.y + dy) * W + (t.x + dx))) townReachable = true;
                    }
                }
            }
            if (!townReachable) { unreachable++; console.warn('  Unreachable town: ' + t.id); }
        }
        gate(unreachable === 0, unreachable + ' towns not connected to highway network');

        // Highway continuity (8-neighbor)
        const hwVisited = new Set();
        const hwQueue = [hwKeys.values().next().value];
        hwVisited.add(hwQueue[0]);
        while (hwQueue.length > 0) {
            const k = hwQueue.shift();
            const kx = k % W, ky = (k / W) | 0;
            for (const [dx, dy] of DIR8) {
                const nk = (ky + dy) * W + (kx + dx);
                if (hwKeys.has(nk) && !hwVisited.has(nk)) { hwVisited.add(nk); hwQueue.push(nk); }
            }
        }
        const hwRatio = hwVisited.size / hwKeys.size;
        if (hwRatio < 0.95) console.warn('  Highway continuity: ' + (hwRatio * 100).toFixed(1) + '% (< 95%)');
    }

    // 4. Mountain building warning
    let mtnBuildings = 0;
    for (const p of placements) { if (terrain[p.y][p.x] === MOUNTAIN) mtnBuildings++; }
    if (placements.length > 0 && mtnBuildings / placements.length > 0.15) {
        console.warn('  Warning: ' + mtnBuildings + '/' + placements.length + ' artist buildings on mountains (>' + (0.15 * 100) + '%)');
    }

    // 5. Moat violations (any two buildings within 1 tile of each other)
    const allBlds = [];
    for (const p of placements) allBlds.push({ id: p.buildingId, x: p.x, y: p.y });
    for (const f of fillers) allBlds.push({ id: f.id, x: f.x, y: f.y });
    let moatViolations = 0;
    for (let i = 0; i < allBlds.length; i++) {
        for (let j = i + 1; j < allBlds.length; j++) {
            if (Math.abs(allBlds[i].x - allBlds[j].x) <= 1 && Math.abs(allBlds[i].y - allBlds[j].y) <= 1) {
                moatViolations++;
                if (moatViolations <= 5) console.warn('  Moat: ' + allBlds[i].id + ' <-> ' + allBlds[j].id);
            }
        }
    }
    gate(moatViolations === 0, moatViolations + ' moat violations');

    // 6. Town road coverage (each town must have enough local street tiles)
    for (const t of towns) {
        let townRoads = 0;
        const r = t.radius + 2;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            const nk = (t.y + dy) * W + (t.x + dx);
            if (roadKeys.has(nk)) townRoads++;
        }
        if (townRoads < 4) console.warn('  Town ' + t.id + ' has only ' + townRoads + ' road tiles nearby');
    }

    // 7. River tile isolation check
    let rivOnOcean = 0;
    for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
        if (terrain[ty][tx] === RIVER) {
            let hasLand = false;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const ny = ty + dy, nx = tx + dx;
                if (ny >= 0 && ny < H && nx >= 0 && nx < W && terrain[ny][nx] >= LAND) hasLand = true;
            }
            if (!hasLand) rivOnOcean++;
        }
    }
    gate(rivOnOcean === 0, rivOnOcean + ' river tiles isolated from land');

    // 8. BG buildings never collide with enterables (within 1 tile)
    const enterableSet = new Set();
    for (const p of placements) enterableSet.add(p.y * W + p.x);
    for (const f of fillers) enterableSet.add(f.y * W + f.x);
    // Retrieve bgBuildings + townProps from caller scope via arguments or closure
    // We add them as optional params
    const bgB = arguments[6] || [];
    const tProps = arguments[7] || [];
    let bgOverlap = 0;
    for (const bg of bgB) {
        for (let ody = -1; ody <= 1; ody++) {
            for (let odx = -1; odx <= 1; odx++) {
                if (enterableSet.has((bg.y + ody) * W + (bg.x + odx))) { bgOverlap++; break; }
            }
            if (bgOverlap > 0) break;
        }
    }
    if (bgOverlap > 0) console.warn('  Warning: ' + bgOverlap + ' bg buildings within 1 tile of enterables');

    // 9. BG and props on valid terrain only
    let bgBadTerrain = 0, propBadTerrain = 0;
    for (const bg of bgB) {
        const tt = terrain[bg.y]?.[bg.x];
        if (tt !== LAND && tt !== MOUNTAIN) bgBadTerrain++;
    }
    for (const p of tProps) {
        const tt = terrain[p.y]?.[p.x];
        if (tt !== LAND && tt !== MOUNTAIN) {
            const k = p.y * W + p.x;
            if (!roadKeys.has(k)) propBadTerrain++;
        }
    }
    gate(bgBadTerrain === 0, bgBadTerrain + ' bg buildings on invalid terrain');
    if (propBadTerrain > 0) console.warn('  Warning: ' + propBadTerrain + ' props on non-land/road terrain');

    // 10. Determinism checksum log
    function listChecksum(arr) {
        let h = 0;
        for (let i = 0; i < arr.length; i++) {
            h = ((h << 5) - h + (arr[i].x || 0) * 1000 + (arr[i].y || 0)) | 0;
        }
        return (h >>> 0).toString(16).padStart(8, '0');
    }
    console.log('  Checksums: placements=' + listChecksum(placements) + ' fillers=' + listChecksum(fillers) + ' bg=' + listChecksum(bgB) + ' props=' + listChecksum(tProps));

    if (ok) console.log('  All verification gates passed.');
    return ok;
}

// ── Main ───────────────────────────────────────────────────────
function main() {
    console.log('=== NA Region Generator (USA driving map) ===');
    console.log('Grid: ' + CFG.gridW + 'x' + CFG.gridH + '  tileSize: ' + CFG.tileSize);

    // Load data
    const { landFeatures, riverFeatures } = loadNaturalEarth();
    const locPath = path.join(DATA_DIR, 'artist_locations.json');
    const locData = JSON.parse(fs.readFileSync(locPath, 'utf8'));
    const buildingsPath = path.join(DATA_DIR, 'buildings.json');
    const buildingDefs = JSON.parse(fs.readFileSync(buildingsPath, 'utf8'));

    // Pass 1: Terrain
    console.log('\nPass 1: Terrain');
    const terrain = rasterizeTerrain(landFeatures, riverFeatures);

    // Pass 2: Highways + Towns
    console.log('\nPass 2: Highways + Towns');
    const { roadTiles: hwTiles, highwayKeySet } = genHighways(terrain);
    const { towns, naArtistCount } = genTowns(terrain, locData.locations);
    const spurTiles = genSpurs(terrain, towns, highwayKeySet);

    // Merge all road tiles
    const allRoadTiles = [...hwTiles, ...spurTiles];

    // Pass 3: Placement
    console.log('\nPass 3: Placement');
    // Main-street strip: deterministic axis through town center (2-tile wide)
    // This creates a readable "gallery strip" for each town
    for (const t of towns) {
        const r = t.radius;
        const h = ihash(t.x, t.y);
        const isHoriz = (h % 2) === 0;
        t.mainStreetAxis = isHoriz ? 'h' : 'v';
        // Store main street tile keys for frontage biasing later
        t.mainStreetKeys = new Set();
        for (let d = -r; d <= r; d++) {
            for (let w = 0; w <= 1; w++) {
                const tx = isHoriz ? t.x + d : t.x + w;
                const ty = isHoriz ? t.y + w : t.y + d;
                if (canRoadOccupy(terrain, tx, ty)) {
                    const k = ty * CFG.gridW + tx;
                    t.mainStreetKeys.add(k);
                }
            }
        }
    }

    // First expand town roads into the road set (so buildings can check adjacency)
    // Main street tiles get injected first for priority
    const townRoadTiles = [];
    for (const t of towns) {
        // Inject main street tiles
        for (const msKey of t.mainStreetKeys) {
            const mx = msKey % CFG.gridW, my = (msKey / CFG.gridW) | 0;
            let exists = false;
            for (const rt of allRoadTiles) { if (rt.y * CFG.gridW + rt.x === msKey) { exists = true; break; } }
            let dupe = false;
            for (const trt of townRoadTiles) { if (trt.x === mx && trt.y === my) { dupe = true; break; } }
            if (!exists && !dupe) townRoadTiles.push({ x: mx, y: my, type: 1 });
        }

        const r = t.radius;
        const isGrid5 = t.pattern === 'grid5';
        const streets = isGrid5 ? [-r, 0, r] : [-r, r];
        // Horizontal streets
        for (const sy of streets) {
            for (let dx = -r; dx <= r; dx++) {
                const tx = t.x + dx, ty = t.y + sy;
                if (canRoadOccupy(terrain, tx, ty)) {
                    const k = ty * CFG.gridW + tx;
                    let exists = false;
                    for (const rt of allRoadTiles) { if (rt.y * CFG.gridW + rt.x === k) { exists = true; break; } }
                    if (!exists) townRoadTiles.push({ x: tx, y: ty, type: 1 });
                }
            }
        }
        // Vertical streets
        for (const sx of streets) {
            for (let dy = -r; dy <= r; dy++) {
                const tx = t.x + sx, ty = t.y + dy;
                if (canRoadOccupy(terrain, tx, ty)) {
                    const k = ty * CFG.gridW + tx;
                    let exists = false;
                    for (const rt of allRoadTiles) { if (rt.y * CFG.gridW + rt.x === k) { exists = true; break; } }
                    if (!exists) {
                        let dupe = false;
                        for (const trt of townRoadTiles) { if (trt.x === tx && trt.y === ty) { dupe = true; break; } }
                        if (!dupe) townRoadTiles.push({ x: tx, y: ty, type: 1 });
                    }
                }
            }
        }
    }
    console.log('  Town road tiles: ' + townRoadTiles.length);
    const finalRoadTiles = [...allRoadTiles, ...townRoadTiles];

    const { placements, fillers, ROAD_GRID, ROAD_TYPE, occupied, bgBuildings, townProps } = placeBuildings(terrain, finalRoadTiles, towns, buildingDefs);

    // Districts
    const districts = computeDistrictXBands();

    // Landmarks
    const landmarks = genLandmarks(towns, terrain, highwayKeySet);

    // River tiles (for backward compat)
    const riverTiles = [];
    for (let ty = 0; ty < CFG.gridH; ty++) for (let tx = 0; tx < CFG.gridW; tx++) {
        if (terrain[ty][tx] === RIVER) riverTiles.push({ x: tx, y: ty });
    }

    // Verification
    console.log('\nVerification:');
    const ok = verify(terrain, finalRoadTiles, towns, placements, fillers, districts, bgBuildings, townProps);

    // Count check
    if (placements.length !== naArtistCount) {
        console.warn('  Count mismatch: placed ' + placements.length + ' / expected ' + naArtistCount);
    }

    // Build output
    const output = {
        world: { widthTiles: CFG.gridW, heightTiles: CFG.gridH, tileSize: CFG.tileSize },
        terrainGrid: terrain,
        roadTiles: finalRoadTiles,
        towns: towns.map(t => ({ id: t.id, x: t.x, y: t.y, label: t.label, pattern: t.pattern, radius: t.radius, tier: t.tier, artists: t.artists, mainStreetAxis: t.mainStreetAxis || null, profile: t.profile || 'suburb', density: t.density || 2 })),
        buildingPlacements: placements,
        fillerBuildings: fillers,
        bgBuildings: bgBuildings,
        townProps: townProps,
        river: riverTiles,
        districts: districts,
        landmarks: landmarks
    };

    // Write
    const regionsDir = path.join(DATA_DIR, 'regions');
    if (!fs.existsSync(regionsDir)) fs.mkdirSync(regionsDir, { recursive: true });
    const json = JSON.stringify(output, null, 2) + '\n';
    fs.writeFileSync(OUTPUT, json);
    fs.writeFileSync(OUTPUT_MAP, json); // backward compat

    const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(0);
    console.log('\n=== Output: ' + OUTPUT + ' ===');
    console.log('  Size: ' + sizeKB + ' KB');
    if (parseInt(sizeKB) > 200) console.warn('  WARNING: File exceeds 200KB budget!');
    console.log('  Terrain: ' + CFG.gridW + 'x' + CFG.gridH);
    console.log('  Road tiles: ' + finalRoadTiles.length + ' (highway: ' + hwTiles.length + ', spur: ' + spurTiles.length + ', town: ' + townRoadTiles.length + ')');
    console.log('  Towns: ' + towns.length);
    console.log('  Buildings: ' + placements.length + ' artist + ' + fillers.length + ' filler');
    console.log('  Districts: ' + districts.length);
    console.log('  Landmarks: ' + landmarks.length);

    // ASCII preview
    console.log('\nASCII preview (every 2nd tile):');
    const chars = ['.', '~', '#', '^', '≈'];
    const bldgSet = new Set();
    for (const p of placements) bldgSet.add(p.y * CFG.gridW + p.x);
    for (const f of fillers) bldgSet.add(f.y * CFG.gridW + f.x);
    const roadSet = new Set(finalRoadTiles.map(r => r.y * CFG.gridW + r.x));
    const hwSet = new Set(hwTiles.map(r => r.y * CFG.gridW + r.x));
    for (let y = 0; y < CFG.gridH; y += 2) {
        let row = '';
        for (let x = 0; x < CFG.gridW; x += 2) {
            const k = y * CFG.gridW + x;
            if (bldgSet.has(k)) row += 'B';
            else if (hwSet.has(k)) row += '=';
            else if (roadSet.has(k)) row += '-';
            else row += chars[terrain[y][x]] || '?';
        }
        process.stdout.write(row + '\n');
    }

    console.log('\nDone.');
}

main();
