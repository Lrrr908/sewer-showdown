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
        STUCK_THRESHOLD: 0.5,        // seconds without movement = stuck
        STUCK_DISTANCE: 4,           // pixels - if moved less than this, considered stuck
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
            stuckTimer: 0,
            lastX: 0,
            lastY: 0,
            repathTimer: 0,
            patrolDir: null,        // preferred patrol direction
            lastIntersection: null, // last intersection we made a decision at
            turnCooldown: 0,        // prevent rapid direction changes
        };
    }

    // ── Patrol Behavior ────────────────────────────────────────────────────────
    // Smooth patrol: pick a direction and stick with it until we hit an
    // intersection, then make a weighted random choice (prefer straight/right turns)

    function updatePatrol(car, brain, dt) {
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

            // Weighted random selection
            var totalWeight = 0;
            for (var j = 0; j < candidates.length; j++) totalWeight += candidates[j].weight;
            var roll = Math.random() * totalWeight;
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
        var carTile = pixelToTile(car.x, car.y, car.width || 64, car.height || 48);
        var targetTile = pixelToTile(targetX, targetY, 32, 32);

        brain.repathTimer -= dt;

        // Recompute path if needed
        if (!brain.path || brain.repathTimer <= 0 || brain.pathIndex >= brain.path.length - 1) {
            brain.path = findPath(carTile.tx, carTile.ty, targetTile.tx, targetTile.ty);
            brain.pathIndex = 0;
            brain.repathTimer = CONFIG.REPATH_INTERVAL;

            if (!brain.path) {
                // No path - fall back to simple direction toward target
                var simpleDir = directionToward(carTile.tx, carTile.ty, targetTile.tx, targetTile.ty);
                if (simpleDir && isRoad(carTile.tx + DIR_DX[simpleDir], carTile.ty + DIR_DY[simpleDir])) {
                    return simpleDir;
                }
                // Try any direction toward target
                var dirs = getRoadDirections(carTile.tx, carTile.ty);
                var bestDir = car.direction;
                var bestDist = Infinity;
                for (var i = 0; i < dirs.length; i++) {
                    var ntx = carTile.tx + DIR_DX[dirs[i]];
                    var nty = carTile.ty + DIR_DY[dirs[i]];
                    var d = manhattanDist(ntx, nty, targetTile.tx, targetTile.ty);
                    if (d < bestDist) {
                        bestDist = d;
                        bestDir = dirs[i];
                    }
                }
                return bestDir;
            }
        }

        // Follow path
        if (brain.path && brain.path.length > 0) {
            // Advance path index if we've reached current waypoint
            while (brain.pathIndex < brain.path.length - 1) {
                var wp = brain.path[brain.pathIndex];
                if (Math.abs(carTile.tx - wp.tx) <= 1 && Math.abs(carTile.ty - wp.ty) <= 1) {
                    brain.pathIndex++;
                } else {
                    break;
                }
            }

            // Get direction to next waypoint
            var nextWp = brain.path[Math.min(brain.pathIndex, brain.path.length - 1)];
            var dir = directionToward(carTile.tx, carTile.ty, nextWp.tx, nextWp.ty);

            if (dir && isRoad(carTile.tx + DIR_DX[dir], carTile.ty + DIR_DY[dir])) {
                return dir;
            }

            // Path direction not valid - try next waypoint
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

    function updateStuck(car, brain, dt) {
        brain.stuckTimer += dt;

        // Try to find any valid direction
        var tile = pixelToTile(car.x, car.y, car.width || 64, car.height || 48);
        var dirs = getRoadDirections(tile.tx, tile.ty);

        if (dirs.length > 0) {
            // Pick a random direction that isn't our current one
            var options = dirs.filter(function(d) { return d !== car.direction; });
            if (options.length > 0) {
                brain.state = STATE.PATROL;
                brain.stuckTimer = 0;
                return options[Math.floor(Math.random() * options.length)];
            }
            // Only option is current direction
            brain.state = STATE.PATROL;
            brain.stuckTimer = 0;
            return dirs[0];
        }

        // Still stuck after 3 seconds - just pick any direction
        if (brain.stuckTimer > 3) {
            brain.state = STATE.PATROL;
            brain.stuckTimer = 0;
            return DIRS[Math.floor(Math.random() * 4)];
        }

        return car.direction;
    }

    // ── Main Update Function ───────────────────────────────────────────────────

    function update(car, brain, dt, targetX, targetY, detectRadius, isChasing) {
        if (!_roadGrid) return car.direction;

        // Check if stuck (hasn't moved much)
        var moved = distance(car.x, car.y, brain.lastX, brain.lastY);
        if (moved < CONFIG.STUCK_DISTANCE * dt * 60) {
            brain.stuckTimer += dt;
            if (brain.stuckTimer > CONFIG.STUCK_THRESHOLD && brain.state !== STATE.STUCK) {
                brain.state = STATE.STUCK;
            }
        } else {
            brain.stuckTimer = 0;
            brain.lastX = car.x;
            brain.lastY = car.y;
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
                }
            } else if (brain.state === STATE.CHASE && distToTarget > detectRadius * 1.5) {
                brain.state = STATE.PATROL;
                brain.path = null;
            }
        }

        // Run state behavior
        var newDir;
        switch (brain.state) {
            case STATE.PATROL:
                newDir = updatePatrol(car, brain, dt);
                break;
            case STATE.CHASE:
                newDir = updateChase(car, brain, targetX, targetY, dt);
                break;
            case STATE.STUCK:
                newDir = updateStuck(car, brain, dt);
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
