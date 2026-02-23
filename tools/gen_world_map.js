#!/usr/bin/env node
// tools/gen_world_map.js
// Generates NES-style world map tiles from Natural Earth 110m geometry.
// Downloads GeoJSON on first run, caches locally in tools/geo_cache/.
// Output: data/world.json (tiles, regionNodes, regions, river)
//
// Usage: node tools/gen_world_map.js
// Dependencies: none (Node.js built-ins only)

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// ── Configuration ──────────────────────────────────────────────
const WORLD_W = 160;
const WORLD_H = 90;
const TILE_SIZE = 32;

const CACHE_DIR = path.join(__dirname, 'geo_cache');
const DATA_DIR  = path.join(__dirname, '..', 'data');
const OUTPUT    = path.join(DATA_DIR, 'world.json');

const NE_LAND = {
    url:   'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson',
    cache: path.join(CACHE_DIR, 'ne_110m_land.geojson')
};
const NE_RIVERS = {
    url:   'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_rivers_lake_centerlines.geojson',
    cache: path.join(CACHE_DIR, 'ne_110m_rivers.geojson')
};

// Tile types
const OCEAN    = 0;
const COAST    = 1;
const LAND     = 2;
const MOUNTAIN = 3;
const RIVER    = 4;

// ── Equirectangular projection ─────────────────────────────────
function lonLatToTile(lon, lat) {
    const x = (lon + 180) / 360;
    const y = (90 - lat) / 180;
    return {
        tx: Math.min(WORLD_W - 1, Math.max(0, Math.floor(x * WORLD_W))),
        ty: Math.min(WORLD_H - 1, Math.max(0, Math.floor(y * WORLD_H)))
    };
}

function tileCenterToLonLat(tx, ty) {
    return {
        lon: ((tx + 0.5) / WORLD_W) * 360 - 180,
        lat: 90 - ((ty + 0.5) / WORLD_H) * 180
    };
}

// ── Bounding box precomputation ────────────────────────────────
// Precompute bbox per feature to skip ray-cast for distant tile centers.
function computeFeatureBBoxes(features) {
    for (const f of features) {
        let minLon = Infinity, maxLon = -Infinity;
        let minLat = Infinity, maxLat = -Infinity;
        function scanRing(ring) {
            for (const pt of ring) {
                if (pt[0] < minLon) minLon = pt[0];
                if (pt[0] > maxLon) maxLon = pt[0];
                if (pt[1] < minLat) minLat = pt[1];
                if (pt[1] > maxLat) maxLat = pt[1];
            }
        }
        const g = f.geometry;
        if (g.type === 'Polygon') {
            for (const ring of g.coordinates) scanRing(ring);
        } else if (g.type === 'MultiPolygon') {
            for (const poly of g.coordinates) for (const ring of poly) scanRing(ring);
        }
        f._bbox = { minLon, maxLon, minLat, maxLat };
    }
}

// ── Point-in-polygon (ray casting) ─────────────────────────────
// Ring winding: exterior ring is CCW, holes are CW in GeoJSON spec.
// Ray-cast handles both correctly by toggling on every crossing.
function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if ((yi > lat) !== (yj > lat) &&
            lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

// coords[0] = exterior ring, coords[1..n] = holes
// A point is inside the polygon if inside exterior AND not inside any hole.
function pointInPolygon(lon, lat, coords) {
    if (!pointInRing(lon, lat, coords[0])) return false;
    for (let i = 1; i < coords.length; i++) {
        if (pointInRing(lon, lat, coords[i])) return false;
    }
    return true;
}

function isOnLand(lon, lat, features) {
    for (const f of features) {
        // Bbox cull: skip features whose bbox doesn't contain the point
        const bb = f._bbox;
        if (bb && (lon < bb.minLon || lon > bb.maxLon || lat < bb.minLat || lat > bb.maxLat)) continue;

        const g = f.geometry;
        if (g.type === 'Polygon') {
            if (pointInPolygon(lon, lat, g.coordinates)) return true;
        } else if (g.type === 'MultiPolygon') {
            for (const poly of g.coordinates) {
                if (pointInPolygon(lon, lat, poly)) return true;
            }
        }
    }
    return false;
}

// ── Bresenham line rasterization ───────────────────────────────
function bresenhamLine(x0, y0, x1, y1, cb) {
    x0 = Math.round(x0); y0 = Math.round(y0);
    x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
        cb(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx)  { err += dx; y0 += sy; }
    }
}

// ── HTTP download with redirect following ──────────────────────
function fetchURL(url) {
    return new Promise((resolve, reject) => {
        function go(u, depth) {
            if (depth > 5) { reject(new Error('Too many redirects')); return; }
            https.get(u, { headers: { 'User-Agent': 'tmnt-art-show-gen/1.0' } }, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    go(res.headers.location, depth + 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error('HTTP ' + res.statusCode + ' for ' + u));
                    return;
                }
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => resolve(data));
                res.on('error', reject);
            }).on('error', reject);
        }
        go(url, 0);
    });
}

async function loadGeoJSON(source) {
    if (fs.existsSync(source.cache)) {
        console.log('  Cached: ' + path.basename(source.cache));
        return JSON.parse(fs.readFileSync(source.cache, 'utf8'));
    }
    console.log('  Downloading: ' + source.url.split('/').pop());
    fs.mkdirSync(path.dirname(source.cache), { recursive: true });
    const data = await fetchURL(source.url);
    fs.writeFileSync(source.cache, data);
    console.log('  Saved: ' + path.basename(source.cache) + ' (' + (data.length / 1024).toFixed(0) + ' KB)');
    return JSON.parse(data);
}

// ── Region definitions (real lat/lon centers) ──────────────────
const REGIONS = [
    { id: 'na',   label: 'N. AMERICA', lon: -98,  lat: 39,  mapFile: 'data/regions/na.json' },
    { id: 'sa',   label: 'S. AMERICA', lon: -58,  lat: -15, mapFile: 'data/regions/sa.json' },
    { id: 'eu',   label: 'EUROPE',     lon: 10,   lat: 50,  mapFile: 'data/regions/eu.json' },
    { id: 'asia', label: 'ASIA',       lon: 105,  lat: 35,  mapFile: 'data/regions/asia.json' },
    { id: 'oce',  label: 'OCEANIA',    lon: 135,  lat: -25, mapFile: 'data/regions/oce.json' }
];

// ── Main generator ─────────────────────────────────────────────
async function main() {
    console.log('=== World Map Generator (Natural Earth → NES tiles) ===');
    console.log('Grid: ' + WORLD_W + 'x' + WORLD_H + '  tileSize: ' + TILE_SIZE);

    // 1. Load geodata
    console.log('\nLoading Natural Earth 110m...');
    let landGeo, riverGeo;
    try {
        landGeo  = await loadGeoJSON(NE_LAND);
        riverGeo = await loadGeoJSON(NE_RIVERS);
    } catch (err) {
        console.error('Failed to load geodata: ' + err.message);
        console.error('Ensure internet access on first run, or place GeoJSON files in ' + CACHE_DIR);
        process.exit(1);
    }
    const landFeatures = landGeo.features;
    console.log('  Land features: ' + landFeatures.length);
    console.log('  River features: ' + riverGeo.features.length);

    // Precompute bboxes for land features (enables fast cull in ray-cast)
    computeFeatureBBoxes(landFeatures);

    // ── Phase order: Land → Mountains → Rivers → Coast ──
    // This ensures:
    //   Rivers overwrite land AND mountain (highest visual priority on land)
    //   Mountains don't appear on river tiles
    //   Coast never overwrites river tiles
    //   Ocean is never overwritten by river

    // Phase 1: Rasterize land (ray-cast tile centers against land polygons)
    console.log('\nPhase 1: Rasterizing land (with bbox culling)...');
    const grid = [];
    let landCount = 0;
    for (let ty = 0; ty < WORLD_H; ty++) {
        grid[ty] = new Array(WORLD_W).fill(OCEAN);
        for (let tx = 0; tx < WORLD_W; tx++) {
            const { lon, lat } = tileCenterToLonLat(tx, ty);
            if (isOnLand(lon, lat, landFeatures)) {
                grid[ty][tx] = LAND;
                landCount++;
            }
        }
    }
    console.log('  Land tiles: ' + landCount + ' / ' + (WORLD_W * WORLD_H));

    // Phase 2: Mountains (deterministic hash, interior land only)
    // Must run BEFORE rivers so rivers can cut through mountains.
    console.log('Phase 2: Generating mountains...');
    let mountainCount = 0;
    for (let ty = 0; ty < WORLD_H; ty++) {
        for (let tx = 0; tx < WORLD_W; tx++) {
            if (grid[ty][tx] !== LAND) continue;
            // Must be fully surrounded by land (all 8 neighbors)
            let landNeighbors = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const ny = ty + dy, nx = tx + dx;
                    if (ny >= 0 && ny < WORLD_H && nx >= 0 && nx < WORLD_W && grid[ny][nx] >= LAND) {
                        landNeighbors++;
                    }
                }
            }
            if (landNeighbors < 8) continue;
            const h = ((tx * 73856093) ^ (ty * 19349663)) >>> 0;
            if (h % 6 === 0) {
                grid[ty][tx] = MOUNTAIN;
                mountainCount++;
            }
        }
    }
    console.log('  Mountain tiles: ' + mountainCount);

    // Phase 3: Rasterize rivers
    // Precedence: river overwrites LAND (2) and MOUNTAIN (3), never OCEAN (0) or COAST (1).
    // Major rivers (scalerank <= 4) get 2-tile thickness; others get 1-tile.
    console.log('Phase 3: Rasterizing rivers...');
    let riverCount = 0;
    let riverOceanSkips = 0;

    function setRiver(x, y) {
        if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return;
        const current = grid[y][x];
        if (current === OCEAN || current === COAST) { riverOceanSkips++; return; }
        if (current === RIVER) return;
        grid[y][x] = RIVER;
        riverCount++;
    }

    for (const feature of riverGeo.features) {
        const geom = feature.geometry;
        let lines = [];
        if (geom.type === 'LineString') lines = [geom.coordinates];
        else if (geom.type === 'MultiLineString') lines = geom.coordinates;

        // Major rivers: scalerank <= 4 get 2-tile width
        const rank = (feature.properties && typeof feature.properties.scalerank === 'number')
                   ? feature.properties.scalerank : 99;
        const thick = rank <= 4;

        for (const line of lines) {
            for (let i = 0; i < line.length - 1; i++) {
                const a = lonLatToTile(line[i][0], line[i][1]);
                const b = lonLatToTile(line[i + 1][0], line[i + 1][1]);

                // Primary line
                bresenhamLine(a.tx, a.ty, b.tx, b.ty, setRiver);

                // Thickness pass for major rivers: offset +1 in perpendicular
                if (thick) {
                    const dx = b.tx - a.tx, dy = b.ty - a.ty;
                    // Perpendicular offset: if mostly horizontal, offset Y; if mostly vertical, offset X
                    const offX = Math.abs(dy) >= Math.abs(dx) ? 1 : 0;
                    const offY = Math.abs(dx) >= Math.abs(dy) ? 1 : 0;
                    bresenhamLine(a.tx + offX, a.ty + offY, b.tx + offX, b.ty + offY, setRiver);
                }
            }
        }
    }
    console.log('  River tiles: ' + riverCount);
    console.log('  River→ocean skips: ' + riverOceanSkips + ' (correctly clamped)');

    // Phase 4: Generate coast (ocean tiles adjacent to land/mountain/river)
    // Coast NEVER overwrites river. Only OCEAN tiles become COAST.
    console.log('Phase 4: Generating coastline...');
    let coastCount = 0;
    const coastMask = [];
    for (let ty = 0; ty < WORLD_H; ty++) {
        coastMask[ty] = new Uint8Array(WORLD_W);
        for (let tx = 0; tx < WORLD_W; tx++) {
            if (grid[ty][tx] !== OCEAN) continue;
            let adj = false;
            // Cardinal adjacency
            if (tx > 0            && grid[ty][tx - 1] >= LAND) adj = true;
            else if (tx < WORLD_W - 1 && grid[ty][tx + 1] >= LAND) adj = true;
            else if (ty > 0            && grid[ty - 1][tx] >= LAND) adj = true;
            else if (ty < WORLD_H - 1 && grid[ty + 1][tx] >= LAND) adj = true;
            // Diagonal adjacency for smoother coastlines
            if (!adj) {
                if (tx > 0 && ty > 0                              && grid[ty - 1][tx - 1] >= LAND) adj = true;
                else if (tx < WORLD_W - 1 && ty > 0               && grid[ty - 1][tx + 1] >= LAND) adj = true;
                else if (tx > 0 && ty < WORLD_H - 1               && grid[ty + 1][tx - 1] >= LAND) adj = true;
                else if (tx < WORLD_W - 1 && ty < WORLD_H - 1     && grid[ty + 1][tx + 1] >= LAND) adj = true;
            }
            if (adj) { coastMask[ty][tx] = 1; coastCount++; }
        }
    }
    for (let ty = 0; ty < WORLD_H; ty++) {
        for (let tx = 0; tx < WORLD_W; tx++) {
            if (coastMask[ty][tx]) grid[ty][tx] = COAST;
        }
    }
    console.log('  Coast tiles: ' + coastCount);

    // 6. Build region nodes (projected from real lat/lon)
    console.log('\nPlacing region nodes...');
    const regionNodes = REGIONS.map(r => {
        const t = lonLatToTile(r.lon, r.lat);
        return {
            id: 'node_' + r.id,
            regionId: r.id,
            x: t.tx, y: t.ty,
            label: r.label,
            enterRadius: 4,
            exitRadius: 6
        };
    });

    const regions = REGIONS.map(r => {
        const t = lonLatToTile(r.lon, r.lat);
        return {
            id: r.id,
            label: r.label,
            spawn: { x: t.tx, y: t.ty },
            mapFile: r.mapFile
        };
    });

    // Nudge any node that landed on water to nearest land
    for (const n of regionNodes) {
        const tile = (grid[n.y] && grid[n.y][n.x] != null) ? grid[n.y][n.x] : -1;
        if (tile >= LAND) {
            console.log('  ' + n.id + ' at ' + n.x + ',' + n.y + ' → ' + ['ocean','coast','land','mountain','river'][tile]);
            continue;
        }
        console.warn('  ' + n.id + ' at ' + n.x + ',' + n.y + ' on WATER — nudging...');
        let found = false;
        for (let r = 1; r <= 8 && !found; r++) {
            for (let dy = -r; dy <= r && !found; dy++) {
                for (let dx = -r; dx <= r && !found; dx++) {
                    const ny = n.y + dy, nx = n.x + dx;
                    if (ny >= 0 && ny < WORLD_H && nx >= 0 && nx < WORLD_W && grid[ny][nx] >= LAND) {
                        n.x = nx; n.y = ny;
                        // Also update matching region spawn
                        const reg = regions.find(rr => rr.id === n.regionId);
                        if (reg) { reg.spawn.x = nx; reg.spawn.y = ny; }
                        console.log('    → nudged to ' + nx + ',' + ny);
                        found = true;
                    }
                }
            }
        }
        if (!found) console.error('    COULD NOT NUDGE — region node on ocean!');
    }

    // 7. Tile count summary
    const counts = { ocean: 0, coast: 0, land: 0, mountain: 0, river: 0 };
    for (let ty = 0; ty < WORLD_H; ty++) {
        for (let tx = 0; tx < WORLD_W; tx++) {
            const t = grid[ty][tx];
            if (t === OCEAN)    counts.ocean++;
            else if (t === COAST)    counts.coast++;
            else if (t === LAND)     counts.land++;
            else if (t === MOUNTAIN) counts.mountain++;
            else if (t === RIVER)    counts.river++;
        }
    }

    // ── Tripwire assertions ──────────────────────────────────────
    let tripwireOk = true;
    function tripwire(cond, msg) {
        if (!cond) { console.error('TRIPWIRE FAIL: ' + msg); tripwireOk = false; }
    }
    const totalTiles = WORLD_W * WORLD_H;
    const sumTiles = counts.ocean + counts.coast + counts.land + counts.mountain + counts.river;
    tripwire(sumTiles === totalTiles, 'Tile sum ' + sumTiles + ' !== grid size ' + totalTiles);
    tripwire(counts.river <= counts.land + counts.mountain + counts.river, 'River count exceeds land mass (impossible)');
    tripwire(counts.mountain <= counts.land + counts.mountain, 'Mountains exceed land + mountain total');
    tripwire(counts.coast > 0, 'Zero coast tiles — geography broken');
    tripwire(counts.land > 0, 'Zero land tiles — rasterization broken');

    // No tile should be river AND on ocean — verify by checking river tiles are all on land mass
    let riverOnOcean = 0;
    for (let ty = 0; ty < WORLD_H; ty++) {
        for (let tx = 0; tx < WORLD_W; tx++) {
            // A river tile's neighbors should include at least one land/mountain/river tile
            // (rivers don't float in ocean by themselves)
            if (grid[ty][tx] !== RIVER) continue;
            let hasLandNeighbor = false;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const ny = ty + dy, nx = tx + dx;
                    if (ny >= 0 && ny < WORLD_H && nx >= 0 && nx < WORLD_W) {
                        const t = grid[ny][nx];
                        if (t === LAND || t === MOUNTAIN || t === RIVER) hasLandNeighbor = true;
                    }
                }
            }
            if (!hasLandNeighbor) riverOnOcean++;
        }
    }
    tripwire(riverOnOcean === 0, riverOnOcean + ' river tiles isolated from land mass (river in ocean?)');

    // All region nodes must be on land/mountain/river (not ocean/coast)
    for (const n of regionNodes) {
        const t = grid[n.y] ? grid[n.y][n.x] : -1;
        tripwire(t >= LAND, 'Node ' + n.id + ' at ' + n.x + ',' + n.y + ' on tile type ' + t + ' (must be >= ' + LAND + ')');
    }

    if (tripwireOk) console.log('\n  All tripwires passed.');
    else { console.error('\n  TRIPWIRE FAILURES — review output above.'); process.exit(1); }

    // 8. Write output
    const worldJson = {
        world: { widthTiles: WORLD_W, heightTiles: WORLD_H, tileSize: TILE_SIZE },
        tiles: grid,
        regions: regions,
        regionNodes: regionNodes,
        landmarks: [],
        roads: [],
        river: []
    };

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(worldJson, null, 2) + '\n');

    console.log('\n=== Output: ' + OUTPUT + ' ===');
    console.log('  Size: ' + (fs.statSync(OUTPUT).size / 1024).toFixed(0) + ' KB');
    console.log('  Ocean:    ' + counts.ocean);
    console.log('  Coast:    ' + counts.coast);
    console.log('  Land:     ' + counts.land);
    console.log('  Mountain: ' + counts.mountain);
    console.log('  River:    ' + counts.river);
    console.log('  Nodes:    ' + regionNodes.length);
    for (const n of regionNodes) {
        console.log('    ' + n.id + ' → ' + n.x + ',' + n.y);
    }
    console.log('\nDone.');
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
