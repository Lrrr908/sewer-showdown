// js/shared/palette.js — Single source of truth for the NES 2C02 PPU palette
// No DOM, no storage, no fetch. Pure data + lookup functions.

var PAL = {
    // === Original keys (DO NOT change these colors) ===
    W: '#fcfcfc', L: '#bcbcbc', G: '#747474', B: '#0070ec',
    K: '#000000', N: '#24188c', C: '#3cbcfc', R: '#a40000',
    P: '#fc7460', T: '#fcd8a8', D: '#7c0800', M: '#c84c0c',
    O: '#fc9838', V: '#00a800',
    H: '#009000', J: '#30c830', Q: '#58d858',
    U: '#886830', I: '#a08848',
    // === NES Row 0 — dark ($00-$0C) ===
    a: '#808080',
    b: '#0000BB',
    A: '#3700BF',
    E: '#8400A6',
    S: '#BB006A',
    F: '#B7001E',
    c: '#912600',
    d: '#7B2B00',
    e: '#003E00',
    f: '#00480D',
    g: '#003C22',
    h: '#002F66',
    // === NES Row 1 — medium ($10-$1D) ===
    i: '#C8C8C8',
    j: '#0059FF',
    k: '#443CFF',
    l: '#B733CC',
    m: '#FF33AA',
    n: '#FF375E',
    X: '#FF371A',
    o: '#D54B00',
    p: '#C46200',
    q: '#3C7B00',
    r: '#009566',
    s: '#0084C4',
    t: '#111111',
    // === NES Row 2 — light ($20-$2D) ===
    u: '#6F84FF',
    v: '#D56FFF',
    w: '#FF77CC',
    x: '#FF915F',
    Y: '#FFA233',
    y: '#A6BF00',
    Z: '#4DD5AE',
    z: '#00D9FF',
    '0': '#666666',
    // === NES Row 3 — pale/pastel ($31-$3D) ===
    '1': '#84BFFF',
    '2': '#BBBBFF',
    '3': '#D0BBFF',
    '4': '#FFBFEA',
    '5': '#FFBFCC',
    '6': '#FFC4B7',
    '7': '#FFCCAE',
    '8': '#FFD9A2',
    '9': '#CCE199',
    // === Transparent ===
    '.': null
};

var PALKEYS = [];
(function () {
    var keys = Object.keys(PAL);
    for (var i = 0; i < keys.length; i++) {
        if (keys[i] !== '.') PALKEYS.push(keys[i]);
    }
    PALKEYS.sort();
})();

var PALCACHE = {};
(function () {
    function hexToRgb(hex) {
        var n = parseInt(hex.substring(1), 16);
        return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
    }
    for (var i = 0; i < PALKEYS.length; i++) {
        var k = PALKEYS[i];
        PALCACHE[k] = hexToRgb(PAL[k]);
    }
})();

function palToRgb(key) {
    if (key === '.') return null;
    return PALCACHE[key] || null;
}

function colorDist(r1, g1, b1, r2, g2, b2) {
    var dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return dr * dr + dg * dg + db * db;
}

function findNearestPalKey(r, g, b) {
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < PALKEYS.length; i++) {
        var c = PALCACHE[PALKEYS[i]];
        var d = colorDist(r, g, b, c.r, c.g, c.b);
        if (d < bestD) { bestD = d; best = PALKEYS[i]; }
    }
    return best;
}

if (typeof module !== 'undefined') module.exports = { PAL: PAL, PALKEYS: PALKEYS, PALCACHE: PALCACHE, palToRgb: palToRgb, colorDist: colorDist, findNearestPalKey: findNearestPalKey };
