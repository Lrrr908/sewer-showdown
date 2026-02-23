// js/shared/pattern_core.js — Pattern validation and rendering primitives
// Pure functions. Depends on: errors.js (err, SEVERITY), palette.js (PALKEYS)

if (typeof PALKEYS === 'undefined' && typeof require !== 'undefined') {
    var _e = require('./errors'), SEVERITY = _e.SEVERITY, err = _e.err;
    var _p = require('./palette'), PALKEYS = _p.PALKEYS;
}

var ALLOWED_CHARS = (function () {
    var s = {};
    if (typeof PALKEYS !== 'undefined') {
        for (var i = 0; i < PALKEYS.length; i++) s[PALKEYS[i]] = true;
    }
    s['.'] = true;
    return s;
})();

function validateDimensions(rows, w, h, ptrPrefix) {
    var errors = [];
    var pre = ptrPrefix || '';
    if (!Array.isArray(rows)) {
        errors.push(err('PAT_ROWS_NOT_ARRAY', SEVERITY.error, pre + '/rows', 'rows must be an array'));
        return errors;
    }
    if (rows.length !== h) {
        errors.push(err('PAT_HEIGHT_MISMATCH', SEVERITY.error, pre + '/rows', 'expected ' + h + ' rows, got ' + rows.length));
    }
    for (var r = 0; r < rows.length; r++) {
        if (typeof rows[r] !== 'string') {
            errors.push(err('PAT_ROW_NOT_STRING', SEVERITY.error, pre + '/rows/' + r, 'row must be a string'));
        } else if (rows[r].length !== w) {
            errors.push(err('PAT_WIDTH_MISMATCH', SEVERITY.error, pre + '/rows/' + r, 'expected width ' + w + ', got ' + rows[r].length));
        }
    }
    return errors;
}

function validatePatternChars(rows, ptrPrefix) {
    var errors = [];
    var pre = ptrPrefix || '';
    if (!Array.isArray(rows)) return errors;
    for (var r = 0; r < rows.length; r++) {
        if (typeof rows[r] !== 'string') continue;
        for (var c = 0; c < rows[r].length; c++) {
            if (!ALLOWED_CHARS[rows[r][c]]) {
                errors.push(err('PAT_INVALID_CHAR', SEVERITY.error, pre + '/rows/' + r,
                    'invalid char \'' + rows[r][c] + '\' at col ' + c));
            }
        }
    }
    return errors;
}

function renderPatternToCanvas(ctx, rows, x, y, scale, palToRgbFn) {
    if (!ctx || !rows) return;
    var s = scale || 1;
    for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        if (typeof row !== 'string') continue;
        for (var c = 0; c < row.length; c++) {
            var ch = row[c];
            if (ch === '.') continue;
            var rgb = palToRgbFn(ch);
            if (!rgb) continue;
            ctx.fillStyle = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
            ctx.fillRect(x + c * s, y + r * s, s, s);
        }
    }
}

function computeMass(rows) {
    var count = 0;
    for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        if (typeof row !== 'string') continue;
        for (var c = 0; c < row.length; c++) {
            if (row[c] !== '.') count++;
        }
    }
    return count;
}

if (typeof module !== 'undefined') module.exports = {
    ALLOWED_CHARS: ALLOWED_CHARS, validateDimensions: validateDimensions,
    validatePatternChars: validatePatternChars, renderPatternToCanvas: renderPatternToCanvas,
    computeMass: computeMass
};
