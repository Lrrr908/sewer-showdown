// js/admin/data_bus.js — Centralized state store with undo/redo, dirty tracking, validated export
// Depends on: path.js, versioning.js, errors.js

var DataBus = (function () {

    var store = {
        patternsFile:  null,
        artistsFile:   null,
        buildingsFile: null,
        regions:       {},
        worldFile:     null,
        levels:        {}
    };

    var undoStack = [];
    var redoStack = [];
    var MAX_UNDO = 200;

    var dirtyFlags = {};

    var listeners = [];

    // --- File ownership: which top-level store key does a pointer belong to? ---
    function ownerKey(ptr) {
        var segs = parsePath(ptr);
        return segs.length > 0 ? segs[0] : null;
    }

    function markDirty(ptr) {
        var key = ownerKey(ptr);
        if (key) dirtyFlags[key] = true;
    }

    function notify(op) {
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](op); } catch (e) { console.error('[DataBus] listener error', e); }
        }
    }

    // --- Capture previous value for undo ---
    function capturePrev(ptr) {
        var val = getByPath(store, ptr);
        if (val !== undefined && typeof val === 'object' && val !== null) {
            return JSON.parse(JSON.stringify(val));
        }
        return val;
    }

    // --- Apply a single op in-place, return inverse op ---
    function applyOp(op) {
        if (op.type === 'set') {
            var prev = capturePrev(op.path);
            setByPath(store, op.path, op.value);
            markDirty(op.path);
            return { type: 'set', path: op.path, value: prev };
        }
        if (op.type === 'del') {
            var prev = capturePrev(op.path);
            if (prev === undefined) {
                return null;
            }
            deleteByPath(store, op.path);
            markDirty(op.path);
            return { type: 'set', path: op.path, value: prev };
        }
        if (op.type === 'splice') {
            var arr = getByPath(store, op.path);
            if (!Array.isArray(arr)) throw new Error('DataBus splice: target is not an array at ' + op.path);
            var idx = op.index != null ? op.index : arr.length;
            var delCount = op.deleteCount || 0;
            var items = op.items || [];
            var removed = arr.splice.apply(arr, [idx, delCount].concat(items));
            markDirty(op.path);
            return { type: 'splice', path: op.path, index: idx, deleteCount: items.length, items: removed };
        }
        if (op.type === 'batch') {
            if (!Array.isArray(op.ops)) throw new Error('DataBus batch: ops must be an array');
            var inverses = [];
            for (var i = 0; i < op.ops.length; i++) {
                var inv = applyOp(op.ops[i]);
                if (inv) inverses.push(inv);
            }
            inverses.reverse();
            return { type: 'batch', ops: inverses };
        }
        throw new Error('DataBus: unknown op type: ' + op.type);
    }

    // --- Public API ---

    function commit(op) {
        var inverse = applyOp(op);
        if (inverse) {
            undoStack.push(inverse);
            if (undoStack.length > MAX_UNDO) undoStack.shift();
        }
        redoStack.length = 0;
        notify(op);
    }

    function undo() {
        if (undoStack.length === 0) return false;
        var inverse = undoStack.pop();
        var redo = applyOp(inverse);
        if (redo) redoStack.push(redo);
        notify(inverse);
        return true;
    }

    function redo() {
        if (redoStack.length === 0) return false;
        var op = redoStack.pop();
        var inverse = applyOp(op);
        if (inverse) undoStack.push(inverse);
        notify(op);
        return true;
    }

    function isDirty(fileKey) {
        return !!dirtyFlags[fileKey];
    }

    function clearDirty(fileKey) {
        delete dirtyFlags[fileKey];
    }

    // --- Validators by file key ---
    var VALIDATORS = {
        patternsFile:  function (s) { return (typeof validate_patterns === 'function') ? validate_patterns(s.patternsFile) : []; },
        artistsFile:   function (s) { return (typeof validate_artists === 'function') ? validate_artists(s.artistsFile) : []; },
        buildingsFile: function (s) { return (typeof validate_buildings === 'function') ? validate_buildings(s.buildingsFile, s.artistsFile) : []; },
        worldFile:     function (s) { return (typeof validate_world === 'function') ? validate_world(s.worldFile) : []; }
    };

    var VERSION_KEYS = {
        patternsFile:  'patterns',
        artistsFile:   'artists',
        buildingsFile: 'buildings',
        worldFile:     'world'
    };

    function exportFile(fileKey) {
        var data = store[fileKey];
        if (!data) return { ok: false, errors: [err('BUS_NO_DATA', SEVERITY.error, '', 'no data loaded for ' + fileKey)] };

        var vKey = VERSION_KEYS[fileKey];
        if (vKey && data.version != null && !isSupported(vKey, data.version)) {
            return { ok: false, errors: [err('VER_UNSUPPORTED', SEVERITY.error, '/version', 'version ' + data.version + ' not supported for ' + vKey)] };
        }

        var validator = VALIDATORS[fileKey];
        if (validator) {
            var errs = validator(store);
            var blocking = [];
            for (var i = 0; i < errs.length; i++) {
                if (errs[i].severity === SEVERITY.error) blocking.push(errs[i]);
            }
            if (blocking.length > 0) return { ok: false, errors: blocking };
        }

        var json = JSON.stringify(data, null, 2);
        var blob = new Blob([json], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = fileKey.replace('File', '') + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        clearDirty(fileKey);
        return { ok: true, errors: [] };
    }

    function importFile(fileKey, data) {
        store[fileKey] = data;
        dirtyFlags[fileKey] = false;
        undoStack.length = 0;
        redoStack.length = 0;
        notify({ type: 'import', fileKey: fileKey });
    }

    function getStore() {
        return store;
    }

    function subscribe(fn) {
        listeners.push(fn);
        return function unsubscribe() {
            var idx = listeners.indexOf(fn);
            if (idx !== -1) listeners.splice(idx, 1);
        };
    }

    return {
        commit: commit,
        undo: undo,
        redo: redo,
        isDirty: isDirty,
        clearDirty: clearDirty,
        exportFile: exportFile,
        importFile: importFile,
        getStore: getStore,
        subscribe: subscribe
    };
})();
