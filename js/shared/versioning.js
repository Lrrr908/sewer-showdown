// js/shared/versioning.js — Version gating for data file exports

var SUPPORTED_VERSIONS = Object.freeze({
    patterns:  [1],
    artists:   [1],
    buildings: [1],
    level:     [1],
    region:    [1],
    world:     [1]
});

function isSupported(fileKey, version) {
    var list = SUPPORTED_VERSIONS[fileKey];
    if (!list) return false;
    return list.indexOf(version) !== -1;
}

if (typeof module !== 'undefined') module.exports = { SUPPORTED_VERSIONS: SUPPORTED_VERSIONS, isSupported: isSupported };
