// js/shared/path.js — RFC 6901 JSON Pointer: parse, get, set (in-place), delete (in-place)
// Strict semantics: no sparse arrays, numeric = array index only if node is Array.

function parsePath(ptr) {
    if (typeof ptr !== 'string') throw new Error('path.parsePath: pointer must be a string');
    if (ptr === '') return [];
    if (ptr[0] !== '/') throw new Error('path.parsePath: non-empty pointer must start with /');
    return ptr.substring(1).split('/').map(function (seg) {
        return seg.replace(/~1/g, '/').replace(/~0/g, '~');
    });
}

function getByPath(obj, ptr) {
    var segs = parsePath(ptr);
    var cur = obj;
    for (var i = 0; i < segs.length; i++) {
        if (cur == null || typeof cur !== 'object') return undefined;
        var key = segs[i];
        if (Array.isArray(cur)) {
            var idx = parseInt(key, 10);
            if (isNaN(idx) || idx < 0 || idx >= cur.length) return undefined;
            cur = cur[idx];
        } else {
            cur = cur[key];
        }
    }
    return cur;
}

function setByPath(obj, ptr, value) {
    if (ptr === '') throw new Error('path.setByPath: cannot replace root');
    var segs = parsePath(ptr);
    var cur = obj;
    for (var i = 0; i < segs.length - 1; i++) {
        var key = segs[i];
        if (cur == null || typeof cur !== 'object') {
            throw new Error('path.setByPath: cannot traverse into non-object at /' + segs.slice(0, i + 1).join('/'));
        }
        if (Array.isArray(cur)) {
            var idx = parseInt(key, 10);
            if (isNaN(idx) || idx < 0 || idx >= cur.length) {
                throw new Error('path.setByPath: array index out of bounds at /' + segs.slice(0, i + 1).join('/'));
            }
            cur = cur[idx];
        } else {
            if (!(key in cur)) cur[key] = {};
            cur = cur[key];
        }
    }
    var last = segs[segs.length - 1];
    if (Array.isArray(cur)) {
        var idx = parseInt(last, 10);
        if (isNaN(idx) || idx < 0 || idx > cur.length) {
            throw new Error('path.setByPath: array index out of bounds (no sparse): /' + segs.join('/'));
        }
        if (idx === cur.length) {
            cur.push(value);
        } else {
            cur[idx] = value;
        }
    } else {
        cur[last] = value;
    }
    return true;
}

function deleteByPath(obj, ptr) {
    if (ptr === '') throw new Error('path.deleteByPath: cannot delete root');
    var segs = parsePath(ptr);
    var cur = obj;
    for (var i = 0; i < segs.length - 1; i++) {
        var key = segs[i];
        if (cur == null || typeof cur !== 'object') return false;
        if (Array.isArray(cur)) {
            var idx = parseInt(key, 10);
            if (isNaN(idx) || idx < 0 || idx >= cur.length) return false;
            cur = cur[idx];
        } else {
            cur = cur[key];
        }
    }
    if (cur == null || typeof cur !== 'object') return false;
    var last = segs[segs.length - 1];
    if (Array.isArray(cur)) {
        var idx = parseInt(last, 10);
        if (isNaN(idx) || idx < 0 || idx >= cur.length) return false;
        cur.splice(idx, 1);
        return true;
    } else {
        if (!(last in cur)) return false;
        delete cur[last];
        return true;
    }
}

if (typeof module !== 'undefined') module.exports = { parsePath: parsePath, getByPath: getByPath, setByPath: setByPath, deleteByPath: deleteByPath };
