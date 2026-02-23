// js/admin/patterns_store.js — Single mutation path for all pattern edits
// Depends on: data_bus.js, validate_patterns.js, pattern_core.js, errors.js

var PatternsStore = (function () {

    function _patternsObj() {
        var s = DataBus.getStore();
        return (s.patternsFile && s.patternsFile.patterns) ? s.patternsFile.patterns : {};
    }

    function getPattern(key) {
        return _patternsObj()[key] || null;
    }

    function updatePattern(key, rows, w, h) {
        var existing = _patternsObj()[key];
        if (!existing) throw new Error('PatternsStore.updatePattern: pattern not found: ' + key);

        var dimErrs = validateDimensions(rows, w, h, '/patterns/' + key);
        var charErrs = validatePatternChars(rows, '/patterns/' + key);
        var allErrs = dimErrs.concat(charErrs);
        var blocking = [];
        for (var i = 0; i < allErrs.length; i++) {
            if (allErrs[i].severity === SEVERITY.error) blocking.push(allErrs[i]);
        }
        if (blocking.length > 0) return { ok: false, errors: blocking };

        DataBus.commit({
            type: 'set',
            path: '/patternsFile/patterns/' + key,
            value: { width: w, height: h, rows: rows }
        });
        return { ok: true, errors: [] };
    }

    function createPattern(key, w, h) {
        if (_patternsObj()[key]) throw new Error('PatternsStore.createPattern: key already exists: ' + key);
        var rows = [];
        var emptyRow = '';
        for (var c = 0; c < w; c++) emptyRow += '.';
        for (var r = 0; r < h; r++) rows.push(emptyRow);

        DataBus.commit({
            type: 'set',
            path: '/patternsFile/patterns/' + key,
            value: { width: w, height: h, rows: rows }
        });
        return { ok: true, errors: [] };
    }

    function deletePattern(key) {
        if (!_patternsObj()[key]) return { ok: false, errors: [err('PAT_NOT_FOUND', SEVERITY.error, '/patterns/' + key, 'pattern not found: ' + key)] };

        DataBus.commit({
            type: 'del',
            path: '/patternsFile/patterns/' + key
        });
        return { ok: true, errors: [] };
    }

    function exportPatternsJSON() {
        return DataBus.exportFile('patternsFile');
    }

    return {
        getPattern: getPattern,
        updatePattern: updatePattern,
        createPattern: createPattern,
        deletePattern: deletePattern,
        exportPatternsJSON: exportPatternsJSON
    };
})();
