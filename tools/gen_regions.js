#!/usr/bin/env node
// tools/gen_regions.js
// Unified region generator for all 5 regions.
// Uses REAL highway data from Natural Earth 10m roads dataset.
// Run gen_world_map.js first to cache Natural Earth data, then:
//   node tools/gen_regions.js          (all regions)
//   node tools/gen_regions.js na       (single region)

'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'geo_cache');
const DATA_DIR  = path.join(__dirname, '..', 'data');

const OCEAN = 0, COAST = 1, LAND = 2, MOUNTAIN = 3, RIVER = 4;

// ── Region definitions ────────────────────────────────────────
const REGIONS = {
    na:   { id: 'na',   label: 'N. AMERICA', gridW: 1200, gridH: 900, tileSize: 64,
            latMin: 15, latMax: 55, lonMin: -135, lonMax: -55,
            roadFilter: { continents: ['North America', 'North America x-fade'], maxScalerank: 5, expressway: true } },
    sa:   { id: 'sa',   label: 'S. AMERICA', gridW: 750,  gridH: 900, tileSize: 64,
            latMin: -55, latMax: 15, lonMin: -85, lonMax: -30,
            roadFilter: { continents: ['South America'], maxScalerank: 5, expressway: true } },
    eu:   { id: 'eu',   label: 'EUROPE',     gridW: 900,  gridH: 600, tileSize: 64,
            latMin: 35, latMax: 62, lonMin: -12, lonMax: 35,
            roadFilter: { continents: ['Europe'], maxScalerank: 5, expressway: true } },
    asia: { id: 'asia', label: 'ASIA',       gridW: 1050, gridH: 750, tileSize: 64,
            latMin: -15, latMax: 55, lonMin: 60, lonMax: 155,
            roadFilter: { continents: ['Asia'], maxScalerank: 4, expressway: false } },
    oce:  { id: 'oce',  label: 'OCEANIA',    gridW: 750,  gridH: 600, tileSize: 64,
            latMin: -50, latMax: -5, lonMin: 110, lonMax: 180,
            roadFilter: { continents: ['Oceania'], maxScalerank: 5, expressway: false } }
};

// ── Layout constants ──────────────────────────────────────────
const BLOCK_SIZE     = 8;
const ROAD_SETBACK   = 2;
const MIN_BLD_SPACE  = 6;
const BG_DENSITY     = 4;

// ── Geometry helpers ──────────────────────────────────────────

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
    for (;;) {
        cb(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx)  { err += dx; y0 += sy; }
    }
}

// Ramer-Douglas-Peucker path simplification.
// Reduces dense coordinate sequences to key direction-change points,
// so L-shaped road drawing produces long straight segments.
function simplifyPath(points, tolerance) {
    if (points.length <= 2) return points;
    const fx = points[0].tx, fy = points[0].ty;
    const lx = points[points.length - 1].tx, ly = points[points.length - 1].ty;
    const dx = lx - fx, dy = ly - fy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return [points[0]];

    let maxDist = 0, maxIdx = 0;
    for (let i = 1; i < points.length - 1; i++) {
        const d = Math.abs(dx * (fy - points[i].ty) - dy * (fx - points[i].tx)) / len;
        if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > tolerance) {
        const left = simplifyPath(points.slice(0, maxIdx + 1), tolerance);
        const right = simplifyPath(points.slice(maxIdx), tolerance);
        return left.slice(0, -1).concat(right);
    }
    return [points[0], points[points.length - 1]];
}

function ihash(a, b) { return (((a * 73856093) ^ (b * 19349663)) >>> 0); }

// ── Load data ────────────────────────────────────────────────

function loadNaturalEarth() {
    const landPath  = path.join(CACHE_DIR, 'ne_50m_land.geojson');
    const riverPath = path.join(CACHE_DIR, 'ne_50m_rivers.geojson');
    const roadPath  = path.join(CACHE_DIR, 'ne_10m_roads.geojson');
    for (const p of [landPath, riverPath, roadPath]) {
        if (!fs.existsSync(p)) { console.error('Missing: ' + p); process.exit(1); }
    }
    const landGeo  = JSON.parse(fs.readFileSync(landPath, 'utf8'));
    const riverGeo = JSON.parse(fs.readFileSync(riverPath, 'utf8'));
    const roadGeo  = JSON.parse(fs.readFileSync(roadPath, 'utf8'));
    computeFeatureBBoxes(landGeo.features);
    return {
        landFeatures: landGeo.features,
        riverFeatures: riverGeo.features,
        roadFeatures: roadGeo.features
    };
}

// ── Projection ───────────────────────────────────────────────

function projectToRegion(lat, lon, cfg) {
    const x = (lon - cfg.lonMin) / (cfg.lonMax - cfg.lonMin);
    const y = (cfg.latMax - lat) / (cfg.latMax - cfg.latMin);
    return {
        tx: Math.min(cfg.gridW - 1, Math.max(0, Math.round(x * (cfg.gridW - 1)))),
        ty: Math.min(cfg.gridH - 1, Math.max(0, Math.round(y * (cfg.gridH - 1))))
    };
}

function regionTileToLonLat(tx, ty, cfg) {
    return {
        lon: cfg.lonMin + ((tx + 0.5) / cfg.gridW) * (cfg.lonMax - cfg.lonMin),
        lat: cfg.latMax - ((ty + 0.5) / cfg.gridH) * (cfg.latMax - cfg.latMin)
    };
}

// ── Terrain rasterization ────────────────────────────────────

function rasterizeTerrain(cfg, landFeatures, riverFeatures) {
    const W = cfg.gridW, H = cfg.gridH;
    const grid = [];
    let landCount = 0;

    for (let ty = 0; ty < H; ty++) {
        grid[ty] = new Array(W).fill(OCEAN);
        for (let tx = 0; tx < W; tx++) {
            const { lon, lat } = regionTileToLonLat(tx, ty, cfg);
            if (isOnLand(lon, lat, landFeatures)) { grid[ty][tx] = LAND; landCount++; }
        }
    }

    let mtnCount = 0;
    for (let ty = 0; ty < H; ty++) {
        for (let tx = 0; tx < W; tx++) {
            if (grid[ty][tx] !== LAND) continue;
            let allLand = true;
            for (let dy = -1; dy <= 1 && allLand; dy++) {
                for (let dx = -1; dx <= 1 && allLand; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const ny = ty + dy, nx = tx + dx;
                    if (ny < 0 || ny >= H || nx < 0 || nx >= W || grid[ny][nx] < LAND) allLand = false;
                }
            }
            if (!allLand) continue;
            if (ihash(tx, ty) % 10 === 0) { grid[ty][tx] = MOUNTAIN; mtnCount++; }
        }
    }

    let riverCount = 0;
    function setRiver(x, y) {
        if (x < 0 || x >= W || y < 0 || y >= H) return;
        if (grid[y][x] < LAND || grid[y][x] === RIVER) return;
        grid[y][x] = RIVER; riverCount++;
    }
    for (const feature of riverFeatures) {
        const rank = (feature.properties && typeof feature.properties.scalerank === 'number') ? feature.properties.scalerank : 99;
        if (rank > 2) continue;
        const geom = feature.geometry;
        let lines = [];
        if (geom.type === 'LineString') lines = [geom.coordinates];
        else if (geom.type === 'MultiLineString') lines = geom.coordinates;
        for (const line of lines) {
            for (let i = 0; i < line.length - 1; i++) {
                const a = projectToRegion(line[i][1], line[i][0], cfg);
                const b = projectToRegion(line[i+1][1], line[i+1][0], cfg);
                bresenhamLine(a.tx, a.ty, b.tx, b.ty, setRiver);
            }
        }
    }

    let coastCount = 0;
    const coastMask = [];
    for (let ty = 0; ty < H; ty++) {
        coastMask[ty] = new Uint8Array(W);
        for (let tx = 0; tx < W; tx++) {
            if (grid[ty][tx] !== OCEAN) continue;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const ny = ty + dy, nx = tx + dx;
                    if (ny >= 0 && ny < H && nx >= 0 && nx < W && grid[ny][nx] >= LAND) {
                        coastMask[ty][tx] = 1; coastCount++; dy = 2; break;
                    }
                }
            }
        }
    }
    for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
        if (coastMask[ty][tx]) grid[ty][tx] = COAST;
    }

    console.log('  Land: ' + landCount + ', Mtn: ' + mtnCount + ', River: ' + riverCount + ', Coast: ' + coastCount);
    return grid;
}

// ── Nudge to land ────────────────────────────────────────────

function nudgeToLand(tx, ty, grid, cfg) {
    if (tx >= 0 && tx < cfg.gridW && ty >= 0 && ty < cfg.gridH && grid[ty][tx] >= LAND) return { tx, ty };
    for (let r = 1; r <= 25; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                const ny = ty + dy, nx = tx + dx;
                if (ny >= 0 && ny < cfg.gridH && nx >= 0 && nx < cfg.gridW && grid[ny][nx] >= LAND) {
                    return { tx: nx, ty: ny };
                }
            }
        }
    }
    return { tx, ty };
}

// ── Town creation from artists ───────────────────────────────

function buildTowns(artists, cfg, grid) {
    const cityMap = {};
    for (const a of artists) {
        if (typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
        const key = (a.city || 'Unknown') + '|' + (a.country || '');
        if (!cityMap[key]) cityMap[key] = { city: a.city || 'Unknown', artists: [], latSum: 0, lonSum: 0 };
        cityMap[key].artists.push(a.id);
        cityMap[key].latSum += a.lat;
        cityMap[key].lonSum += a.lon;
    }

    const towns = [];
    for (const key of Object.keys(cityMap)) {
        const c = cityMap[key];
        const n = c.artists.length;
        const avgLat = c.latSum / n;
        const avgLon = c.lonSum / n;
        const proj = projectToRegion(avgLat, avgLon, cfg);
        const nudged = nudgeToLand(proj.tx, proj.ty, grid, cfg);
        const id = c.city.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const radius = n >= 15 ? 20 : n >= 8 ? 16 : n >= 5 ? 12 : n >= 3 ? 10 : 8;
        towns.push({
            id, x: nudged.tx, y: nudged.ty,
            label: c.city.toUpperCase(),
            pattern: n >= 5 ? 'grid5' : 'grid3',
            radius, tier: n >= 5 ? 'A' : n >= 3 ? 'B' : 'C',
            artists: c.artists,
            profile: n >= 5 ? 'metro' : n >= 3 ? 'suburb' : 'town',
            density: Math.min(5, n)
        });
    }

    for (let i = 0; i < towns.length; i++) {
        for (let j = i + 1; j < towns.length; j++) {
            const dist = Math.abs(towns[i].x - towns[j].x) + Math.abs(towns[i].y - towns[j].y);
            if (dist < 12) {
                towns[i].artists = towns[i].artists.concat(towns[j].artists);
                towns[i].label = towns[i].artists.length >= towns[j].artists.length ? towns[i].label : towns[j].label;
                const nn = towns[i].artists.length;
                towns[i].radius = nn >= 15 ? 20 : nn >= 8 ? 16 : nn >= 5 ? 12 : nn >= 3 ? 10 : 8;
                towns.splice(j, 1); j--;
            }
        }
    }

    console.log('  Towns: ' + towns.length + ' from ' + artists.length + ' artists');
    return towns;
}

// ── Road generation from Natural Earth 10m roads ─────────────

function filterRoadsForRegion(roadFeatures, cfg) {
    const filter = cfg.roadFilter;
    const matched = [];
    for (const f of roadFeatures) {
        const p = f.properties || {};
        if (!filter.continents.includes(p.continent)) continue;
        if ((p.scalerank || 99) > filter.maxScalerank) continue;
        if (p.type !== 'Major Highway') continue;
        if (filter.expressway && !p.expressway) continue;
        matched.push(f);
    }
    return matched;
}

function generateRoads(towns, grid, cfg, roadFeatures) {
    const W = cfg.gridW, H = cfg.gridH;
    const roadSet = new Set();
    const roadTiles = [];
    // Track travel direction per tile for yellow center line masks:
    // 1=N, 2=E, 4=S, 8=W. Straight vertical=5(N+S), straight horizontal=10(E+W).
    const dirMap = new Uint8Array(W * H);

    function addRoad(x, y, cls, dirBits) {
        if (x < 0 || x >= W || y < 0 || y >= H) return;
        const k = y * W + x;
        dirMap[k] |= dirBits;
        if (roadSet.has(k)) return;
        roadSet.add(k);
        roadTiles.push({ x, y, class: cls });
    }

    // Draw a 2-wide horizontal run and tag direction bits
    function drawH(x0, x1, y, cls) {
        const sx = x0 <= x1 ? 1 : -1;
        for (let x = x0; x !== x1 + sx; x += sx) {
            addRoad(x, y,     cls, 10); // E+W
            addRoad(x, y + 1, cls, 10);
        }
    }
    // Draw a 2-wide vertical run and tag direction bits
    function drawV(x, y0, y1, cls) {
        const sy = y0 <= y1 ? 1 : -1;
        for (let y = y0; y !== y1 + sy; y += sy) {
            addRoad(x,     y, cls, 5); // N+S
            addRoad(x + 1, y, cls, 5);
        }
    }

    // ── Phase 1: Real highway data from Natural Earth ──
    const regionRoads = filterRoadsForRegion(roadFeatures, cfg);
    console.log('  Real highway features: ' + regionRoads.length);

    const SIMPLIFY_TOLERANCE = 20;

    for (const feature of regionRoads) {
        const geom = feature.geometry;
        let lines = [];
        if (geom.type === 'LineString') lines = [geom.coordinates];
        else if (geom.type === 'MultiLineString') lines = geom.coordinates;

        for (const line of lines) {
            const projected = [];
            let prevKey = '';
            for (const coord of line) {
                const p = projectToRegion(coord[1], coord[0], cfg);
                const k = p.tx + ',' + p.ty;
                if (k !== prevKey) { projected.push(p); prevKey = k; }
            }
            if (projected.length < 2) continue;

            const simplified = simplifyPath(projected, SIMPLIFY_TOLERANCE);

            for (let i = 0; i < simplified.length - 1; i++) {
                const a = simplified[i], b = simplified[i + 1];
                const adx = Math.abs(b.tx - a.tx), ady = Math.abs(b.ty - a.ty);
                if (adx >= ady) {
                    drawH(a.tx, b.tx, a.ty, 'highway');
                    if (a.ty !== b.ty) drawV(b.tx, a.ty, b.ty, 'highway');
                } else {
                    drawV(a.tx, a.ty, b.ty, 'highway');
                    if (a.tx !== b.tx) drawH(a.tx, b.tx, b.ty, 'highway');
                }
            }
        }
    }
    const hwTileCount = roadTiles.length;
    console.log('  Highway tiles: ' + hwTileCount);

    // ── Phase 2: Spur roads connecting towns to nearest highway ──
    let spurCount = 0;
    if (hwTileCount > 0) {
        const hwBucketSize = 20;
        const hwBuckets = {};
        for (const rt of roadTiles) {
            if (rt.class !== 'highway') continue;
            const bk = Math.floor(rt.x / hwBucketSize) + ',' + Math.floor(rt.y / hwBucketSize);
            if (!hwBuckets[bk]) hwBuckets[bk] = [];
            hwBuckets[bk].push(rt);
        }

        for (const t of towns) {
            const tbx = Math.floor(t.x / hwBucketSize);
            const tby = Math.floor(t.y / hwBucketSize);
            let bestDist = Infinity, bestX = -1, bestY = -1;
            for (let bdy = -5; bdy <= 5; bdy++) {
                for (let bdx = -5; bdx <= 5; bdx++) {
                    const bucket = hwBuckets[(tbx + bdx) + ',' + (tby + bdy)];
                    if (!bucket) continue;
                    for (const rt of bucket) {
                        const d = Math.abs(rt.x - t.x) + Math.abs(rt.y - t.y);
                        if (d < bestDist) { bestDist = d; bestX = rt.x; bestY = rt.y; }
                    }
                }
            }
            if (bestX === -1 || bestDist <= 2) continue;

            if (t.x !== bestX) drawH(t.x, bestX, t.y, 'arterial');
            if (t.y !== bestY) drawV(bestX, t.y, bestY, 'arterial');
            spurCount++;
        }
    }
    console.log('  Spur roads: ' + spurCount);

    // ── Phase 3: Town internal street grid ──
    for (const t of towns) {
        const r = t.radius;
        for (let sy = -r; sy <= r; sy += BLOCK_SIZE) {
            drawH(t.x - r, t.x + r, t.y + sy, 'local');
        }
        for (let sx = -r; sx <= r; sx += BLOCK_SIZE) {
            drawV(t.x + sx, t.y - r, t.y + r, 'local');
        }
    }

    console.log('  Total road tiles: ' + roadTiles.length);
    return { roadTiles, roadSet, dirMap };
}

// ── Road graph ───────────────────────────────────────────────
// Uses dirMap (travel direction bits) so the yellow center line
// renders on straight segments of 2-wide roads correctly.

function buildRoadGraph(roadTiles, roadSet, dirMap, cfg) {
    const W = cfg.gridW;
    const graph = [];
    for (const r of roadTiles) {
        const mask = dirMap[r.y * W + r.x] || 0;
        graph.push({ x: r.x, y: r.y, class: r.class, mask });
    }
    return graph;
}

// ── Distance to nearest road ─────────────────────────────────

function minRoadDist(tx, ty, roadSet, W) {
    for (let r = 0; r <= 4; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.abs(dx) !== r && Math.abs(dy) !== r && r > 0) continue;
                if (roadSet.has((ty + dy) * W + (tx + dx))) return r;
            }
        }
    }
    return 99;
}

// ── Artist building placement ────────────────────────────────

function placeArtistBuildings(towns, grid, roadSet, cfg) {
    const W = cfg.gridW, H = cfg.gridH;
    const occupied = new Set();
    const placements = [];

    // Load buildings.json to identify special building types
    const buildingsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'buildings.json'), 'utf8'));
    const bldgTypeMap = {};
    for (const b of buildingsData.buildings) {
        if (b.buildingType && b.buildingType !== 'gallery') {
            bldgTypeMap[b.artistId] = b.buildingType;
        }
    }

    function isValidSpot(tx, ty, extraSpace) {
        if (tx < 0 || tx >= W || ty < 0 || ty >= H) return false;
        if (grid[ty][tx] < LAND) return false;
        const k = ty * W + tx;
        if (occupied.has(k) || roadSet.has(k)) return false;

        const dist = minRoadDist(tx, ty, roadSet, W);
        if (dist < ROAD_SETBACK || dist > ROAD_SETBACK + 1) return false;

        const minDist = extraSpace || MIN_BLD_SPACE;
        for (const p of placements) {
            if (Math.abs(p.x - tx) + Math.abs(p.y - ty) < minDist) return false;
        }
        return true;
    }

    for (const town of towns) {
        for (const artistId of town.artists) {
            const bid = 'b_' + artistId;
            const bType = bldgTypeMap[artistId];
            const isDimX = bType === 'dimension_x';
            const extraSpace = isDimX ? 14 : 0;
            let placed = false;
            for (let r = 0; r <= town.radius + 10 && !placed; r++) {
                for (let dy = -r; dy <= r && !placed; dy++) {
                    for (let dx = -r; dx <= r && !placed; dx++) {
                        if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                        if (isValidSpot(town.x + dx, town.y + dy, extraSpace)) {
                            const entry = { buildingId: bid, x: town.x + dx, y: town.y + dy };
                            if (isDimX) entry.buildingType = 'dimension_x';
                            placements.push(entry);
                            // Occupy a larger footprint for dimension_x
                            if (isDimX) {
                                for (let ody = -3; ody <= 3; ody++) {
                                    for (let odx = -3; odx <= 3; odx++) {
                                        occupied.add((town.y + dy + ody) * W + (town.x + dx + odx));
                                    }
                                }
                            } else {
                                occupied.add((town.y + dy) * W + (town.x + dx));
                            }
                            placed = true;
                        }
                    }
                }
            }
            if (!placed) console.warn('    Could not place ' + bid + ' near ' + town.label);
        }
    }

    console.log('  Artist buildings placed: ' + placements.length);
    return { placements, occupied };
}

// ── Background buildings along highways and in towns ─────────

const KIND_FP = {
    mall: { w: 4, h: 2 }, warehouse: { w: 4, h: 2 }, gas_station: { w: 4, h: 2 },
    apt_tall: { w: 2, h: 2 }, apt_med: { w: 2, h: 2 }, apt_small: { w: 1, h: 1 },
    shop: { w: 2, h: 2 }, fastfood: { w: 2, h: 2 }, pizza: { w: 2, h: 2 }
};
const DEFAULT_FP = { w: 1, h: 1 };

function generateBgBuildings(towns, grid, roadSet, occupied, cfg) {
    const W = cfg.gridW, H = cfg.gridH;
    const bg = [];
    const townKinds = ['shop', 'office', 'fastfood', 'house', 'warehouse', 'apartment'];
    const hwKinds   = ['gas_station', 'motel', 'diner', 'rest_stop', 'truck_stop'];
    const zones     = ['commercial', 'residential', 'industrial'];

    const townCover = new Set();
    for (const t of towns) {
        const r = t.radius + 6;
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const nx = t.x + dx, ny = t.y + dy;
                if (nx >= 0 && nx < W && ny >= 0 && ny < H) townCover.add(ny * W + nx);
            }
        }
    }

    function footprintFits(tx, ty, kind) {
        const fp = KIND_FP[kind] || DEFAULT_FP;
        for (let fy = 0; fy < fp.h; fy++) {
            for (let fx = 0; fx < fp.w; fx++) {
                const cx = tx + fx, cy = ty - fy;
                if (cx < 0 || cx >= W || cy < 0 || cy >= H) return false;
                const ck = cy * W + cx;
                if (occupied.has(ck) || roadSet.has(ck)) return false;
                if (grid[cy][cx] < LAND) return false;
            }
        }
        return true;
    }

    function occupyFootprint(tx, ty, kind) {
        const fp = KIND_FP[kind] || DEFAULT_FP;
        for (let fy = 0; fy < fp.h; fy++) {
            for (let fx = 0; fx < fp.w; fx++) {
                occupied.add((ty - fy) * W + (tx + fx));
            }
        }
    }

    const checked = new Set();
    for (const rt of roadSet) {
        const rx = rt % W, ry = (rt / W) | 0;
        for (let dy = -3; dy <= 3; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
                const tx = rx + dx, ty = ry + dy;
                if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
                const k = ty * W + tx;
                if (checked.has(k)) continue;
                checked.add(k);
                if (occupied.has(k) || roadSet.has(k)) continue;
                if (grid[ty][tx] < LAND) continue;

                const dist = minRoadDist(tx, ty, roadSet, W);
                if (dist < ROAD_SETBACK || dist > ROAD_SETBACK + 1) continue;

                const h = ihash(tx, ty);
                const inTown = townCover.has(k);

                if (inTown) {
                    if (h % BG_DENSITY !== 0) continue;
                    const kind = townKinds[h % townKinds.length];
                    if (!footprintFits(tx, ty, kind)) continue;
                    bg.push({ x: tx, y: ty, kind: kind,
                              colorVariant: h % 4, zone: zones[(h >> 8) % zones.length],
                              facing: (h >> 4) % 2 === 0 ? 'e' : 'w', floors: 1 + (h % 3) });
                    occupyFootprint(tx, ty, kind);
                } else {
                    if (h % 12 !== 0) continue;
                    const kind = hwKinds[h % hwKinds.length];
                    if (!footprintFits(tx, ty, kind)) continue;
                    bg.push({ x: tx, y: ty, kind: kind,
                              colorVariant: h % 4, zone: 'commercial', facing: 'e', floors: 1 });
                    occupyFootprint(tx, ty, kind);
                }
            }
        }
    }

    console.log('  BG buildings: ' + bg.length);
    return bg;
}

// ── Landmarks ────────────────────────────────────────────────

function generateLandmarks(towns, cfg) {
    const landmarks = [];
    if (towns.length > 0) {
        landmarks.push({ id: 'lm_start', x: towns[0].x, y: towns[0].y, label: 'START', sprite: null });
    } else {
        landmarks.push({ id: 'lm_start', x: Math.floor(cfg.gridW / 2), y: Math.floor(cfg.gridH / 2), label: 'START', sprite: null });
    }
    for (const town of towns) {
        landmarks.push({ id: 'lm_blimp_' + town.id, x: town.x, y: town.y, label: town.label, sprite: null, type: 'blimp' });
    }
    console.log('  Landmarks: ' + landmarks.length);
    return landmarks;
}

// ── Districts ────────────────────────────────────────────────

function computeDistricts(towns, cfg) {
    if (towns.length === 0) return [{ id: 'default', x0: 0, x1: cfg.gridW - 1 }];
    const sorted = towns.slice().sort((a, b) => a.x - b.x);
    const districts = [];
    let prevX = 0;
    for (let i = 0; i < sorted.length; i++) {
        const nextX = (i < sorted.length - 1) ? Math.floor((sorted[i].x + sorted[i + 1].x) / 2) : cfg.gridW - 1;
        districts.push({ id: sorted[i].id, x0: prevX, x1: nextX });
        prevX = nextX + 1;
    }
    return districts;
}

// ── Generate a single region ─────────────────────────────────

function generateRegion(regionId, landFeatures, riverFeatures, roadFeatures, allArtists) {
    const cfg = REGIONS[regionId];
    if (!cfg) { console.error('Unknown region: ' + regionId); return; }

    console.log('\n=== Generating ' + cfg.label + ' (' + regionId + ') ===');
    console.log('  Grid: ' + cfg.gridW + 'x' + cfg.gridH + ' @ ' + cfg.tileSize + 'px');

    const regionArtists = allArtists.filter(a => a.regionId === regionId);
    console.log('  Artists: ' + regionArtists.length);

    const grid = rasterizeTerrain(cfg, landFeatures, riverFeatures);
    const towns = buildTowns(regionArtists, cfg, grid);
    const { roadTiles, roadSet, dirMap } = generateRoads(towns, grid, cfg, roadFeatures);
    const roadGraph = buildRoadGraph(roadTiles, roadSet, dirMap, cfg);
    const { placements, occupied } = placeArtistBuildings(towns, grid, roadSet, cfg);
    const bgBuildings = generateBgBuildings(towns, grid, roadSet, occupied, cfg);
    const landmarks = generateLandmarks(towns, cfg);
    const districts = computeDistricts(towns, cfg);

    const riverTiles = [];
    for (let ty = 0; ty < cfg.gridH; ty++) {
        for (let tx = 0; tx < cfg.gridW; tx++) {
            if (grid[ty][tx] === RIVER) riverTiles.push({ x: tx, y: ty });
        }
    }

    const output = {
        world: { widthTiles: cfg.gridW, heightTiles: cfg.gridH, tileSize: cfg.tileSize },
        terrainGrid: grid,
        roadTiles, roadGraph,
        towns: towns.map(t => ({
            id: t.id, x: t.x, y: t.y, label: t.label, pattern: t.pattern,
            radius: t.radius, tier: t.tier, artists: t.artists,
            mainStreetAxis: null, profile: t.profile, density: t.density
        })),
        buildingPlacements: placements,
        fillerBuildings: [],
        bgBuildings,
        townProps: [],
        river: riverTiles,
        districts,
        landmarks,
        levelEntrances: []
    };

    const outDir = path.join(DATA_DIR, 'regions');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, regionId + '.json');
    const json = JSON.stringify(output) + '\n';
    fs.writeFileSync(outPath, json);

    const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(0);
    console.log('  Output: ' + outPath + ' (' + sizeKB + ' KB)');
    console.log('  Placed: ' + placements.length + '/' + regionArtists.length + ' artists');

    let onRoad = 0;
    for (const p of placements) { if (roadSet.has(p.y * cfg.gridW + p.x)) onRoad++; }
    if (onRoad > 0) console.warn('  WARNING: ' + onRoad + ' buildings ON road!');

    if (regionId === 'na') fs.writeFileSync(path.join(DATA_DIR, 'map.json'), json);

    return { placed: placements.length, total: regionArtists.length };
}

// ── Main ─────────────────────────────────────────────────────

function main() {
    console.log('=== Region Generator (Natural Earth 10m Roads) ===');

    const { landFeatures, riverFeatures, roadFeatures } = loadNaturalEarth();
    const allArtists = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'artists.json'), 'utf8')).artists;

    const target = process.argv[2];
    const regionIds = target ? [target] : Object.keys(REGIONS);

    let totalPlaced = 0, totalExpected = 0;
    for (const rid of regionIds) {
        const result = generateRegion(rid, landFeatures, riverFeatures, roadFeatures, allArtists);
        if (result) { totalPlaced += result.placed; totalExpected += result.total; }
    }

    console.log('\n=== Summary ===');
    console.log('  Total artists placed: ' + totalPlaced + '/' + totalExpected);
    console.log('Done.');
}

main();
