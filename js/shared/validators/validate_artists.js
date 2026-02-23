// js/shared/validators/validate_artists.js
// Input: {version, artists}
// Returns: errors[] with stable ART_* codes and JSON Pointer paths

if (typeof err === 'undefined' && typeof require !== 'undefined') {
    var _e = require('../errors'), SEVERITY = _e.SEVERITY, err = _e.err;
}

function validate_artists(file) {
    var errors = [];
    if (!file || typeof file !== 'object') {
        errors.push(err('ART_NOT_OBJECT', SEVERITY.error, '', 'artists file must be an object'));
        return errors;
    }
    if (file.version == null || typeof file.version !== 'number' || file.version !== Math.floor(file.version)) {
        errors.push(err('ART_VERSION_MISSING', SEVERITY.error, '/version', 'version must be an integer'));
    }
    if (!Array.isArray(file.artists)) {
        errors.push(err('ART_ARTISTS_MISSING', SEVERITY.error, '/artists', 'artists must be an array'));
        return errors;
    }
    var seenIds = {};
    for (var i = 0; i < file.artists.length; i++) {
        var a = file.artists[i];
        var ptr = '/artists/' + i;
        if (!a || typeof a !== 'object') {
            errors.push(err('ART_ENTRY_NOT_OBJECT', SEVERITY.error, ptr, 'artist entry must be an object'));
            continue;
        }
        if (typeof a.id !== 'string' || a.id.length === 0) {
            errors.push(err('ART_ID_MISSING', SEVERITY.error, ptr + '/id', 'artist must have a non-empty string id'));
        } else {
            if (seenIds[a.id]) {
                errors.push(err('ART_ID_DUPLICATE', SEVERITY.error, ptr + '/id', 'duplicate artist id: ' + a.id));
            }
            seenIds[a.id] = true;
        }
        if (typeof a.name !== 'string' || a.name.length === 0) {
            errors.push(err('ART_NAME_MISSING', SEVERITY.error, ptr + '/name', 'artist must have a non-empty name'));
        }
        if (typeof a.ig !== 'string') {
            errors.push(err('ART_IG_MISSING', SEVERITY.warn, ptr + '/ig', 'artist should have an ig handle'));
        }
        if (typeof a.location !== 'string') {
            errors.push(err('ART_LOCATION_MISSING', SEVERITY.warn, ptr + '/location', 'artist should have a location'));
        }
    }
    return errors;
}

if (typeof module !== 'undefined') module.exports = { validate_artists: validate_artists };
