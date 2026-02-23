// js/shared/validators/validate_level.js
// Input: {version, ...levelData} (world, tilemap, enemies, spawns, etc.)
// Returns: errors[] with stable LVL_* codes and JSON Pointer paths

if (typeof err === 'undefined' && typeof require !== 'undefined') {
    var _e = require('../errors'), SEVERITY = _e.SEVERITY, err = _e.err;
    var _ls = require('../level_schema'), LEVEL_THEMES = _ls.LEVEL_THEMES;
}

function validate_level(file) {
    var errors = [];
    if (!file || typeof file !== 'object') {
        errors.push(err('LVL_NOT_OBJECT', SEVERITY.error, '', 'level file must be an object'));
        return errors;
    }
    if (file.version != null && (typeof file.version !== 'number' || file.version !== Math.floor(file.version))) {
        errors.push(err('LVL_VERSION_INVALID', SEVERITY.error, '/version', 'version must be an integer'));
    }
    if (!file.world || typeof file.world !== 'object') {
        errors.push(err('LVL_WORLD_MISSING', SEVERITY.error, '/world', 'level must have a world definition'));
        return errors;
    }
    var w = file.world.widthTiles;
    var h = file.world.heightTiles;
    if (typeof w !== 'number' || w < 1) {
        errors.push(err('LVL_WIDTH_INVALID', SEVERITY.error, '/world/widthTiles', 'widthTiles must be a positive number'));
    }
    if (typeof h !== 'number' || h < 1) {
        errors.push(err('LVL_HEIGHT_INVALID', SEVERITY.error, '/world/heightTiles', 'heightTiles must be a positive number'));
    }
    if (file.world.theme && typeof LEVEL_THEMES !== 'undefined' && !LEVEL_THEMES[file.world.theme]) {
        errors.push(err('LVL_THEME_UNKNOWN', SEVERITY.warn, '/world/theme', 'unknown theme: ' + file.world.theme));
    }

    if (!Array.isArray(file.tilemap)) {
        errors.push(err('LVL_TILEMAP_MISSING', SEVERITY.error, '/tilemap', 'tilemap must be an array of rows'));
    } else {
        if (typeof h === 'number' && file.tilemap.length !== h) {
            errors.push(err('LVL_TILEMAP_HEIGHT', SEVERITY.error, '/tilemap', 'tilemap rows (' + file.tilemap.length + ') != heightTiles (' + h + ')'));
        }
        for (var r = 0; r < file.tilemap.length; r++) {
            if (!Array.isArray(file.tilemap[r])) {
                errors.push(err('LVL_TILEMAP_ROW', SEVERITY.error, '/tilemap/' + r, 'row must be an array'));
            } else if (typeof w === 'number' && file.tilemap[r].length !== w) {
                errors.push(err('LVL_TILEMAP_WIDTH', SEVERITY.error, '/tilemap/' + r, 'row width (' + file.tilemap[r].length + ') != widthTiles (' + w + ')'));
            }
        }
    }

    if (!file.spawns || typeof file.spawns !== 'object') {
        errors.push(err('LVL_SPAWNS_MISSING', SEVERITY.error, '/spawns', 'level must have spawns'));
    } else {
        if (!file.spawns.player || typeof file.spawns.player.x !== 'number' || typeof file.spawns.player.y !== 'number') {
            errors.push(err('LVL_SPAWN_PLAYER', SEVERITY.error, '/spawns/player', 'player spawn must have numeric x and y'));
        }
        if (!file.spawns.exit || typeof file.spawns.exit.x !== 'number' || typeof file.spawns.exit.y !== 'number') {
            errors.push(err('LVL_SPAWN_EXIT', SEVERITY.error, '/spawns/exit', 'exit spawn must have numeric x and y'));
        }
    }

    if (file.enemies != null && !Array.isArray(file.enemies)) {
        errors.push(err('LVL_ENEMIES_NOT_ARRAY', SEVERITY.error, '/enemies', 'enemies must be an array'));
    } else if (Array.isArray(file.enemies)) {
        for (var e = 0; e < file.enemies.length; e++) {
            var en = file.enemies[e];
            if (!en || typeof en !== 'object') {
                errors.push(err('LVL_ENEMY_NOT_OBJECT', SEVERITY.error, '/enemies/' + e, 'enemy must be an object'));
                continue;
            }
            if (typeof en.type !== 'string') {
                errors.push(err('LVL_ENEMY_TYPE', SEVERITY.error, '/enemies/' + e + '/type', 'enemy must have a string type'));
            }
            if (typeof en.x !== 'number' || typeof en.y !== 'number') {
                errors.push(err('LVL_ENEMY_POS', SEVERITY.error, '/enemies/' + e, 'enemy must have numeric x and y'));
            }
        }
    }

    return errors;
}

if (typeof module !== 'undefined') module.exports = { validate_level: validate_level };
