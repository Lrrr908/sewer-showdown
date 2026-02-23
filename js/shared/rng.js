// js/shared/rng.js — Deterministic RNG and tile hashing
// No random globals. Deterministic only.

function mulberry32(seed) {
    var s = seed | 0;
    return function () {
        s = (s + 0x6D2B79F5) | 0;
        var t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function tileHash(x, y) {
    var h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0);
}

if (typeof module !== 'undefined') module.exports = { mulberry32: mulberry32, tileHash: tileHash };
