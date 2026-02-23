#!/usr/bin/env node
// tools/gen_level.js
// Deterministic procedural level generator for Sewer Showdown.
// Inputs: --theme sewer|street|dock  --size S|M|L  --seed <string>
//         [--difficulty 1-5] [--out <path>]
// All randomness is seeded. No Math.random().

'use strict';

const fs = require('fs');
const path = require('path');

// ── Seeded PRNG (mulberry32) ────────────────────────────────────
function seedHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return h >>> 0;
}

function mulberry32(seed) {
    let s = seed | 0;
    return function() {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── Theme definitions ───────────────────────────────────────────
const THEMES = {
    sewer: {
        name: 'Sewer',
        wallTile: 1,
        floorTile: 0,
        obstacleChance: 0.08,
        corridorWidth: 3,
        roomMin: 4, roomMax: 8
    },
    street: {
        name: 'Street Fight',
        wallTile: 1,
        floorTile: 0,
        obstacleChance: 0.04,
        corridorWidth: 5,
        roomMin: 6, roomMax: 12
    },
    dock: {
        name: 'Dock',
        wallTile: 1,
        floorTile: 0,
        obstacleChance: 0.10,
        corridorWidth: 3,
        roomMin: 5, roomMax: 9
    },
    gallery: {
        name: 'Gallery',
        wallTile: 1,
        floorTile: 0,
        obstacleChance: 0.03,
        corridorWidth: 5,
        roomMin: 6, roomMax: 10
    }
};

const SIZES = {
    S: { w: 24, h: 12 },
    M: { w: 36, h: 15 },
    L: { w: 48, h: 18 }
};

// Budget-based difficulty: budget = base + diffMod + sizeMod
// Enemy types spend from budget (foot=10). HP scales with tier.
const DIFF_BASE = 30;
const DIFF_MOD  = { 1: 0, 2: 10, 3: 20, 4: 30, 5: 40 };
const SIZE_MOD  = { S: 0, M: 15, L: 30 };
const ENEMY_COST = { foot: 10, foot_ranged: 15, foot_shield: 18, foot_runner: 8 };
const DIFF_HP   = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3 };
const RANGED_MIN_DIFF = 3;
const SHIELD_MIN_DIFF = 3;
const RUNNER_MIN_DIFF = 2;

const THEME_HAZARD_NAMES = { sewer: 'sludge', street: 'cone', dock: 'oil', gallery: 'paint' };

// ── Level generation ────────────────────────────────────────────

function generateLevel(theme, size, seed, difficulty) {
    const T = THEMES[theme];
    const S = SIZES[size];
    if (!T) throw new Error('Unknown theme: ' + theme);
    if (!S) throw new Error('Unknown size: ' + size);
    const diff = Math.max(1, Math.min(5, difficulty || 2));
    const budget = DIFF_BASE + (DIFF_MOD[diff] || 0) + (SIZE_MOD[size] || 0);
    const enemyHp = DIFF_HP[diff] || 1;

    const rng = mulberry32(seedHash(seed));
    const W = S.w, H = S.h;

    // Start with all walls
    const map = [];
    for (let y = 0; y < H; y++) {
        map[y] = new Array(W).fill(T.wallTile);
    }

    // ── Carve rooms ─────────────────────────────────────────────
    const rooms = [];
    const numRooms = 3 + Math.floor(rng() * 3);

    for (let attempt = 0; attempt < numRooms * 10 && rooms.length < numRooms; attempt++) {
        const rw = T.roomMin + Math.floor(rng() * (T.roomMax - T.roomMin));
        const rh = T.roomMin + Math.floor(rng() * (T.roomMax - T.roomMin));
        const rx = 2 + Math.floor(rng() * (W - rw - 4));
        const ry = 2 + Math.floor(rng() * (H - rh - 4));

        // Check overlap with existing rooms (1-tile margin)
        let overlaps = false;
        for (const r of rooms) {
            if (rx - 1 < r.x + r.w && rx + rw + 1 > r.x && ry - 1 < r.y + r.h && ry + rh + 1 > r.y) {
                overlaps = true;
                break;
            }
        }
        if (overlaps) continue;

        rooms.push({ x: rx, y: ry, w: rw, h: rh });
        for (let dy = 0; dy < rh; dy++) {
            for (let dx = 0; dx < rw; dx++) {
                map[ry + dy][rx + dx] = T.floorTile;
            }
        }
    }

    if (rooms.length < 2) {
        // Fallback: carve a big horizontal corridor
        rooms.push({ x: 2, y: Math.floor(H / 2) - 2, w: W - 4, h: 4 });
        for (let dy = 0; dy < 4; dy++) {
            for (let dx = 2; dx < W - 2; dx++) {
                map[Math.floor(H / 2) - 2 + dy][dx] = T.floorTile;
            }
        }
    }

    // ── Connect rooms with corridors ────────────────────────────
    // Sort rooms left-to-right, then connect sequentially
    rooms.sort((a, b) => a.x - b.x);

    for (let i = 0; i < rooms.length - 1; i++) {
        const r1 = rooms[i], r2 = rooms[i + 1];
        const cx1 = Math.floor(r1.x + r1.w / 2);
        const cy1 = Math.floor(r1.y + r1.h / 2);
        const cx2 = Math.floor(r2.x + r2.w / 2);
        const cy2 = Math.floor(r2.y + r2.h / 2);
        const hw = Math.floor(T.corridorWidth / 2);

        // Horizontal segment
        const xMin = Math.min(cx1, cx2), xMax = Math.max(cx1, cx2);
        for (let x = xMin; x <= xMax; x++) {
            for (let dy = -hw; dy <= hw; dy++) {
                const yy = cy1 + dy;
                if (yy >= 1 && yy < H - 1 && x >= 1 && x < W - 1) map[yy][x] = T.floorTile;
            }
        }
        // Vertical segment
        const yMin = Math.min(cy1, cy2), yMax = Math.max(cy1, cy2);
        for (let y = yMin; y <= yMax; y++) {
            for (let dx = -hw; dx <= hw; dx++) {
                const xx = cx2 + dx;
                if (y >= 1 && y < H - 1 && xx >= 1 && xx < W - 1) map[y][xx] = T.floorTile;
            }
        }
    }

    // ── Spawn + exit placement ──────────────────────────────────
    const firstRoom = rooms[0];
    const lastRoom = rooms[rooms.length - 1];
    const spawn = {
        x: firstRoom.x + 1 + Math.floor(rng() * Math.max(1, firstRoom.w - 2)),
        y: firstRoom.y + 1 + Math.floor(rng() * Math.max(1, firstRoom.h - 2))
    };
    const exit = {
        x: lastRoom.x + 1 + Math.floor(rng() * Math.max(1, lastRoom.w - 2)),
        y: lastRoom.y + 1 + Math.floor(rng() * Math.max(1, lastRoom.h - 2))
    };

    // Ensure spawn and exit are walkable
    map[spawn.y][spawn.x] = T.floorTile;
    map[exit.y][exit.x] = T.floorTile;

    // ── Scatter obstacles (with connectivity preservation) ───────
    // Collect obstacle candidates, place them, then verify
    const obstacleTiles = [];
    for (let y = 2; y < H - 2; y++) {
        for (let x = 2; x < W - 2; x++) {
            if (map[y][x] !== T.floorTile) continue;
            if (x === spawn.x && y === spawn.y) continue;
            if (x === exit.x && y === exit.y) continue;
            if (rng() < T.obstacleChance) {
                obstacleTiles.push({ x, y });
            }
        }
    }
    // Place obstacles
    for (const ot of obstacleTiles) map[ot.y][ot.x] = T.wallTile;

    // ── Flood-fill connectivity check (repair if broken) ────────
    function floodFill() {
        const vis = new Set();
        const q = [spawn.y * W + spawn.x];
        vis.add(q[0]);
        while (q.length > 0) {
            const k = q.shift();
            const kx = k % W, ky = (k / W) | 0;
            for (const [ddx, ddy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                const nx = kx + ddx, ny = ky + ddy;
                if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                const nk = ny * W + nx;
                if (vis.has(nk)) continue;
                if (map[ny][nx] === T.floorTile) { vis.add(nk); q.push(nk); }
            }
        }
        return vis;
    }

    let visited = floodFill();
    let exitKey = exit.y * W + exit.x;

    // If exit unreachable, remove obstacles until connected
    if (!visited.has(exitKey)) {
        for (let oi = obstacleTiles.length - 1; oi >= 0; oi--) {
            const ot = obstacleTiles[oi];
            map[ot.y][ot.x] = T.floorTile;
            visited = floodFill();
            if (visited.has(exitKey)) break;
        }
    }

    if (!visited.has(exitKey)) {
        console.error('FATAL: spawn and exit not connected after repair! seed=' + seed);
        process.exit(1);
    }

    // ── Ensure min 2-tile corridor width on shortest path (M/L) ─
    if (size === 'M' || size === 'L') {
        // BFS shortest path from spawn to exit
        const prev = new Map();
        const bfsQ = [spawn.y * W + spawn.x];
        prev.set(bfsQ[0], -1);
        while (bfsQ.length > 0) {
            const k = bfsQ.shift();
            if (k === exitKey) break;
            const kx = k % W, ky = (k / W) | 0;
            for (const [ddx, ddy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                const nx = kx + ddx, ny = ky + ddy;
                if (nx < 1 || nx >= W - 1 || ny < 1 || ny >= H - 1) continue;
                const nk = ny * W + nx;
                if (prev.has(nk)) continue;
                if (map[ny][nx] !== T.floorTile) continue;
                prev.set(nk, k);
                bfsQ.push(nk);
            }
        }
        // Walk path, widen to 2 tiles in perpendicular direction
        if (prev.has(exitKey)) {
            let cur = exitKey;
            while (cur !== -1) {
                const cx = cur % W, cy = (cur / W) | 0;
                for (const [ddx, ddy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                    const nx = cx + ddx, ny = cy + ddy;
                    if (nx >= 1 && nx < W - 1 && ny >= 1 && ny < H - 1) {
                        if (map[ny][nx] === T.wallTile) map[ny][nx] = T.floorTile;
                    }
                }
                cur = prev.get(cur);
            }
        }
        // Rebuild visited set after widening
        visited = floodFill();
    }

    // ── Place enemies on reachable walkable tiles ───────────────
    const walkable = [];
    for (const k of visited) {
        const kx = k % W, ky = (k / W) | 0;
        if (kx === spawn.x && ky === spawn.y) continue;
        if (kx === exit.x && ky === exit.y) continue;
        // Not too close to spawn
        if (Math.abs(kx - spawn.x) + Math.abs(ky - spawn.y) < 4) continue;
        walkable.push({ x: kx, y: ky });
    }

    // Shuffle walkable deterministically
    for (let i = walkable.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = walkable[i]; walkable[i] = walkable[j]; walkable[j] = tmp;
    }

    // ── Place hazard tiles (tile type 2) ───────────────────────
    const hazardCount = Math.floor(walkable.length * 0.06);
    const hazardStart = walkable.length - hazardCount;
    for (let hi = hazardStart; hi < walkable.length; hi++) {
        const hp = walkable[hi];
        if (Math.abs(hp.x - spawn.x) + Math.abs(hp.y - spawn.y) < 5) continue;
        if (Math.abs(hp.x - exit.x) + Math.abs(hp.y - exit.y) < 3) continue;
        map[hp.y][hp.x] = 2;
    }

    const enemies = [];
    let spent = 0;
    for (let i = 0; i < hazardStart && spent + ENEMY_COST.foot_runner <= budget; i++) {
        const pos = walkable[i];
        let pLeft = pos.x, pRight = pos.x;
        while (pLeft > 1 && map[pos.y][pLeft - 1] !== 1) pLeft--;
        while (pRight < W - 2 && map[pos.y][pRight + 1] !== 1) pRight++;
        pLeft = Math.max(pLeft, pos.x - 6);
        pRight = Math.min(pRight, pos.x + 6);

        const roll = rng();
        let eType = 'foot';
        if (diff >= SHIELD_MIN_DIFF && roll < 0.15 && spent + ENEMY_COST.foot_shield <= budget) {
            eType = 'foot_shield';
        } else if (diff >= RANGED_MIN_DIFF && roll < 0.4 && spent + ENEMY_COST.foot_ranged <= budget) {
            eType = 'foot_ranged';
        } else if (diff >= RUNNER_MIN_DIFF && roll < 0.55 && spent + ENEMY_COST.foot_runner <= budget) {
            eType = 'foot_runner';
        }
        let eHp = enemyHp;
        if (eType === 'foot_shield') eHp = enemyHp + 1;
        if (eType === 'foot_runner') eHp = Math.max(1, enemyHp - 1);

        enemies.push({
            type: eType,
            x: pos.x,
            y: pos.y,
            hp: eHp,
            patrol: { left: pLeft, right: pRight }
        });
        spent += ENEMY_COST[eType];
    }

    // ── Art frame positions for gallery theme ─────────────────
    const artFrames = [];
    if (theme === 'gallery') {
        for (let fy = 1; fy < H - 1; fy++) {
            for (let fx = 1; fx < W - 1; fx++) {
                if (map[fy][fx] !== T.floorTile) continue;
                if (map[fy - 1] && map[fy - 1][fx] === T.wallTile && rng() < 0.35) {
                    artFrames.push({ x: fx, y: fy, side: 'north' });
                }
            }
        }
    }

    // ── Special item spawn point ────────────────────────────────
    let itemSpawn = null;
    if (walkable.length > 6) {
        const mid = Math.min(walkable.length - 1, Math.floor(walkable.length * 0.6 + rng() * walkable.length * 0.3));
        itemSpawn = { x: walkable[mid].x, y: walkable[mid].y };
    }

    // ── Build output ────────────────────────────────────────────
    const levelName = T.name + ' (' + size + ')';
    const levelId = theme + '_' + seed.replace(/[^a-zA-Z0-9]/g, '_');

    return {
        id: levelId,
        name: levelName,
        theme: theme,
        seed: seed,
        world: { widthTiles: W, heightTiles: H, tileSize: 32 },
        tilemap: map,
        tileTypes: {
            '0': { name: 'air', solid: false },
            '1': { name: 'wall', solid: true },
            '2': { name: 'hazard', solid: false }
        },
        spawns: { player: spawn, exit: exit },
        enemies: enemies,
        triggers: [{ type: 'door', x: exit.x, y: exit.y, target: 'REGION' }],
        artFrames: artFrames,
        itemSpawn: itemSpawn
    };
}

// ── CLI ─────────────────────────────────────────────────────────

function main() {
    const args = process.argv.slice(2);
    function getArg(name, def) {
        const i = args.indexOf('--' + name);
        return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
    }

    const theme = getArg('theme', 'sewer');
    const size = getArg('size', 'M');
    const seed = getArg('seed', 'test_seed_01');
    const difficulty = parseInt(getArg('difficulty', '2'));
    const outPath = getArg('out', null);

    console.log('=== Level Generator ===');
    console.log('  Theme: ' + theme + '  Size: ' + size + '  Seed: ' + seed + '  Difficulty: ' + difficulty);

    const level = generateLevel(theme, size, seed, difficulty);

    console.log('  Result: ' + level.world.widthTiles + 'x' + level.world.heightTiles);
    console.log('  Rooms connected: spawn (' + level.spawns.player.x + ',' + level.spawns.player.y + ') -> exit (' + level.spawns.exit.x + ',' + level.spawns.exit.y + ')');
    console.log('  Enemies: ' + level.enemies.length);

    // ASCII preview
    for (let y = 0; y < level.world.heightTiles; y++) {
        let row = '';
        for (let x = 0; x < level.world.widthTiles; x++) {
            if (x === level.spawns.player.x && y === level.spawns.player.y) row += 'S';
            else if (x === level.spawns.exit.x && y === level.spawns.exit.y) row += 'E';
            else if (level.enemies.some(e => e.x === x && e.y === y)) row += 'X';
            else if (level.tilemap[y][x] === 1) row += '#';
            else row += '.';
        }
        console.log('  ' + row);
    }

    const json = JSON.stringify(level, null, 2) + '\n';

    if (outPath) {
        const dir = path.dirname(outPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(outPath, json);
        console.log('  Written: ' + outPath + ' (' + (Buffer.byteLength(json) / 1024).toFixed(1) + ' KB)');
    } else {
        const defaultOut = path.join(__dirname, '..', 'data', 'levels', level.id + '.json');
        const dir = path.dirname(defaultOut);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(defaultOut, json);
        console.log('  Written: ' + defaultOut + ' (' + (Buffer.byteLength(json) / 1024).toFixed(1) + ' KB)');
    }

    console.log('Done.');
}

// Export for runtime use
if (typeof module !== 'undefined') {
    module.exports = { generateLevel, seedHash, mulberry32 };
}

main();
