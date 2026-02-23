// js/shared/validators/validate_buildings.js
// Input: (buildingsFile, artistsFile)
// Returns: errors[] with stable BLD_* codes and JSON Pointer paths

if (typeof err === 'undefined' && typeof require !== 'undefined') {
    var _e = require('../errors'), SEVERITY = _e.SEVERITY, err = _e.err;
}

function validate_buildings(buildingsFile, artistsFile) {
    var errors = [];
    if (!buildingsFile || typeof buildingsFile !== 'object') {
        errors.push(err('BLD_NOT_OBJECT', SEVERITY.error, '', 'buildings file must be an object'));
        return errors;
    }
    if (buildingsFile.version == null || typeof buildingsFile.version !== 'number' || buildingsFile.version !== Math.floor(buildingsFile.version)) {
        errors.push(err('BLD_VERSION_MISSING', SEVERITY.error, '/version', 'version must be an integer'));
    }
    if (!Array.isArray(buildingsFile.buildings)) {
        errors.push(err('BLD_BUILDINGS_MISSING', SEVERITY.error, '/buildings', 'buildings must be an array'));
        return errors;
    }

    var validArtistIds = {};
    if (artistsFile && Array.isArray(artistsFile.artists)) {
        for (var a = 0; a < artistsFile.artists.length; a++) {
            if (artistsFile.artists[a] && typeof artistsFile.artists[a].id === 'string') {
                validArtistIds[artistsFile.artists[a].id] = true;
            }
        }
    }

    var seenIds = {};
    for (var i = 0; i < buildingsFile.buildings.length; i++) {
        var b = buildingsFile.buildings[i];
        var ptr = '/buildings/' + i;
        if (!b || typeof b !== 'object') {
            errors.push(err('BLD_ENTRY_NOT_OBJECT', SEVERITY.error, ptr, 'building entry must be an object'));
            continue;
        }
        if (typeof b.id !== 'string' || b.id.length === 0) {
            errors.push(err('BLD_ID_MISSING', SEVERITY.error, ptr + '/id', 'building must have a non-empty string id'));
        } else {
            if (seenIds[b.id]) {
                errors.push(err('BLD_ID_DUPLICATE', SEVERITY.error, ptr + '/id', 'duplicate building id: ' + b.id));
            }
            seenIds[b.id] = true;
        }
        if (b.artistId != null && typeof b.artistId === 'string' && b.artistId.length > 0) {
            if (!validArtistIds[b.artistId]) {
                errors.push(err('BLD_ARTIST_NOT_FOUND', SEVERITY.error, ptr + '/artistId', 'artist id not found: ' + b.artistId));
            }
        }
        if (typeof b.x !== 'number' || typeof b.y !== 'number') {
            errors.push(err('BLD_POSITION_INVALID', SEVERITY.error, ptr, 'building must have numeric x and y'));
        }
    }
    return errors;
}

if (typeof module !== 'undefined') module.exports = { validate_buildings: validate_buildings };
