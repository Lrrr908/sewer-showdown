// ═══════════════════════════════════════════════════════════════════════════════
// CAR AI MODULE - Smart enemy vehicle behavior
// ═══════════════════════════════════════════════════════════════════════════════
//
// A lightweight goal-oriented AI for enemy cars that:
//   • Patrols roads smoothly without jittering
//   • Chases players using actual pathfinding
//   • Makes smart decisions at intersections
//   • Handles getting stuck gracefully
//
// ═══════════════════════════════════════════════════════════════════════════════

var CarAI = (function() {
    'use strict';

    // ── Configuration ──────────────────────────────────────────────────────────
    var CONFIG = {
        PATROL_SPEED: 96,
        CHASE_SPEED: 144,
        DECISION_INTERVAL: 0.3,      // seconds between AI decisions
        // Stuck detection: measure total displacement over a window.
        // At 96 px/s, a freely-moving car travels ~96px in 1s — well above the 20px
        // threshold. Only genuinely immobile cars (wall-blocked, piled up) trigger it.
        STUCK_WINDOW: 1.0,           // seconds per displacement check
        STUCK_DISTANCE: 20,          // pixels — must move at least this far per window
        STUCK_RECOVERY_TIME: 0.25,   // seconds to hold new direction before re-evaluating
        REPATH_INTERVAL: 1.5,        // seconds between path recalculations in chase
        INTERSECTION_RADIUS: 1,      // tiles - how close to be "at" an intersection
        LOOKAHEAD_TILES: 3,          // how far ahead to check for turns
        MAX_PATH_LENGTH: 100,        // max nodes in a path
    };

    // ── State Constants ────────────────────────────────────────────────────────
    var STATE = {
        PATROL: 'patrol',
        CHASE: 'chase',
        INVESTIGATE: 'investigate',
        STUCK: 'stuck',
        IDLE: 'idle'
    };

    // ── Direction Helpers ──────────────────────────────────────────────────────
    var DIRS = ['right', 'left', 'down', 'up'];
    var DIR_DX = { right: 1, left: -1, down: 0, up: 0 };
    var DIR_DY = { right: 0, left: 0, down: 1, up: -1 };
    var OPPOSITE = { right: 'left', left: 'right', down: 'up', up: 'down' };

    // ── Road Grid Access (set by game.js) ──────────────────────────────────────
    var _roadGrid = null;
    var _roadGraph = null;
    var _worldWidth = 0;
    var _worldHeight = 0;
    var _tileSize = 32;

    function setRoadData(roadGrid, roadGraph, worldW, worldH, tileSize) {
        _roadGrid = roadGrid;
        _roadGraph = roadGraph;
        _worldWidth = worldW;
        _worldHeight = worldH;
        _tileSize = tileSize || 32;
    }

    // ── Utility Functions ──────────────────────────────────────────────────────

    function tileKey(tx, ty) {
        return ty * _worldWidth + tx;
    }

    function isRoad(tx, ty) {
        if (!_roadGrid || tx < 0 || tx >= _worldWidth || ty < 0 || ty >= _worldHeight) return false;
        return !!_roadGrid[tileKey(tx, ty)];
    }

    function pixelToTile(px, py, carW, carH) {
        return {
            tx: Math.floor((px + carW / 2) / _tileSize),
            ty: Math.floor((py + carH / 2) / _tileSize)
        };
    }

    function tileToPixel(tx, ty) {
        return { px: tx * _tileSize, py: ty * _tileSize };
    }

    function distance(x1, y1, x2, y2) {
        var dx = x2 - x1, dy = y2 - y1;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function manhattanDist(tx1, ty1, tx2, ty2) {
        return Math.abs(tx2 - tx1) + Math.abs(ty2 - ty1);
    }

    // Get available road directions from a tile
    function getRoadDirections(tx, ty) {
        var dirs = [];
        if (isRoad(tx + 1, ty)) dirs.push('right');
        if (isRoad(tx - 1, ty)) dirs.push('left');
        if (isRoad(tx, ty + 1)) dirs.push('down');
        if (isRoad(tx, ty - 1)) dirs.push('up');
        return dirs;
    }

    // Check if a tile is an intersection (3+ road neighbors) or corner (2 non-opposite)
    function isIntersection(tx, ty) {
        var dirs = getRoadDirections(tx, ty);
        if (dirs.length >= 3) return true;
        if (dirs.length === 2) {
            // Corner: two directions that aren't opposite
            return dirs[0] !== OPPOSITE[dirs[1]];
        }
        return false;
    }

    // Get the best direction toward a target tile
    function directionToward(fromTx, fromTy, toTx, toTy) {
        var dx = toTx - fromTx;
        var dy = toTy - fromTy;
        if (dx === 0 && dy === 0) return null;
        if (Math.abs(dx) >= Math.abs(dy)) {
            return dx > 0 ? 'right' : 'left';
        }
        return dy > 0 ? 'down' : 'up';
    }

    // ── Nearest road tile search ────────────────────────────────────────────────
    // Spiral outward from (tx, ty) to find the closest road tile.
    // Used when the chase target is off-road so the car has a concrete road goal
    // to pathfind toward rather than thrashing at the road edge.

    function findNearestRoadTile(tx, ty, maxRadius) {
        if (isRoad(tx, ty)) return { tx: tx, ty: ty };
        for (var r = 1; r <= maxRadius; r++) {
            for (var dx = -r; dx <= r; dx++) {
                for (var dy = -r; dy <= r; dy++) {
                    if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                    var cx = tx + dx, cy = ty + dy;
                    if (isRoad(cx, cy)) return { tx: cx, ty: cy };
                }
            }
        }
        return null;
    }

    // ── Pathfinding (A* on road tiles) ─────────────────────────────────────────

    function findPath(startTx, startTy, goalTx, goalTy) {
        if (!isRoad(startTx, startTy) || !isRoad(goalTx, goalTy)) return null;
        if (startTx === goalTx && startTy === goalTy) return [{ tx: startTx, ty: startTy }];

        var openSet = [{ tx: startTx, ty: startTy, g: 0, f: manhattanDist(startTx, startTy, goalTx, goalTy) }];
        var cameFrom = {};
        var gScore = {};
        gScore[tileKey(startTx, startTy)] = 0;

        var iterations = 0;
        var maxIter = 2000;

        while (openSet.length > 0 && iterations < maxIter) {
            iterations++;

            // Find node with lowest f
            var bestIdx = 0;
            for (var i = 1; i < openSet.length; i++) {
                if (openSet[i].f < openSet[bestIdx].f) bestIdx = i;
            }
            var current = openSet.splice(bestIdx, 1)[0];

            if (current.tx === goalTx && current.ty === goalTy) {
                // Reconstruct path
                var path = [{ tx: goalTx, ty: goalTy }];
                var key = tileKey(goalTx, goalTy);
                while (cameFrom[key]) {
                    var prev = cameFrom[key];
                    path.unshift({ tx: prev.tx, ty: prev.ty });
                    key = tileKey(prev.tx, prev.ty);
                }
                return path;
            }

            // Explore neighbors
            var neighbors = [
                { tx: current.tx + 1, ty: current.ty },
                { tx: current.tx - 1, ty: current.ty },
                { tx: current.tx, ty: current.ty + 1 },
                { tx: current.tx, ty: current.ty - 1 }
            ];

            for (var ni = 0; ni < neighbors.length; ni++) {
                var n = neighbors[ni];
                if (!isRoad(n.tx, n.ty)) continue;

                var tentG = current.g + 1;
                var nKey = tileKey(n.tx, n.ty);

                if (gScore[nKey] !== undefined && tentG >= gScore[nKey]) continue;

                gScore[nKey] = tentG;
                cameFrom[nKey] = { tx: current.tx, ty: current.ty };

                var f = tentG + manhattanDist(n.tx, n.ty, goalTx, goalTy);

                // Check if already in open set
                var inOpen = false;
                for (var oi = 0; oi < openSet.length; oi++) {
                    if (openSet[oi].tx === n.tx && openSet[oi].ty === n.ty) {
                        openSet[oi].g = tentG;
                        openSet[oi].f = f;
                        inOpen = true;
                        break;
                    }
                }
                if (!inOpen) {
                    openSet.push({ tx: n.tx, ty: n.ty, g: tentG, f: f });
                }
            }
        }

        return null; // No path found
    }

    // ── Car Brain ──────────────────────────────────────────────────────────────

    function createBrain() {
        return {
            state: STATE.PATROL,
            path: null,
            pathIndex: 0,
            targetTx: -1,
            targetTy: -1,
            decisionTimer: 0,
            stuckTimer: 0,          // time held in STUCK state (for recovery delay)
            stuckCheckTimer: 0,     // counts up to STUCK_WINDOW
            stuckRefX: null,        // position at start of check window
            stuckRefY: null,
            repathTimer: 0,
            patrolDir: null,        // preferred patrol direction
            lastIntersection: null, // last intersection we made a decision at
            turnCooldown: 0,        // prevent rapid direction changes
            holdPosition: false,    // true when waiting at road-edge for off-road target
            offRoadGoalTx: -1,      // cached nearest-road tile to off-road target
            offRoadGoalTy: -1,
        };
    }

    // ── Patrol Behavior ────────────────────────────────────────────────────────
    // Smooth patrol: pick a direction and stick with it until we hit an
    // intersection, then make a weighted random choice (prefer straight/right turns)

    function updatePatrol(car, brain, dt, rng) {
        var tile = pixelToTile(car.x, car.y, car.width || 64, car.height || 48);
        var dirs = getRoadDirections(tile.tx, tile.ty);

        brain.turnCooldown = Math.max(0, brain.turnCooldown - dt);

        // If no valid directions, we're off-road somehow
        if (dirs.length === 0) {
            brain.state = STATE.STUCK;
            return car.direction;
        }

        // Check if current direction is still valid
        var currentValid = dirs.indexOf(car.direction) >= 0;

        // At an intersection or corner?
        var atIntersection = isIntersection(tile.tx, tile.ty);
        var intersectionKey = tile.tx + ',' + tile.ty;

        // Only make a new decision at intersections we haven't just visited
        if (atIntersection && brain.lastIntersection !== intersectionKey && brain.turnCooldown <= 0) {
            brain.lastIntersection = intersectionKey;
            brain.turnCooldown = 0.5; // Don't decide again for 0.5s

            // Weight directions: prefer forward > right turn > left turn > reverse
            var forward = car.direction;
            var reverse = OPPOSITE[car.direction];
            var candidates = [];

            for (var i = 0; i < dirs.length; i++) {
                var d = dirs[i];
                var weight = 1;
                if (d === forward) weight = 5;      // strongly prefer straight
                else if (d === reverse) weight = 0.5; // avoid reversing
                else weight = 2;                     // turns are ok
                candidates.push({ dir: d, weight: weight });
            }

            // Weighted random selection — use seeded RNG for determinism across clients
            var totalWeight = 0;
            for (var j = 0; j < candidates.length; j++) totalWeight += candidates[j].weight;
            var roll = (rng ? rng() : Math.random()) * totalWeight;
            var cumulative = 0;
            for (var k = 0; k < candidates.length; k++) {
                cumulative += candidates[k].weight;
                if (roll <= cumulative) {
                    return candidates[k].dir;
                }
            }
            return candidates[candidates.length - 1].dir;
        }

        // Not at intersection: keep going if valid, otherwise pick any valid direction
        if (currentValid) {
            return car.direction;
        }

        // Current direction invalid - pick the best non-reverse option
        var reverse2 = OPPOSITE[car.direction];
        for (var m = 0; m < dirs.length; m++) {
            if (dirs[m] !== reverse2) return dirs[m];
        }
        return dirs[0]; // fallback to anything
    }

    // ── Chase Behavior ─────────────────────────────────────────────────────────
    // Use A* pathfinding to reach the player, recompute periodically

    function updateChase(car, brain, targetX, targetY, dt) {
        var carTile    = pixelToTile(car.x, car.y, car.width || 64, car.height || 48);
        var targetTile = pixelToTile(targetX, targetY, 32, 32);
        var targetOnRoad = isRoad(targetTile.tx, targetTile.ty);

        // ── Off-road target handling ──────────────────────────────────────────
        // When the player is off-road (building interior, water, terrain) A* has
        // no valid goal. Instead of thrashing at the road edge we:
        //   1. Find the nearest road tile to the player's position (≤6 tile spiral).
        //   2. Pathfind to that tile and stop there.
        //   3. Set holdPosition = true so the caller skips the movement step.
        //   4. Clear holdPosition the moment the player returns to road.
        if (!targetOnRoad) {
            brain.holdPosition = false; // default — set to true once we arrive

            // Recompute off-road goal if stale or missing
            brain.repathTimer -= dt;
            var needRepath = (brain.offRoadGoalTx < 0) || (brain.repathTimer <= 0);
            if (needRepath) {
                var nearest = findNearestRoadTile(targetTile.tx, targetTile.ty, 6);
                if (nearest) {
                    brain.offRoadGoalTx = nearest.tx;
                    brain.offRoadGoalTy = nearest.ty;
                } else {
                    // No road found at all — just hold
                    brain.holdPosition = true;
                    return car.direction;
                }
                brain.path = findPath(carTile.tx, carTile.ty, brain.offRoadGoalTx, brain.offRoadGoalTy);
                brain.pathIndex = 0;
                brain.repathTimer = CONFIG.REPATH_INTERVAL;
            }

            // Already at the wait tile — hold position
            if (carTile.tx === brain.offRoadGoalTx && carTile.ty === brain.offRoadGoalTy) {
                brain.holdPosition = true;
                return car.direction;
            }
            // Also hold if there's simply no path to the wait tile
            if (!brain.path) {
                brain.holdPosition = true;
                return car.direction;
            }
            // Otherwise follow path to wait tile (fall through to path-follow below)
        } else {
            // Target back on road — clear off-road state
            brain.holdPosition = false;
            brain.offRoadGoalTx = -1;
            brain.offRoadGoalTy = -1;

            // Normal repath toward the (on-road) target
            brain.repathTimer -= dt;
            if (!brain.path || brain.repathTimer <= 0 || brain.pathIndex >= brain.path.length - 1) {
                brain.path = findPath(carTile.tx, carTile.ty, targetTile.tx, targetTile.ty);
                brain.pathIndex = 0;
                brain.repathTimer = CONFIG.REPATH_INTERVAL;
            }

            if (!brain.path) {
                // A* failed even though both tiles are road — unlikely, but fall back
                // to the road direction that minimises distance to target.
                var dirs = getRoadDirections(carTile.tx, carTile.ty);
                var bestDir = car.direction;
                var bestDist = Infinity;
                for (var i = 0; i < dirs.length; i++) {
                    var ntx = carTile.tx + DIR_DX[dirs[i]];
                    var nty = carTile.ty + DIR_DY[dirs[i]];
                    var d = manhattanDist(ntx, nty, targetTile.tx, targetTile.ty);
                    if (d < bestDist) { bestDist = d; bestDir = dirs[i]; }
                }
                return bestDir;
            }
        }

        // ── Follow the computed path ──────────────────────────────────────────
        if (brain.path && brain.path.length > 0) {
            while (brain.pathIndex < brain.path.length - 1) {
                var wp = brain.path[brain.pathIndex];
                if (Math.abs(carTile.tx - wp.tx) <= 1 && Math.abs(carTile.ty - wp.ty) <= 1) {
                    brain.pathIndex++;
                } else {
                    break;
                }
            }

            var nextWp = brain.path[Math.min(brain.pathIndex, brain.path.length - 1)];
            var dir = directionToward(carTile.tx, carTile.ty, nextWp.tx, nextWp.ty);
            if (dir && isRoad(carTile.tx + DIR_DX[dir], carTile.ty + DIR_DY[dir])) {
                return dir;
            }

            if (brain.pathIndex < brain.path.length - 1) {
                var nextWp2 = brain.path[brain.pathIndex + 1];
                var dir2 = directionToward(carTile.tx, carTile.ty, nextWp2.tx, nextWp2.ty);
                if (dir2 && isRoad(carTile.tx + DIR_DX[dir2], carTile.ty + DIR_DY[dir2])) {
                    brain.pathIndex++;
                    return dir2;
                }
            }
        }

        return car.direction;
    }

    // ── Stuck Recovery ─────────────────────────────────────────────────────────

    function updateStuck(car, brain, dt, rng) {
        brain.stuckTimer += dt;

        // Brief hold before picking a recovery direction.
        // This prevents instant oscillation where we flip direction, immediately
        // re-enter stuck, flip again, and produce the left-right spaz effect.
        if (brain.stuckTimer < CONFIG.STUCK_RECOVERY_TIME) return car.direction;

        var tile = pixelToTile(car.x, car.y, car.width || 64, car.height || 48);
        var dirs = getRoadDirections(tile.tx, tile.ty);

        if (dirs.length > 0) {
            var opp = OPPOSITE[car.direction];
            // Prefer directions that are neither current nor reverse — helps with
            // dead-end corners where the only escape is a perpendicular road.
            var preferred = dirs.filter(function(d) { return d !== car.direction && d !== opp; });
            var options = preferred.length > 0
                ? preferred
                : dirs.filter(function(d) { return d !== car.direction; });
            if (options.length === 0) options = dirs; // true dead-end: must reverse

            var chosen = options[Math.floor((rng ? rng() : Math.random()) * options.length)];
            brain.state = STATE.PATROL;
            brain.stuckTimer = 0;
            brain.stuckCheckTimer = 0;
            brain.stuckRefX = car.x;
            brain.stuckRefY = car.y;
            brain.lastIntersection = null; // force a fresh decision at next intersection
            brain.turnCooldown = 0.4;      // commit to new direction briefly
            return chosen;
        }

        // Off-road entirely — wait up to 2 s then try any direction
        if (brain.stuckTimer > 2.0) {
            brain.state = STATE.PATROL;
            brain.stuckTimer = 0;
            return DIRS[Math.floor((rng ? rng() : Math.random()) * 4)];
        }

        return car.direction;
    }

    // ── Main Update Function ───────────────────────────────────────────────────

    function update(car, brain, dt, targetX, targetY, detectRadius, isChasing, rng) {
        if (!_roadGrid) return car.direction;

        // Use the car's own seeded RNG if none provided — this keeps direction
        // decisions deterministic across all clients (same enemy = same turns).
        var _rng = rng || car._rng || null;

        // ── Windowed stuck detection ──────────────────────────────────────────
        // Measure total displacement over STUCK_WINDOW seconds. A freely-moving
        // patrol car covers ~96px/s — far above the 20px threshold. Only cars
        // genuinely blocked by walls or pileups will fail the check.
        if (brain.stuckRefX === null) { brain.stuckRefX = car.x; brain.stuckRefY = car.y; }
        brain.stuckCheckTimer += dt;
        if (brain.stuckCheckTimer >= CONFIG.STUCK_WINDOW) {
            var windowMoved = distance(car.x, car.y, brain.stuckRefX, brain.stuckRefY);
            brain.stuckRefX = car.x;
            brain.stuckRefY = car.y;
            brain.stuckCheckTimer -= CONFIG.STUCK_WINDOW;
            if (windowMoved < CONFIG.STUCK_DISTANCE && brain.state !== STATE.STUCK) {
                brain.state = STATE.STUCK;
                brain.stuckTimer = 0;
            }
        }

        // State transitions
        if (brain.state !== STATE.STUCK) {
            var distToTarget = distance(
                car.x + (car.width || 64) / 2,
                car.y + (car.height || 48) / 2,
                targetX, targetY
            );

            if (isChasing || distToTarget < detectRadius) {
                if (brain.state !== STATE.CHASE) {
                    brain.state = STATE.CHASE;
                    brain.path = null;
                    brain.repathTimer = 0;
                    brain.holdPosition = false;
                    brain.offRoadGoalTx = -1;
                    brain.offRoadGoalTy = -1;
                }
            } else if (brain.state === STATE.CHASE && distToTarget > detectRadius * 1.5) {
                brain.state = STATE.PATROL;
                brain.path = null;
                brain.holdPosition = false;
                brain.offRoadGoalTx = -1;
                brain.offRoadGoalTy = -1;
            }
        }

        // Run state behavior
        var newDir;
        switch (brain.state) {
            case STATE.PATROL:
                newDir = updatePatrol(car, brain, dt, _rng);
                break;
            case STATE.CHASE:
                newDir = updateChase(car, brain, targetX, targetY, dt);
                break;
            case STATE.STUCK:
                newDir = updateStuck(car, brain, dt, _rng);
                break;
            default:
                newDir = car.direction;
        }

        return newDir || car.direction;
    }

    // ── Get Speed Based on State ───────────────────────────────────────────────

    function getSpeed(brain) {
        if (brain.state === STATE.CHASE) {
            return CONFIG.CHASE_SPEED;
        }
        return CONFIG.PATROL_SPEED;
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    return {
        CONFIG: CONFIG,
        STATE: STATE,
        setRoadData: setRoadData,
        createBrain: createBrain,
        update: update,
        getSpeed: getSpeed,
        findPath: findPath,
        isRoad: isRoad,
        getRoadDirections: getRoadDirections,
        isIntersection: isIntersection,
        directionToward: directionToward
    };

})();

// Export for Node.js (if used server-side)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CarAI;
}
