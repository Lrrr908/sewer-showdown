// js/shared/validators/validate_patterns.js
// Input: {version, patterns, meta?}
// Returns: errors[] with stable PAT_* codes and JSON Pointer paths

if (typeof err === 'undefined' && typeof require !== 'undefined') {
    var _e = require('../errors'), SEVERITY = _e.SEVERITY, err = _e.err;
    var _pc = require('../pattern_core'), validateDimensions = _pc.validateDimensions, validatePatternChars = _pc.validatePatternChars;
}

function validate_patterns(file) {
    var errors = [];
    if (!file || typeof file !== 'object') {
        errors.push(err('PAT_NOT_OBJECT', SEVERITY.error, '', 'patterns file must be an object'));
        return errors;
    }
    if (file.version == null || typeof file.version !== 'number' || file.version !== Math.floor(file.version)) {
        errors.push(err('PAT_VERSION_MISSING', SEVERITY.error, '/version', 'version must be an integer'));
    }
    if (!file.patterns || typeof file.patterns !== 'object' || Array.isArray(file.patterns)) {
        errors.push(err('PAT_PATTERNS_MISSING', SEVERITY.error, '/patterns', 'patterns must be a non-array object'));
        return errors;
    }
    var keys = Object.keys(file.patterns);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var p = file.patterns[key];
        var ptr = '/patterns/' + key;
        if (!p || typeof p !== 'object') {
            errors.push(err('PAT_ENTRY_NOT_OBJECT', SEVERITY.error, ptr, 'pattern entry must be an object'));
            continue;
        }
        if (typeof p.width !== 'number' || p.width < 1 || p.width !== Math.floor(p.width)) {
            errors.push(err('PAT_WIDTH_INVALID', SEVERITY.error, ptr + '/width', 'width must be a positive integer'));
        }
        if (typeof p.height !== 'number' || p.height < 1 || p.height !== Math.floor(p.height)) {
            errors.push(err('PAT_HEIGHT_INVALID', SEVERITY.error, ptr + '/height', 'height must be a positive integer'));
        }
        if (typeof p.width === 'number' && typeof p.height === 'number' && Array.isArray(p.rows)) {
            var dimErrs = validateDimensions(p.rows, p.width, p.height, ptr);
            for (var d = 0; d < dimErrs.length; d++) errors.push(dimErrs[d]);
            var charErrs = validatePatternChars(p.rows, ptr);
            for (var c = 0; c < charErrs.length; c++) errors.push(charErrs[c]);
        } else if (!Array.isArray(p.rows)) {
            errors.push(err('PAT_ROWS_MISSING', SEVERITY.error, ptr + '/rows', 'rows must be an array'));
        }
    }
    return errors;
}

if (typeof module !== 'undefined') module.exports = { validate_patterns: validate_patterns };
