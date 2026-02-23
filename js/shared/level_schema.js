// js/shared/level_schema.js — Declarative constants for levels, tiles, entities, buildings
// No functions. Read-only data.

var TILE_TYPES = Object.freeze({
    FLOOR: 0,
    WALL: 1,
    HAZARD: 2,
    SPAWN_PLAYER: 3,
    SPAWN_EXIT: 4,
    ITEM: 5
});

var TILE_BEHAVIORS = Object.freeze({
    0: 'walkable',
    1: 'solid',
    2: 'hazard',
    3: 'walkable',
    4: 'walkable',
    5: 'walkable'
});

var ENTITY_TYPES = Object.freeze({
    foot: { name: 'Foot Soldier', baseCost: 10 },
    foot_ranged: { name: 'Foot Ranged', baseCost: 15, minDiff: 3 },
    foot_shield: { name: 'Foot Shield', baseCost: 18, minDiff: 3 },
    foot_runner: { name: 'Foot Runner', baseCost: 8, minDiff: 2 }
});

var BUILDING_TYPES = Object.freeze({
    apt_small:    { name: 'Small Apartment',  h: 0.8, windows: 2 },
    apt_tall:     { name: 'Tall Apartment',   h: 1.3, windows: 4 },
    apt_med:      { name: 'Medium Apartment', h: 1.2, windows: 3 },
    office:       { name: 'Office',           h: 1.2, windows: 3 },
    house:        { name: 'House',            h: 0.6, windows: 1 },
    shopfront:    { name: 'Shopfront',        h: 0.7, windows: 1 },
    shop:         { name: 'Shop',             h: 0.7, windows: 1 },
    warehouse:    { name: 'Warehouse',        h: 0.9, windows: 0 },
    warehouse_bg: { name: 'Warehouse BG',     h: 0.9, windows: 0 },
    gas_station:  { name: 'Gas Station',      h: 0.7, windows: 0 },
    temple:       { name: 'Temple',           h: 1.1, windows: 0 },
    mosque:       { name: 'Mosque',           h: 1.2, windows: 0 },
    tower:        { name: 'Tower',            h: 1.8, windows: 0 },
    palace:       { name: 'Palace',           h: 1.0, windows: 0 },
    gate:         { name: 'Gate',             h: 0.9, windows: 0 },
    monument:     { name: 'Monument',         h: 1.0, windows: 0 },
    mall:         { name: 'Mall',             h: 0.8, windows: 0 },
    fastfood:     { name: 'Fast Food',        h: 0.7, windows: 0 },
    pizza:        { name: 'Pizza',            h: 0.8, windows: 0 }
});

var BUILDING_TYPE_RULES = Object.freeze({
    requiresRoad: ['apt_small', 'apt_tall', 'apt_med', 'office', 'house', 'shopfront', 'shop', 'warehouse', 'gas_station', 'mall', 'fastfood', 'pizza'],
    landmark:     ['temple', 'mosque', 'tower', 'palace', 'gate', 'monument']
});

var LEVEL_THEMES = Object.freeze({
    sewer:   { name: 'Sewer',        obs: 0.08, corW: 3, rmMin: 4, rmMax: 8 },
    street:  { name: 'Street Fight', obs: 0.04, corW: 5, rmMin: 6, rmMax: 12 },
    dock:    { name: 'Dock',         obs: 0.10, corW: 3, rmMin: 5, rmMax: 9 },
    gallery: { name: 'Gallery',      obs: 0.03, corW: 5, rmMin: 6, rmMax: 10 }
});

var LEVEL_SIZES = Object.freeze({
    S: { w: 24, h: 12 },
    M: { w: 36, h: 15 },
    L: { w: 48, h: 18 }
});

var LEVEL_ROUTES = Object.freeze({
    landmark: {
        'lm_sewer': { kind: 'static', levelId: 'level_sewer' }
    },
    buildingType: {
        'arcade':      { kind: 'generated', theme: 'street' },
        'warehouse':   { kind: 'generated', theme: 'dock' },
        'gallery':     { kind: 'generated', theme: 'gallery' },
        'dimension_x': { kind: 'static', levelId: 'level_technodrome' }
    }
});

if (typeof module !== 'undefined') module.exports = {
    TILE_TYPES: TILE_TYPES, TILE_BEHAVIORS: TILE_BEHAVIORS,
    ENTITY_TYPES: ENTITY_TYPES, BUILDING_TYPES: BUILDING_TYPES,
    BUILDING_TYPE_RULES: BUILDING_TYPE_RULES, LEVEL_THEMES: LEVEL_THEMES,
    LEVEL_SIZES: LEVEL_SIZES, LEVEL_ROUTES: LEVEL_ROUTES
};
