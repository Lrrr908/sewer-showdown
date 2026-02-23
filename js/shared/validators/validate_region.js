// js/shared/validators/validate_region.js
// Input: {version?, terrainGrid, roadTiles, bgBuildings, ...}
// Returns: errors[] with stable REG_* codes and JSON Pointer paths

if (typeof err === 'undefined' && typeof require !== 'undefined') {
    var _e = require('../errors'), SEVERITY = _e.SEVERITY, err = _e.err;
}

function validate_region(file) {
    var errors = [];
    if (!file || typeof file !== 'object') {
        errors.push(err('REG_NOT_OBJECT', SEVERITY.error, '', 'region file must be an object'));
        return errors;
    }
    if (file.version != null && (typeof file.version !== 'number' || file.version !== Math.floor(file.version))) {
        errors.push(err('REG_VERSION_INVALID', SEVERITY.error, '/version', 'version must be an integer'));
    }

    if (!Array.isArray(file.terrainGrid)) {
        errors.push(err('REG_TERRAIN_MISSING', SEVERITY.error, '/terrainGrid', 'terrainGrid must be an array'));
        return errors;
    }
    var mapH = file.terrainGrid.length;
    if (mapH === 0) {
        errors.push(err('REG_TERRAIN_EMPTY', SEVERITY.error, '/terrainGrid', 'terrainGrid must not be empty'));
        return errors;
    }
    var mapW = Array.isArray(file.terrainGrid[0]) ? file.terrainGrid[0].length : 0;
    for (var r = 0; r < mapH; r++) {
        if (!Array.isArray(file.terrainGrid[r])) {
            errors.push(err('REG_TERRAIN_ROW', SEVERITY.error, '/terrainGrid/' + r, 'row must be an array'));
        } else if (file.terrainGrid[r].length !== mapW) {
            errors.push(err('REG_TERRAIN_JAGGED', SEVERITY.error, '/terrainGrid/' + r, 'row length mismatch: expected ' + mapW + ', got ' + file.terrainGrid[r].length));
        }
    }

    if (file.roadTiles != null) {
        if (!Array.isArray(file.roadTiles)) {
            errors.push(err('REG_ROADS_NOT_ARRAY', SEVERITY.error, '/roadTiles', 'roadTiles must be an array'));
        } else {
            for (var i = 0; i < file.roadTiles.length; i++) {
                var rt = file.roadTiles[i];
                if (!rt || typeof rt !== 'object' || typeof rt.x !== 'number' || typeof rt.y !== 'number') {
                    errors.push(err('REG_ROAD_INVALID', SEVERITY.error, '/roadTiles/' + i, 'road tile must have numeric x and y'));
                } else if (rt.x < 0 || rt.y < 0 || rt.x >= mapW || rt.y >= mapH) {
                    errors.push(err('REG_ROAD_OOB', SEVERITY.warn, '/roadTiles/' + i, 'road tile out of bounds'));
                }
            }
        }
    }

    if (file.bgBuildings != null) {
        if (!Array.isArray(file.bgBuildings)) {
            errors.push(err('REG_BUILDINGS_NOT_ARRAY', SEVERITY.error, '/bgBuildings', 'bgBuildings must be an array'));
        } else {
            for (var b = 0; b < file.bgBuildings.length; b++) {
                var bg = file.bgBuildings[b];
                var bptr = '/bgBuildings/' + b;
                if (!bg || typeof bg !== 'object') {
                    errors.push(err('REG_BG_NOT_OBJECT', SEVERITY.error, bptr, 'bgBuilding must be an object'));
                    continue;
                }
                if (typeof bg.x !== 'number' || typeof bg.y !== 'number') {
                    errors.push(err('REG_BG_POS_INVALID', SEVERITY.error, bptr, 'bgBuilding must have numeric x and y'));
                }
                if (bg.x != null && bg.y != null) {
                    var landType = null;
                    if (bg.y >= 0 && bg.y < mapH && bg.x >= 0 && bg.x < mapW && Array.isArray(file.terrainGrid[bg.y])) {
                        landType = file.terrainGrid[bg.y][bg.x];
                    }
                    if (landType !== null && landType !== 3 && landType !== 6 && landType !== 8) {
                        errors.push(err('REG_BG_NOT_LAND', SEVERITY.warn, bptr, 'bgBuilding placed on non-land terrain type ' + landType));
                    }
                }
            }
        }
    }

    return errors;
}

if (typeof module !== 'undefined') module.exports = { validate_region: validate_region };
