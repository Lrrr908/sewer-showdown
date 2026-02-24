/**
 * Sewer Showdown - Party Wagon World Explorer
 * Using REAL NES sprites from Teenage Mutant Ninja Turtles!
 * NOW WITH SCROLLING CAMERA!
 */

// ============================================
// BRAND — single source of truth for game identity
// ============================================

const BRAND = {
    title: 'SEWER SHOWDOWN',
    subtitle: 'Party Wagon World Explorer',
    levelPrefix: 'SEWER SHOWDOWN',
    version: '1.0'
};

// ============================================
// SAVE SYSTEM (versioned localStorage)
// ============================================

const SAVE_KEY = 'sewerShowdown_save';
const SAVE_VERSION = 2;

function saveGame() {
    try {
        var blob = {
            version: SAVE_VERSION,
            timestamp: Date.now(),
            progress: game.progress
        };
        localStorage.setItem(SAVE_KEY, JSON.stringify(blob));
    } catch (e) {
        console.warn('Save failed:', e.message);
    }
}

function loadSave() {
    try {
        var raw = localStorage.getItem(SAVE_KEY);
        if (!raw) return;
        var blob = JSON.parse(raw);
        if (!blob || typeof blob.version !== 'number') return;
        if (blob.version > SAVE_VERSION) {
            console.warn('Save version ' + blob.version + ' is newer than engine version ' + SAVE_VERSION + '; ignoring save.');
            return;
        }
        // Migrate v1 -> v2: add score/item fields
        if (blob.version === 1) {
            blob.progress.score = blob.progress.score || 0;
            blob.progress.bestScore = blob.progress.bestScore || 0;
            blob.progress.scoreHistory = blob.progress.scoreHistory || [];
            blob.progress.collectedItems = blob.progress.collectedItems || {};
            blob.progress.galleriesVisited = blob.progress.galleriesVisited || {};
            blob.progress.technodromeClear = blob.progress.technodromeClear || false;
            blob.version = 2;
        }
        if (blob.progress) {
            if (blob.progress.levelWins) {
                for (var k in blob.progress.levelWins) {
                    game.progress.levelWins[k] = blob.progress.levelWins[k];
                }
            }
            game.progress.score = blob.progress.score || 0;
            game.progress.bestScore = blob.progress.bestScore || 0;
            game.progress.scoreHistory = blob.progress.scoreHistory || [];
            game.progress.collectedItems = blob.progress.collectedItems || {};
            game.progress.galleriesVisited = blob.progress.galleriesVisited || {};
            game.progress.technodromeClear = blob.progress.technodromeClear || false;
        }
        console.log('Save loaded (' + Object.keys(game.progress.levelWins).length + ' wins, saved ' + new Date(blob.timestamp).toLocaleString() + ')');
    } catch (e) {
        console.warn('Load save failed:', e.message);
    }
}

function clearSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch (_) {}
    game.progress = { levelWins: {}, score: 0, bestScore: 0, scoreHistory: [], collectedItems: {}, galleriesVisited: {}, technodromeClear: false };
    console.log('Save cleared.');
}

// ============================================
// GAME CONSTANTS
// ============================================

let TILE_SIZE = 64;
let WORLD_WIDTH = 60;
let WORLD_HEIGHT = 40;

// ============================================
// DATA — loaded from JSON at startup
// ============================================

let ARTISTS = {};
let BUILDINGS = [];
let BUILDING_BY_ID = {};
let ROAD_GRID = null;
let ROAD_TYPE_GRID = null;  // 1=street, 2=highway
let ROAD_COUNT = 0;
let RIVER_GRID = null;
let RIVER_COUNT = 0;
let BRIDGE_GRID = null;
let BRIDGE_COUNT = 0;
let TERRAIN_GRID = null;  // 2D array from generator (0=ocean,1=coast,2=land,3=mountain,4=river)
let LANDMARKS = [];
let DISTRICTS = [];
let FILLER_BUILDINGS = [];
let BG_BUILDINGS = [];     // Non-enterable background buildings
let BG_BUILDING_GRID = null; // Tile grid: 1 = BG building occupies this tile
let COLLISION_GRID = null; // Master collision grid: 1 = blocked tile (buildings, BG, water, etc.)
let SIDEWALK_GRID = null;  // Tile grid: 1 = sidewalk (road-adjacent land tile)
let DIRT_GRID = null;       // Tile grid: 1 = dirt patch (building-adjacent land tile)
let ROAD_CENTER_MASK = null; // Centerline conn_mask from roadGraph (0=not centerline)
let TOWN_PROPS = [];       // Streetscape props (lampposts, trees, etc.)

// Row-bucketed draw lists for O(visible_rows) rendering
let ROW_BG = [];       // ROW_BG[y] = [bgBuilding, ...]
let ROW_BUILDINGS = []; // ROW_BUILDINGS[y] = [building, ...]
let ROW_PROPS = [];    // ROW_PROPS[y] = [prop, ...]
let ROW_LANDMARKS = []; // ROW_LANDMARKS[y] = [landmark, ...]

const FALLBACK_DEFAULTS = {
    collisionRect: { ox: -16, oy: -32, w: 96, h: 96 },
    enterRect:     { ox: -56, oy: -88, w: 176, h: 176 },
    exitRect:      { ox: -88, oy: -120, w: 240, h: 240 }
};

const FALLBACK_MAP = {
    world: { widthTiles: 60, heightTiles: 40, tileSize: 64 },
    buildingPlacements: [{ buildingId: 'fb1', x: 8, y: 6 }],
    landmarks: [],
    roads: [],
    river: []
};

// ============================================
// NES TMNT PIXEL ART ENGINE
// ============================================

var NES = (function () {
    // ── Full NES 2C02 PPU palette ──
    // Original 19 keys kept with their exact colors for backward compat.
    // Remaining NES hardware colors added with new single-char keys.
    // Canonical hex values from nesdev.org (Conte decode).
    var PAL = {
        // === Original keys (DO NOT change these colors) ===
        W: '#fcfcfc', L: '#bcbcbc', G: '#747474', B: '#0070ec',
        K: '#000000', N: '#24188c', C: '#3cbcfc', R: '#a40000',
        P: '#fc7460', T: '#fcd8a8', D: '#7c0800', M: '#c84c0c',
        O: '#fc9838', V: '#00a800',
        H: '#009000', J: '#30c830', Q: '#58d858',
        U: '#886830', I: '#a08848',
        // === NES Row 0 — dark ($00-$0C) ===
        a: '#808080', // $00 dark gray
        b: '#0000BB', // $01 dark blue
        A: '#3700BF', // $02 dark violet
        E: '#8400A6', // $03 dark purple
        S: '#BB006A', // $04 dark magenta
        F: '#B7001E', // $05 dark rose
        c: '#912600', // $07 dark orange
        d: '#7B2B00', // $08 dark brown
        e: '#003E00', // $09 dark chartreuse
        f: '#00480D', // $0A dark green
        g: '#003C22', // $0B dark spring
        h: '#002F66', // $0C dark cyan
        // === NES Row 1 — medium ($10-$1D) ===
        i: '#C8C8C8', // $10 light gray / silver
        j: '#0059FF', // $11 medium blue
        k: '#443CFF', // $12 medium violet
        l: '#B733CC', // $13 medium purple
        m: '#FF33AA', // $14 medium magenta
        n: '#FF375E', // $15 medium rose
        X: '#FF371A', // $16 medium red
        o: '#D54B00', // $17 medium orange
        p: '#C46200', // $18 medium olive
        q: '#3C7B00', // $19 medium chartreuse
        r: '#009566', // $1B medium spring/teal
        s: '#0084C4', // $1C medium cyan
        t: '#111111', // $1D near-black
        // === NES Row 2 — light ($20-$2D) ===
        u: '#6F84FF', // $22 light violet
        v: '#D56FFF', // $23 light purple
        w: '#FF77CC', // $24 light magenta
        x: '#FF915F', // $27 light orange
        Y: '#FFA233', // $28 light yellow/gold
        y: '#A6BF00', // $29 light chartreuse
        Z: '#4DD5AE', // $2B light spring
        z: '#00D9FF', // $2C light cyan
        '0': '#666666', // $2D medium gray
        // === NES Row 3 — pale/pastel ($31-$3D) ===
        '1': '#84BFFF', // $31 pale blue
        '2': '#BBBBFF', // $32 pale violet
        '3': '#D0BBFF', // $33 pale purple
        '4': '#FFBFEA', // $34 pale magenta
        '5': '#FFBFCC', // $35 pale rose
        '6': '#FFC4B7', // $36 pale peach
        '7': '#FFCCAE', // $37 pale orange
        '8': '#FFD9A2', // $38 pale yellow
        '9': '#CCE199', // $39 pale chartreuse
        _: null
    };
    var PALKEYS = Object.keys(PAL);
    var PALCACHE = {};
    for (var i = 0; i < PALKEYS.length; i++) PALCACHE[PALKEYS[i]] = PAL[PALKEYS[i]];

    var PATTERNS = {};

    // ── Real NES TMNT Leo sprites (extracted from game ROM) ──
    // B = mask color (blue for Leo, swap for each turtle)
    // V = green body, G = dark green outline, T = tan/skin

    // Down = facing camera (authentic NES ripped sprites, 16x17-18)
    PATTERNS.turtleDown1 = [
        '________BG______',
        '_______BG_______',
        '___GGGGGGG______',
        '__GVVGVVVVG_____',
        '__VVGBGGGGBG____',
        '_BVGGVBBBBVGG___',
        '_BGGGVVVVVVGVG__',
        '_VGGGGVVVVGGGV__',
        '_VVVGBGGGGBGVV__',
        '__VVGGBGBBGGBB__',
        '__GGGGGGGGVGVV__',
        '___GVGBGBGVVVG__',
        '__GGVVGGGGGGGG__',
        '__GGBBGGGGVVGG__',
        '__GGGGGGGGGGGG__',
        '___GVVGGGGGGG___',
        '_____GGGGGG_____'
    ];
    PATTERNS.turtleDown2 = [
        '________BG______',
        '_______BG_______',
        '______GGGG______',
        '___GGGVVVVGGG___',
        '__GVGBGGGGBGVG__',
        '__VVGVBBBBVGVV__',
        '__VVGVVVVVVGVV__',
        '__BGGGVVVVGGGB__',
        '__BVGBGGGGBGVB__',
        '__VVGGBBBBGGVV__',
        '__GVVGGGGGGVVG__',
        '___GGGGBBGGGG___',
        '___GVVGGGGVVG___',
        '__GGGBGGGGBGGG__',
        '__GGGGGGGGGGGG__',
        '__GGVVGGGGVVGG__',
        '___GGGGGGGGGG___',
        '_____GGGGGG_____'
    ];
    PATTERNS.turtleDown3 = [
        '________BG______',
        '_______BG_______',
        '______GGGGGGG___',
        '_____GVVVVGVVG__',
        '____GBGGGGBGVV__',
        '___GGVBBBBVGGVB_',
        '__GVGVVVVVVGGGB_',
        '__VGGGVVVVGGGGV_',
        '__VVGBGGGGBGVVV_',
        '__BBGGBBGBGGVV__',
        '__VVGVGGGGGGGG__',
        '__GVVVGBGBGVG___',
        '__GGGGGGGGVVGG__',
        '__GGVVGGGGBBGG__',
        '__GGGGGGGGGGGG__',
        '___GGGGGGGVVG___',
        '_____GGGGGG_____'
    ];

    // Up = facing away (back view: shell visible)
    PATTERNS.turtleUp1 = [
        '_____GVVVVG_____',
        '____GBVVVVBG____',
        '____GBGVVGBG____',
        '____GGBBBBGG____',
        '____GGGGGGGG____',
        '__GGGVGBBGVGGG__',
        '__VGVGVVVVGVGV__',
        '__BGVGVVVVGVGB__',
        '__GGGGVGVVGVGG__',
        '___GGGVGGGGVGG__',
        '___GGGGVVGGGGG__',
        '__GGGGGVVGGGGGG_',
        '__GGGVGGGGVGGGG_',
        '__GGGGGGGGGGGGG_',
        '___GGGGGGGVVGG__',
        '_____GGGGGG_____'
    ];
    PATTERNS.turtleUp2 = [
        '_____GVVVVG_____',
        '____GBVVVVBG____',
        '____GBGVVGBG____',
        '____GGBBBBGG____',
        '__GGGGGGGGGG____',
        '_GBVGVGBBGVGG___',
        '_GVGVGVVVVGVGG__',
        '_GVGVGVVVVGVGVG_',
        '_GVGGVGVVGVGGBG_',
        '___GGVGGGGVGGG__',
        '___GGGVGGVGGG___',
        '__GGGGGVVGVGGG__',
        '__GGGVGGGGVGGG__',
        '__GGGGGGGGGGGG__',
        '___GGGGGGVVGG___',
        '_____GGGGGG_____'
    ];
    PATTERNS.turtleRight1 = [
        '_______GVVVG____',
        '____B_GVVVVBGV__',
        '_____BGBVVVBGV__',
        '_____GGGBBBVVV__',
        '_____GGGGVVVVG__',
        '____GVVVGGGGG___',
        '___BVVVVGBGG____',
        '__GBBGGGBBGGVV__',
        '__GVVGGGGGG_GG__',
        '__GVVGGGBGGGG___',
        '__GGGGGVVGGGGG__',
        '__GGGVGGGVGGGG__',
        '__GGGGGGGVVGGG__',
        '___GGGGGGGGGG___',
        '_____GGGGGG_____',
        '________________'
    ];
    PATTERNS.turtleRight2 = [
        '_______GVVVG____',
        '____B_GVVVVBGV__',
        '_____BGBVVVBGV__',
        '_____GGGBBBVVV__',
        '_____GGGGGVVVG__',
        '___VGVVGVVGGG___',
        '__VGVVGVVVG_GG__',
        '__GGVVGGVVVGVVG_',
        '___GGVGGGVVBVVG_',
        '___GGVGGGGBBGG__',
        '__GGGGGVGGGGGG__',
        '__GGVVVGGGVGGG__',
        '__GGVGGGGGGGGG__',
        '___GGGGGGGGGG___',
        '_____GGGGGG_____',
        '________________'
    ];
    PATTERNS.turtleAttack = [
        '_______GVVVG____',
        '____B_GVVVVBGV__',
        '_____BGBVVVBGV__',
        '_____GGGBBBVVV__',
        '_____GGGGGVVVG__',
        '___VGVVGVVGGG_GG',
        '__VGVVGVVVVGGGVV',
        '__GGVVGGVVVBVVVV',
        '___GGVGGGGBBVVVG',
        '___GGVGGGGGGGGG_',
        '__GGGGGVGGGGGG__',
        '__GGVVVGGGVGGG__',
        '__GGVGGGGGGGGG__',
        '___GGGGGGGGGG___',
        '_____GGGGGG_____',
        '________________'
    ];

    // Turtle mask color keys for each character
    var TURTLE_COLORS = { leo: 'B', raph: 'R', donnie: 'N', mikey: 'O' };
    var TURTLE_FRAMES = {
        down:  ['turtleDown1', 'turtleDown2', 'turtleDown1', 'turtleDown3'],
        up:    ['turtleUp1', 'turtleUp2'],
        right: ['turtleRight1', 'turtleRight2'],
        left:  ['turtleRight1', 'turtleRight2']
    };

    // ── Area 1 Cobblestone (from area1.png / building_1-4.png / road_tile.png) ──
    // White (#fcfcfc) stones on gray (#747474) mortar, light gray (#bcbcbc) edges
    // 4 stone rows (3px each) + 4 mortar rows (1px each) = 16px
    PATTERNS.stoneBlock = [
        'GWWWWGWWWWWGWWWG',
        'GWWWWGWWWWWGWWWG',
        'GLWWLGLWWWLGLWLG',
        'GGGGGGGGGGGGGGGG',
        'GGWWWWWGGWWGGWWG',
        'GGWWWWWGGWWGGWWG',
        'GGLWWWLGGLWGGLWG',
        'GGGGGGGGGGGGGGGG',
        'GWWWGGWWWWGWWWWG',
        'GWWWGGWWWWGWWWWG',
        'GLWLGGLWWLGLWWLG',
        'GGGGGGGGGGGGGGGG',
        'GGWWGGWWWWWGGWWG',
        'GGWWGGWWWWWGGWWG',
        'GGLWGGLWWWLGGLWG',
        'GGGGGGGGGGGGGGGG'
    ];
    PATTERNS.stoneBlockAlt = [
        'GWWWWWGGWWWGGWWG',
        'GWWWWWGGWWWGGWWG',
        'GLWWWLGGLWLGGLWG',
        'GGGGGGGGGGGGGGGG',
        'GGWWWGWWWWWGWWWG',
        'GGWWWGWWWWWGWWWG',
        'GGLWLGLWWWLGLWLG',
        'GGGGGGGGGGGGGGGG',
        'GWWWWGGWWGGWWWWG',
        'GWWWWGGWWGGWWWWG',
        'GLWWLGGLWGGLWWLG',
        'GGGGGGGGGGGGGGGG',
        'GWWGGWWWWGGWWWWG',
        'GWWGGWWWWGGWWWWG',
        'GLWGGLWWLGGLWWLG',
        'GGGGGGGGGGGGGGGG'
    ];

    // ── Water (pixel-perfect from area1.png rows 224-239) ──
    // Blue (#0070ec) base with cyan (#3cbcfc) diamond wave clusters
    // 3 frames shifted horizontally for wave animation
    PATTERNS.waterBase = [
        'BBBBBBBBBBBBBBBB',
        'CBBBBBBBBBBCCBBB',
        'BBBBBBBBBCCCBCCC',
        'BBCBBBBBCBBBBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBBBBBCBBBBBBBBB',
        'BCBBBBBBBBBBBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBBBBBBBCBBBBBBB',
        'BBBCBBBBBBBBBBBB',
        'CCBBBBBBBBCBBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBBBBBBBBBBBBBCB',
        'BBBBBBBBBCBBBBBB',
        'BBBBBBBBBBBBBBBB'
    ];
    PATTERNS.waterHighlight = [
        'BBBBBBBBBBBBBBBB',
        'BBBBBBBBBCCBBBBB',
        'BBBBBBBCCCBCCCBB',
        'CBBBBBCBBBBBBBCC',
        'BBBBBBBBBBBBBBBB',
        'BBBBCBBBBBBBBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBBBBBCBBBBBBBCB',
        'BCBBBBBBBBBBBBBB',
        'BBBBBBBBCBBBBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBBBBBBBBBBBCBBB',
        'BBBBBBBCBBBBBBBC',
        'BBBBBBBBBBBBBBBB'
    ];
    PATTERNS.waterFrame2 = [
        'BBBBBBBBBBBBBBBB',
        'BBBBBBCCBBBBBBBB',
        'BBBBCCCBCCCBBBCB',
        'BBBCBBBBBBBCCBBB',
        'BBBBBBBBBBBBBBBB',
        'BCBBBBBBBBBBBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBBCBBBBBBBCBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBBBBCBBBBBBBCBB',
        'BBBBBBBBBBBBBBBB',
        'BBBBBBBBBCBBBBBB',
        'BBBBCBBBBBBBCBBB',
        'BBBBBBBBBBBBBBBB'
    ];

    // ── Canal wall (pixel-perfect from area1.png rows 208-223) ──
    // NB brick courses with K mortar + deep navy wall transition into water
    // canalWallSouth: land tile whose SOUTH side faces water (brick on top, deep wall below)
    PATTERNS.canalWallSouth = [
        'NBBNNBBKNBBNNBBK',
        'NNNNNNNKNNNNNNNK',
        'KKKKKKKKKKKKKKKK',
        'NBBKBBNNNBBKBBNN',
        'NNNKNNNNNNNKNNNN',
        'KKKKKKKKKKKKKKKK',
        'NKBBNNKBNKBBNNKB',
        'KKKKKKKKKKKKKKKK',
        'KKKKKKKKKKKKKKKK',
        'KKKKKKKKKKKKKKKK',
        'NNNNNNNNNNNNNNNN',
        'NNNNNNNNNNNNNNNN',
        'NNNNBNNNNNNNBNNN',
        'NBNNNNNNNBNNNNNN',
        'NNNNNNBNNNNNNNBN',
        'NNNNNNNNNNNNNNNN'
    ];
    // canalWallNorth: land tile whose NORTH side faces water (south bank - SUBTLE)
    // NES isometric convention: south bank wall faces north (away from NW camera)
    // Only a thin 2-row dark shadow edge at top, then normal cobblestone
    PATTERNS.canalWallNorth = [
        'KKKKKKKKKKKKKKKK',
        'NNNNNNNNNNNNNNNN',
        'GWWWWGWWWWWGWWWG',
        'GWWWWGWWWWWGWWWG',
        'GLWWLGLWWWLGLWLG',
        'GGGGGGGGGGGGGGGG',
        'GGWWWWWGGWWGGWWG',
        'GGWWWWWGGWWGGWWG',
        'GGLWWWLGGLWGGLWG',
        'GGGGGGGGGGGGGGGG',
        'GWWWGGWWWWGWWWWG',
        'GWWWGGWWWWGWWWWG',
        'GLWLGGLWWLGLWWLG',
        'GGGGGGGGGGGGGGGG',
        'GGWWGGWWWWWGGWWG',
        'GGWWGGWWWWWGGWWG'
    ];
    // Keep legacy alias for compatibility
    PATTERNS.waterEdgeTop = PATTERNS.canalWallSouth;

    // canalWallWest: vertical wall on LEFT side of tile (water is to the west)
    // NES isometric convention: east bank wall faces west (away from NW camera) = SUBTLE
    // Only a thin 2px dark shadow strip on the left edge
    PATTERNS.canalWallWest = [
        'KN______________',
        'KN______________',
        'KN______________',
        'KN______________',
        'KN______________',
        'KN______________',
        'KN______________',
        'KN______________',
        'KN______________',
        'KN______________',
        'KN______________',
        'KN______________',
        'KN______________',
        'KN______________',
        'KN______________',
        'KN______________'
    ];
    // canalWallEast: vertical wall on RIGHT side of tile (water is to the east)
    // NES isometric convention: west bank wall faces east (toward NW camera) = PROMINENT
    // 8px wide N/C/K brick-like strip with depth detail
    PATTERNS.canalWallEast = [
        '________CNNCCKCN',
        '________CCNCCNKN',
        '________CCNCCKCN',
        '________CCNCCKCN',
        '________CCNNCKCN',
        '________CCNCNNKN',
        '________CCNCCNCN',
        '________NCNCCKCN',
        '________CNNCCKCN',
        '________CCNCCNKN',
        '________CCNCCKCN',
        '________CCNCCKCN',
        '________CCNNCKCN',
        '________CCNCNNKN',
        '________CCNCCNCN',
        '________NCNCCKCN'
    ];

    // ── Road: same cobblestone as ground (it IS cobblestone in TMNT NES) ──
    PATTERNS.roadStone = [
        'GWWWWGWWWWWGWWWG',
        'GWWWWGWWWWWGWWWG',
        'GLWWLGLWWWLGLWLG',
        'GGGGGGGGGGGGGGGG',
        'GGWWWWWGGWWGGWWG',
        'GGWWWWWGGWWGGWWG',
        'GGLWWWLGGLWGGLWG',
        'GGGGGGGGGGGGGGGG',
        'GWWWGGWWWWGWWWWG',
        'GWWWGGWWWWGWWWWG',
        'GLWLGGLWWLGLWWLG',
        'GGGGGGGGGGGGGGGG',
        'GGWWGGWWWWWGGWWG',
        'GGWWGGWWWWWGGWWG',
        'GGLWGGLWWWLGGLWG',
        'GGGGGGGGGGGGGGGG'
    ];

    // ── Building window panel (from building_edge.png / dock_scene.png) ──
    // Blue (#0070ec) windows on navy (#24188c) frames, black (#000000) dividers
    PATTERNS.windowPanel = [
        'KKKKKKKKKKKKKKKK',
        'KNBBKNBBKNBBKNBK',
        'KNBBKNBBKNBBKNBK',
        'KNBBKNBBKNBBKNBK',
        'KNBBKNBBKNBBKNBK',
        'KNBBKNBBKNBBKNBK',
        'KNBBKNBBKNBBKNBK',
        'KKKKKKKKKKKKKKKK',
        'KKKKKKKKKKKKKKKK',
        'KNBBKNBBKNBBKNBK',
        'KNBBKNBBKNBBKNBK',
        'KNBBKNBBKNBBKNBK',
        'KNBBKNBBKNBBKNBK',
        'KNBBKNBBKNBBKNBK',
        'KNBBKNBBKNBBKNBK',
        'KKKKKKKKKKKKKKKK'
    ];

    // ── Red awning strip (from building_entrance.png) ──
    PATTERNS.awningRed = [
        'KKKKKKKKKKKKKKKK',
        'RRRRRRRRRRRRRRRR',
        'RRPRRRPRRRPRRRPR',
        'RRRRRRRRRRRRRRRR',
        'KKKKKKKKKKKKKKKK',
        'RRRRRRRRRRRRRRRR',
        'RPRRRPRRRPRRRPRR',
        'RRRRRRRRRRRRRRRR'
    ];

    // ── Roof cap (from area1.png building tops) ──
    // White (#fcfcfc) cap with light gray (#bcbcbc) edge, black (#000000) border
    PATTERNS.roofWhite = [
        'KKKKKKKKKKKKKKKK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KLLLLLLLLLLLLLLK',
        'KKKKKKKKKKKKKKKK'
    ];
    PATTERNS.roofEdge = [
        'KKKKKKKKKKKKKKKK',
        'KLLLLLLLLLLLLLLK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KLLLLLLLLLLLLLLK',
        'GGGGGGGGGGGGGGGG',
        'GWWWWGWWWWWGWWWG',
        'GWWWWGWWWWWGWWWG',
        'GLWWLGLWWWLGLWLG',
        'GGGGGGGGGGGGGGGG',
        'GGWWWWWGGWWGGWWG',
        'GGWWWWWGGWWGGWWG',
        'GGLWWWLGGLWGGLWG',
        'GGGGGGGGGGGGGGGG',
        'GWWWGGWWWWGWWWWG',
        'GWWWGGWWWWGWWWWG'
    ];

    // ── Navy entrance door (from building_entrance.png) ──
    PATTERNS.doorFrame = [
        'KKKKKKKKKKKKKKKK',
        'KNNNNNNNNNNNNNNK',
        'KNNNNNNNNNNNNNNK',
        'KNNNNNNNNNNNNNNK',
        'KNNNNNNNNNNNNNNK',
        'KNNNNNNNNNNNNNNK',
        'KNNNNNNNNNNNNNNK',
        'KNNNNNNNNNNNNNNK',
        'KNNNNNNNNNNNNNNK',
        'KNNNNNNNNNNNNNNK',
        'KNNNNNNNNNNNNNNK',
        'KNNNNNNNNNNNNNNK',
        'KNNNNNNNNNNNNNNK',
        'KNNNNNNNNNNNNNNK',
        'KNNNNNNNNNNNNNNK',
        'KKKKKKKKKKKKKKKK'
    ];

    // ── Manhole (small dark circle on cobblestone) ──
    PATTERNS.manhole = [
        '______KKKK______',
        '____KKGGGGKK____',
        '___KGGGGGGGGK___',
        '__KGGGLGGGLGGK__',
        '_KGGGGGGGGGGGK__',
        '_KGGGLGGGLGGGK__',
        'KGGGGGGGGGGGGGK_',
        'KGGKKKKKKKKGGK__',
        'KGGKKKKKKKKGGK__',
        'KGGGGGGGGGGGGGK_',
        '_KGGGLGGGLGGGK__',
        '_KGGGGGGGGGGGK__',
        '__KGGGLGGGLGGK__',
        '___KGGGGGGGGK___',
        '____KKGGGGKK____',
        '______KKKK______'
    ];

    // ── Area 3 Red brick ──
    // Red (#a40000) faces, pink (#fc7460) highlights, black mortar
    PATTERNS.brickRed = [
        'KKKKKKKKKKKKKKKK',
        'RRRRRRKRRRRRRKRR',
        'RRRPRRKRRRRPRKRR',
        'RRRRRRKRRRRRRKRR',
        'KKKKKKKKKKKKKKKK',
        'RRKRRRRRRRKRRRRR',
        'RRKRRRRPRRKRRRRP',
        'RRKRRRRRRRKRRRRR',
        'KKKKKKKKKKKKKKKK',
        'RRRRRRKRRRRRRKRR',
        'RRRPRRKRRRRPRKRR',
        'RRRRRRKRRRRRRKRR',
        'KKKKKKKKKKKKKKKK',
        'RRKRRRRRRRKRRRRR',
        'RRKRRRRPRRKRRRRP',
        'RRKRRRRRRRKRRRRR'
    ];
    PATTERNS.brickRedAlt = [
        'KKKKKKKKKKKKKKKK',
        'DRRRDKDRRRRRKDRR',
        'DRRRDKDRRPRRKDRR',
        'DRRRDKDRRRRRKDRR',
        'KKKKKKKKKKKKKKKK',
        'RRKDRRRRRKDRRRRR',
        'RRKDRRRRRKDRRRRP',
        'RRKDRRRRRKDRRRRR',
        'KKKKKKKKKKKKKKKK',
        'DRRRDKDRRRRRKDRR',
        'DRRRDKDRRPRRKDRR',
        'DRRRDKDRRRRRKDRR',
        'KKKKKKKKKKKKKKKK',
        'RRKDRRRRRKDRRRRR',
        'RRKDRRRRRKDRRRRP',
        'RRKDRRRRRKDRRRRR'
    ];

    // ── Sign base (8x8) ──
    PATTERNS.signBase = [
        'KKKKKKKK',
        'KLLLLLLK',
        'KLWWWWLK',
        'KLWWWWLK',
        'KLWWWWLK',
        'KLWWWWLK',
        'KLLLLLLK',
        'KKKKKKKK'
    ];

    // ── Small windows (8x8) for close-up views ──
    PATTERNS.windowDark = [
        'KKKKKKKK',
        'KNNNNNBK',
        'KNNBNBK_',
        'KNBNNBK_',
        'KNNNNBK_',
        'KNBNNBK_',
        'KNNNNBK_',
        'KKKKKKKK'
    ];
    PATTERNS.windowLit = [
        'KKKKKKKK',
        'KTTTTTK_',
        'KTTWTPK_',
        'KTWWTPK_',
        'KTTWTPK_',
        'KTWWTPK_',
        'KTTTTLK_',
        'KKKKKKKK'
    ];

    // ── Level: Sewer floor (same cobblestone as overworld) ──
    PATTERNS.sewerFloor = [
        'GWWWWGWWWWWGWWWG',
        'GWWWWGWWWWWGWWWG',
        'GLWWLGLWWWLGLWLG',
        'GGGGGGGGGGGGGGGG',
        'GGWWWWWGGWWGGWWG',
        'GGWWWWWGGWWGGWWG',
        'GGLWWWLGGLWGGLWG',
        'GGGGGGGGGGGGGGGG',
        'GWWWGGWWWWGWWWWG',
        'GWWWGGWWWWGWWWWG',
        'GLWLGGLWWLGLWWLG',
        'GGGGGGGGGGGGGGGG',
        'GGWWGGWWWWWGGWWG',
        'GGWWGGWWWWWGGWWG',
        'GGLWGGLWWWLGGLWG',
        'GGGGGGGGGGGGGGGG'
    ];
    // ── Level: Sewer wall (darker cobblestone + pipe band from sewer_tile_2.png) ──
    PATTERNS.sewerWall = [
        'DDDDDDDDDDDDDDDD',
        'MMMMMMMMMMMMMMMM',
        'DDDDDDDDDDDDDDDD',
        'KKKKKKKKKKKKKKKK',
        'GLLLGLLLLGLLLLGG',
        'GLLLGLLLLGLLLLGG',
        'GGGGGGGGGGGGGGGG',
        'GGLLLGGLLLGGLLLG',
        'GGLLLGGLLLGGLLLG',
        'GGGGGGGGGGGGGGGG',
        'GLLLGLLLLGLLLLGG',
        'GLLLGLLLLGLLLLGG',
        'GGGGGGGGGGGGGGGG',
        'GGLLLGGLLLGGLLLG',
        'GGLLLGGLLLGGLLLG',
        'GGGGGGGGGGGGGGGG'
    ];

    // ── Level: Street floor (same cobblestone) ──
    PATTERNS.streetFloor = [
        'GWWWWGWWWWWGWWWG',
        'GWWWWGWWWWWGWWWG',
        'GLWWLGLWWWLGLWLG',
        'GGGGGGGGGGGGGGGG',
        'GGWWWWWGGWWGGWWG',
        'GGWWWWWGGWWGGWWG',
        'GGLWWWLGGLWGGLWG',
        'GGGGGGGGGGGGGGGG',
        'GWWWGGWWWWGWWWWG',
        'GWWWGGWWWWGWWWWG',
        'GLWLGGLWWLGLWWLG',
        'GGGGGGGGGGGGGGGG',
        'GGWWGGWWWWWGGWWG',
        'GGWWGGWWWWWGGWWG',
        'GGLWGGLWWWLGGLWG',
        'GGGGGGGGGGGGGGGG'
    ];
    // ── Level: Street wall (Area 3 red brick) ──
    PATTERNS.streetWall = [
        'KKKKKKKKKKKKKKKK',
        'RRRRRRKRRRRRRKRR',
        'RRRPRRKRRRRPRKRR',
        'RRRRRRKRRRRRRKRR',
        'KKKKKKKKKKKKKKKK',
        'RRKRRRRRRRKRRRRR',
        'RRKRRRRPRRKRRRRP',
        'RRKRRRRRRRKRRRRR',
        'KKKKKKKKKKKKKKKK',
        'RRRRRRKRRRRRRKRR',
        'RRRPRRKRRRRPRKRR',
        'RRRRRRKRRRRRRKRR',
        'KKKKKKKKKKKKKKKK',
        'RRKRRRRRRRKRRRRR',
        'RRKRRRRPRRKRRRRP',
        'RRKRRRRRRRKRRRRR'
    ];

    // ── Level: Dock floor (wood planks - tan with brown grain) ──
    PATTERNS.dockFloor = [
        'TTTTTTTTTTTTTTTT',
        'TMTTTMTTTMTTTMTT',
        'TTTTTTTTTTTTTTTT',
        'KKKKKKKKKKKKKKKK',
        'TTTTTTTTTTTTTTTT',
        'TTTMTTTMTTTMTTTT',
        'TTTTTTTTTTTTTTTT',
        'KKKKKKKKKKKKKKKK',
        'TTTTTTTTTTTTTTTT',
        'TMTTTMTTTMTTTMTT',
        'TTTTTTTTTTTTTTTT',
        'KKKKKKKKKKKKKKKK',
        'TTTTTTTTTTTTTTTT',
        'TTTMTTTMTTTMTTTT',
        'TTTTTTTTTTTTTTTT',
        'KKKKKKKKKKKKKKKK'
    ];
    // ── Level: Dock wall (lighter weathered stone) ──
    PATTERNS.dockWall = [
        'GLLLGLLLLGLLLLGG',
        'GLLLGLLLLGLLLLGG',
        'GGGGGGGGGGGGGGGG',
        'GGLLLGGLLLGGLLLG',
        'GGLLLGGLLLGGLLLG',
        'GGGGGGGGGGGGGGGG',
        'GLLLGLLLLGLLLLGG',
        'GLLLGLLLLGLLLLGG',
        'GGGGGGGGGGGGGGGG',
        'GGLLLGGLLLGGLLLG',
        'GGLLLGGLLLGGLLLG',
        'GGGGGGGGGGGGGGGG',
        'GLLLGLLLLGLLLLGG',
        'GLLLGLLLLGLLLLGG',
        'GGGGGGGGGGGGGGGG',
        'KKKKKKKKKKKKKKKK'
    ];

    // ── Level: Gallery floor (checkerboard white + light gray) ──
    PATTERNS.galleryFloor = [
        'WWWWWWWWLLLLLLLL',
        'WWWWWWWWLLLLLLLL',
        'WWWWWWWWLLLLLLLL',
        'WWWWWWWWLLLLLLLL',
        'WWWWWWWWLLLLLLLL',
        'WWWWWWWWLLLLLLLL',
        'WWWWWWWWLLLLLLLL',
        'WWWWWWWWLLLLLLLL',
        'LLLLLLLLWWWWWWWW',
        'LLLLLLLLWWWWWWWW',
        'LLLLLLLLWWWWWWWW',
        'LLLLLLLLWWWWWWWW',
        'LLLLLLLLWWWWWWWW',
        'LLLLLLLLWWWWWWWW',
        'LLLLLLLLWWWWWWWW',
        'LLLLLLLLWWWWWWWW'
    ];
    // ── Level: Gallery wall (clean white with subtle frame) ──
    PATTERNS.galleryWall = [
        'KKKKKKKKKKKKKKKK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KWWWWWWWWWWWWWWK',
        'KLLLLLLLLLLLLLLK',
        'KGGGGGGGGGGGGGGK',
        'KKKKKKKKKKKKKKKK'
    ];

    // ── Coast (sand to water transition) ──
    PATTERNS.coastFallback = [
        'VVVVVVVVBBBBBBBB',
        'VVVVVVVUBBBBBBBB',
        'VVVVVVUUBBCBBBBB',
        'VVVVVUUUBBBBBBBB',
        'VVVVUUUUBBBCBBBB',
        'VVVUUUUUBBBBBBBB',
        'VVUUUUUUBBBBBBBB',
        'VUUUUUUUBBCBBBBB',
        'UUUUUUUUBBBBBBBB',
        'UUUUUUUUBBBCBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBCBBBBBBBBBBBBB',
        'BBBBBBBBBCBBBBBB',
        'BBBBBBBBBBBBBBBB',
        'BBBBBCBBBBBBCBBB',
        'BBBBBBBBBBBBBBBB'
    ];

    // ── Asia-specific landmark patterns (16x16) ──
    PATTERNS.pagoda = [
        '______RR________',
        '_____RRRR_______',
        '____RRRRRR______',
        '___DRDDDDRD_____',
        '____LLLLLL______',
        '_____KLLK_______',
        '___DRDDDDRDD____',
        '____LLLLLLLL____',
        '_____KLLLLK_____',
        '___DRDDDDDDRD___',
        '____LLLLLLLL____',
        '______KLLK______',
        '_____LLLLLL_____',
        '_____LLKKLL_____',
        '____LLLLLLLL____',
        '____GGGGGGGG____'
    ];
    PATTERNS.torii = [
        '____R______R____',
        '___RR______RR___',
        'RRRRRRRRRRRRRRRR',
        'DRRRRRRRRRRRRRRR',
        '___RR______RR___',
        '___RRRRRRRRRR___',
        '___DRRRRRRRRD___',
        '___RR______RR___',
        '___RR______RR___',
        '___RR______RR___',
        '___RR______RR___',
        '___RR______RR___',
        '___RR______RR___',
        '___DD______DD___',
        '___GG______GG___',
        '___GG______GG___'
    ];
    PATTERNS.minaret = [
        '_______OO_______',
        '______OLLO______',
        '______LLLL______',
        '_____LLLLLL_____',
        '_____LGLLGL_____',
        '____LLLLLLLL____',
        '____LWLLLLWL____',
        '____LLLLLLLL____',
        '_____LGLLGL_____',
        '_____LLLLLL_____',
        '____LLLLLLLL____',
        '____LWLLLLWL____',
        '____LLLLLLLL____',
        '___LLLLLLLLLL___',
        '___LLKKKKKLLK___',
        '___GGGGGGGGGG___'
    ];

    // ── Statue of Liberty (16x32 landmark sprite) ──
    PATTERNS.statueOfLiberty = [
        '_______________O________________',
        '______________OYO_______________',
        '______________YYY_______________',
        '_____________OYYO_______________',
        '_____________xYOx_______________',
        '______________xO________________',
        '_________g____gf________________',
        '________gZg__gZg________________',
        '________fZf_gZZg________________',
        '_________gZgZZf_________________',
        '_______g_gZZZg__________________',
        '______gZggZZZg__g_______________',
        '______gZZZZZZg_gZg______________',
        '_______gZZZZZggZZg______________',
        '________gZZZZZZZg_______________',
        '________gZZZZZZZg_______________',
        '________gZrZrZrZg_______________',
        '________grGaGaGrg_______________',
        '_________gGiLiGg________________',
        '_________gGLWLGg________________',
        '_________grLiLrg________________',
        '_________grGaGrg________________',
        '_________gZrZrZg________________',
        '_________gZZZZZg________________',
        '_______ggZZZZZZZg_______________',
        '______gZZZZZZZZZgg______________',
        '______grZZZrZZZrrg______________',
        '_______gZZZZZZZZg_______________',
        '________gZZrZZZg________________',
        '________gZZZrZZgg_______________',
        '________grZZZZZrg_______________',
        '________gZZZZZZZg_______________',
        '________gZZrZrZZg_______________',
        '________gZZZZZZZg_______________',
        '________grZZZZZrg_______________',
        '_______gZZZZZZZZZg______________',
        '_______gZrZZZZZrZg______________',
        '________gZZZZZZZg_______________',
        '________grZZrZZrg_______________',
        '________gZZZZZZZg_______________',
        '________gZZrZrZZg_______________',
        '_______gZZZZZZZZZg______________',
        '_______grZZZZZZZrg______________',
        '______gZZZZZZZZZZZg_____________',
        '______grZZrZZZrZZrg_____________',
        '_____gZZZZZZZZZZZZZg____________',
        '_____grZZZZZrZZZZZrg____________',
        '____gZZZZZZZZZZZZZZZg___________',
        '____grrrrrrrrrrrrrrrgU__________',
        '____UaiiiiiiiiiiiiiiaUU_________',
        '_____UaLLLLLLLLLLLaUU__________',
        '______UUaiiiiiiiiaUU___________',
        '_______UUaLLLLaUUU_____________',
        '_______UUUUaaUUUU______________',
        '________UUUUUUUU______________',
        '_______UUUUUUUUUUU_____________',
        '______UUaLLLLLLLLaUU___________',
        '_____UUaiiiiiiiiiiiiiaUU________',
        '_____UaLLLLLLLLLLLLLLaU________',
        '____UUaiiiiiiiiiiiiiiiiaUU______',
        '____UaLLLLLLLLLLLLLLLLLaU______',
        '___UUUUUUUUUUUUUUUUUUUUUaU_____',
        '___UaaaaaaaaaaaaaaaaaaaaaaU_____',
        '___UUUUUUUUUUUUUUUUUUUUUUU_____'
    ];

    // ── Mall building (48x24, sign area blank for custom text) ──
    PATTERNS.mallBuilding = [
        '___aaaaaaaaaaGGGGaGGaGGaGGaGaaGGaaaaaaaaaaaaG___',
        '_aGaaa0aaLLL0G0aa0aa0aG0aa0aa0aa0GG0LLLLGGaLaGa_',
        '_LLLLLaaaiiiaLaLLaLLaLLaLLaLLaLLaLL0LiiLaaaiaaLG',
        '0LiLLa000iiiaaaLLaLLaLLaLLaLLaLLaaL0aiia000iaaL0',
        'gLiLLL00GiiiaGNaaNaaNaaNaaNaaNaaNaa0aLiL00GiaaLg',
        '0LiLLiLLiiiia00000000G00G00000000000aiiiLLiiaaL0',
        'gLiLLiiiiiiiiLLLLLLLLLLLLLLLLLLLLLLiiiiiiiiiaaL0',
        'gLiLLiiiiiiiiiLaLLLLLLLLLLLLLLLLaaiiiiiiiiiiaaL0',
        'gLiLLiLaLLiiiiaa0000G0GG0G00G000a0LiiiLaaLiiaaL0',
        'gLiLLiaaaaiiiia0gGGGGGGGGGGGGGgG0LiiiLaL0LiaaG',
        'gLiLLi0000iiiiaGgGGGGGGGGG00G00gG0LiLia000LiaaL0',
        '0LiLLia00aiiiiLGgGGGGGGGGGGGGGGgG0Liiia000LiaaL0',
        'gLiLLiLLLiiLiiaGaGGaGGGGGGGaGGGaa0LiLLiLLLiiaaL0',
        'gLiLLiiiiiiiiiLGGGGGGGGGGGGGGGG00aLiiLiiiiiiaaL0',
        '0LiLLiLLLLLLiLiiiLiiiiiiiiiiiLLLiiLLLLLLLLLiaaL0',
        'gLiLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLaaL0',
        'gLiaGG0GGGGGGGGGGaLLLLLLLLLLLLG0G0GGGGG0GGGG0aLg',
        'gLiLassssssssZsCs0LaaaaaaaaaaL0sZssssssssssaaLL0',
        'gLLLZCCCCCCCCCCCsGLth0h00h0htLGsCCCCCCCCCCCCLaLg',
        'gaa0ghhhhhhhhhhhhaLhsasaasashLahhhhhhhhhhhhh0aLg',
        'gLLLhhhh00hh0ahhaLLgaaGaaGaa0La0hhahhhG0hhhhLLLg',
        'gaaG0aaaaaaaaaGG0aL0LLLLLLLLaLa0aaaGaaaaaaaGGGag',
        '0000GGGGGGGGGGG00GaLiLLiiLLLLLG0GGGGGGGGGGGGG0G0',
        'g0000000000000000000000000000000000000000000000g'
    ];

    // ── Empire State Building (24x59) ──
    PATTERNS.empireState = [
        '___________t____________',
        '___________gg___________',
        '___________00___________',
        '___________00___________',
        '___________00___________',
        '__________g00t__________',
        '__________0aa0__________',
        '__________0aa0__________',
        '__________0GG0__________',
        '_________0Laaag_________',
        '________gaGGGG0t________',
        '_______t0aGGaGGg________',
        '_______0LaaaaaaL0_______',
        '_______0LGaaaaaag_______',
        '_______Gaa0GG0aa0_______',
        '______tLLL0000LLL_______',
        '______tLaa0000aaa_______',
        '______tLaa0000Laa_______',
        '______taGag000aGGt______',
        '______aLLL0g0aLLLG______',
        '______aaGaGg0aaaaa______',
        '______aaGa000aaaaG______',
        '______aaaa000aaaaa______',
        '______aaGa000aaaaG______',
        '______aaGa000aaaaG______',
        '______aaGa000aaaaG______',
        '______aaGa000aaaaG______',
        '______aaGa000aaaaG______',
        '______aaGa000aaaaG______',
        '______aaGa000aaaaG______',
        '______aaGa000aaaaG______',
        '______aaGa000GaaaG______',
        '______aaGa000aaaaG______',
        '______aaGa000GaaaG______',
        '______aaGa000GaaaG______',
        '______aaGa000aaaaG______',
        '______aaGa000GaaaG______',
        '______aaGa000aaaaG______',
        '______aaGa0g0aaaaG______',
        '______aaGa000aaaaa______',
        '_____0aaGaaaaaaaaa0_____',
        '____t0aaGaaaGaaaaG0_____',
        '____0tGG0GaaGa0GG00____',
        '____aaLaLG0GGGGLLLGG___',
        '__ggGGaGaG0G00aaaaG0tg_',
        '__0LaGaaaG0000aaaaGaL0_',
        '__0L00aaaGg000aaaa00a0_',
        '__0a00aGaGg000aaGa00a0_',
        '__0a00aGaGg000aaaa00a0_',
        '__0a00aGaGg000aaGa00a0_',
        '__0a00aGaGg000aaGa00a0_',
        '_g0a0GaaLG0000aaaa00a0g',
        'tG00g000G0tggt0G000g00G',
        'tLLaaaaaaaaaaaGaaaaaLLt',
        'tLaaaaaaa0Gaa0Gaaaaaa0t',
        'ta0000G0G000000a00000Gt',
        '000000000000000000000000',
        '0LLaaLaLLLLLLLLaLLaLLL0',
        'Kg0g00000000000000000gtt'
    ];

    // ── Fast Food building (48x28, sign area blank) ──
    PATTERNS.fastFood = [
        '_____________________IU__UI_____________________',
        '____________________YpYdUYpY____________________',
        '___________________UY0IyyIGYU___________________',
        '___________________IIiaYYaiYI___________________',
        '___________________YUWL9YaiIY___________________',
        '__________________qYI_LYYa_IYd__________________',
        '__________________UYUiaYYGiUYd__________________',
        '____G000000000000cKKdKcKKcKdKcd000000000000G____',
        '_00GLLLLaLGaLLLLacKKKKKKKKKKKdaLLLLLLLLGLLLG00',
        '_LLaaiiaGa0aiiiiLtdKKKKKKddKKdtGLiiiiaaG0LiGaL',
        'ULiaaLia000aiiiiLgghghggggggggtGaiiii0000LiL0Lit',
        'ULiaaiiLLaaLiiiiiLLLLLLLLLLLLLLLLiiiiLaaLLiLGLLd',
        'ULiaaiLiiiiLiLaLaaLLaaLaaaaaaLaaLaLiLiiiiLiLGLLt',
        'ULiaaiiLaLLLiaItIUUUUIUUUUUUUUUUdI0LiLaLLiiLGLLt',
        'ULiaaiiaaL0LiIUtIIUUIOUUUIUIOtIItU0LiaLL0LiLGLLt',
        'ULiaaiia000aiIUtpUdcdddUUpddMtdptU0Li0000LiLGLLt',
        'ULiaaiia000LiGI000000000000000G00I0Lia000LiLGLLt',
        'ULiaaiLLLLLiia000000000000000000000LiLLLLLiLGLLt',
        'ULiaLiiiiiiiiiiiiiLLiiLLiiLiiLiLiiiiiLiiiiLiaLLt',
        'ULiGI9II9IIIIIII9ILLLLLLLLLLLLI9II9IIIIIIIII0LLt',
        'ULiIX8XO8XOYXYYX8MLiiiiiiiiiiaM8XO8XYYXYOX8OULLt',
        'dIIUXYXXYXOYXYOXYM000000000000MYXXYXOYXYOXYXcIIt',
        'dUUUtdtdUtdddddtddL0h0ha0hGhaLddttUdddtUdtddUUUt',
        '0iiLhNs0GhsNG0Nhh0L0h0haGNGhaL0hhssGNshGNsh0LiLt',
        '0GGG000GG000GG0YYUL00G0aGGG0aaUYy0GG000G0000GGGt',
        '0000GGGGGGGGGG0yUq00aLLLLLLLG0UIUg0GGGGGGGGG00G0',
        '0aaGaGaGaGaGaGaUUaGaLLLLLLLLLaIUUa0GaaGaaGaaaaa0',
        '_____________tGaaG0aaaaaaaaaa0GGa0t_____________'
    ];

    // ── Pizza restaurant (40x28, sign area blank) ──
    PATTERNS.pizzaPlace = [
        '___________idcccccccccccccct____________',
        '___________LDXXXXXXXXXXXXXXtL__________',
        '___________acccccccccccccccdG___________',
        '___________UdG00ggggt000gg0t0___________',
        '__________icU9IIIIIIU0IIIIItti__________',
        '__________LRdU0IIIIIU0UIIUUtDL__________',
        '_________LUcdtdddddddddtddddDtL________',
        '_____iLGcFcMcccccccccccccccccDDd0L______',
        '___LGcFFXXdDDDDDDDDDDDDDDDDDtDcDDdGL___',
        '__aRXXXXXXnFFFFFFFFFFFFFFFFFFFcDcFRDa__',
        '__UXXXXXXnXXXXXXXXXXXXXXXXXXXXcDcccRd__',
        '_LFXXXXnXXXXXXXXXXXXXXXXXXXXXXXFDcccDL_',
        '_GFXXXnXXXXXXXXXXXXXXXXXXXXXXXXXMcDcDG_',
        'icXXnnXXXXXXXXXXXXXXXXXXXXXXXXXXXMcDFdi',
        'LFXnXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXFcDL',
        'UXnXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXMR0',
        'cnXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXD',
        'tDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDt',
        '_aaaGGGGGGGGG0aa0GGGGGG0aa0GGGGGGaaaa0i',
        '_a_ahhhhhGhhhhLLg0000000LLghhhGhhhhhaLa_',
        '_aiasssssassshhL0hhaahh0LihsssLsssssaia_',
        '_aLasssssasCBshL0sBuassaLihBsBLsssssakLa',
        'L0LaauuuuLG000LL0auLLau0LLh00GLauuuuL0L',
        'a0iLi11LiiayygiiLgaLaaLa0Li09yLiiLLiii0a',
        'aG000000000qqtaGhGaaaaaGGa0qfg00000000Ga',
        'aLLLLLLLLLIdd000aaaaaaaa00Idd0aLLLLLLLLa',
        'aaaaaaaaaaaaaa0LiiiiiiiiiLaaaa0Laaaaaa0a',
        'a0000000000000t0000000000g0000g00000000a'
    ];

    // ── Shop / Retail storefront (36x24) ──
    PATTERNS.shopBuilding = [ '____aaaaaGaaaaaaaaaaaaaaGaaaaaaL____','_000aLLLLLiLaLLLLLLLLLLLLiiaLLLL000_','_aLaaLiiaaaa0Liiiiiiiiiaaaa0LiiL0LL_','_aiLaLiiG000aiiiiiiiiiia0000LiiLGiL_','daiLaLiiiLLaaaLLaLLaLLaaaaLLiiiLGLLd','daiLaLiLiiIoooOMoOOoMpoooUiiiiiLGiLd','daiLLLiiiiUddUUUdddIdUUddULiiiiiGLLd','daiLLLLLLLUtgYUUIIUIUIYgtdGLLLLL0LLd','daiLLLLLLLUttUpUUpUUUpUttd0LLLLL0LLd','daiL000000ddtUddtddUddttdd000000GiLd','daaaaaaaaadccdddcdddUdcUcd0aaaaaaaad','dMoOYMYYMYOMYOOYMOYMYOMYMOYMOYMYOoMd','DMOx8O88O8YO8OO8OY8O8YO8OY8Ox8O8xOMD','DMXYYXYYXYOXYOOYXYYXYOXYOOYXYYXYYXMD','_dcccDccDUccMccUcUUcMccUdcUDccDcccd_','_LGhhhhhhhhtGLgh0000h0LGghhhhhhhh0a_','_LaGaassssaGaL0hhaahhGiahsssssaasaL_','_LassuLssGGGai00saass0ia00GaGhZssaL_','tLaGaaaaaG00Li00saas0Giah00aaaaaaaLt','0LLiiii5LyyULi0aLaaLa0iLIYUaiiiiiiL0','0G0GGGGG0UUq000GGGGGG000UIqg00GGGGG0','aLaaaaaaaUdd00aaaaaaaa0aUdd0Gaaaaaaa','0LLLaLLLaLaLaaLLLLLLLLLLLLLaGLLLLLLG','ttttttttg0000Gaaaaaaaaa0000ttttttttt' ];

    // ── Medium Apartment (28x36) ──
    PATTERNS.aptMedBuilding = [ '___0aaa0aGGaaaaaaa000Gaa0___','_aaaLLLLiaaLLLLLLLaLLaLLaGa_','_aaaLia0G00LLLLLiLGaG0LiaaL_','gaLLLLa000GLLLLLLL0000LLaaLt','0LLLLLLLLLLiiLLLLLLLLiLiaaLg','0LLaaaaaaaaaaaaaaaaaaaaLGaLg','0aLaLLLLLLLLLLLLLLLLLLLLaaLg','0aLaaaaaaaaaaaaaaaaaaaaa0aLg','0LLaGaGGGGGGaaGaaaGGGaaGaLLg','0aaaaaaaaaaaaaaaaaaaaaaaaaa0','t0g00000000g000000000000g00t','_UUIaGaIIaGaIIIIaaaIIaGaIUU_','_IUIGaaIxaGaaxxaGaaIIaaaIIU_','_UUIaaaIIaaaaIIaaaaIIaaaIUU_','_UUIaaaIIaaaaIxaaaaIIaaaIUU_','_IUIaIGIIaGaGIxIGIGIIaIaUUU_','_IUIIIIIIIIIIIIIIIIIIIIIIIU_','_UUIGGaIIa0GaIxaGGaIIaGaIUU_','_IUIaaaIIaaaaIxaaaaIIaaaIIU_','_IUIaaaIIaaaaIIaaaaIIaaaIUU_','_UUIaaaIIaaaGIIIaaaIIaaaUUU_','_UUIIIIIIIIIIIIIIIIIIIIIIUU_','_UUIGGaIIaGGaIIaGGaIIaGaIUU_','_IUIaaaIIaaaaxxaaaaIIaaaIII_','_UUIaaaIIaaaaIxaaaaIIaaaIUU_','_UUUGGGUIGGG0IIUGGGUIGGaUUU_','_aaaaaaaaGLaLLLLaL0aaaaaaaa_','_0GGGGGG0GLLLLLLLLG0GGGGGGGg','_Udhhhhh00a000000a00hhhhh0U_','_IU0sas0LLi0gaGh0iaa0sss0UU_','tIUh0000aai0haahGiaa00000IUt','gUULLLLaYUL00Laa0LII0LLLLIUg','0U0aaaaIIq00GGGa0aIIqaaaa0Ug','GaaGGGGGUU0GaaaaGGGU00GGGGa0','GLLLLLaLLL0aaaaaaaLLL0LaLaLG','tgtgggt0000GGGGGG0000ttttttt' ];

    // ── Warehouse (40x24) ──
    PATTERNS.warehouseBuilding = [ '__________________aa00__________________','______________aLLiiL0LaaG0______________','__________aLLiiiiiiL0LLLLLaaaG______00__','_____0aLLiiiiiiiiiiL0LLLLLLLLLLaG000ag__','_aaLLLLLaaLiiiiiiiiL0LLLLLLLLLLaaaaaa00_','aiiiia00a0aiiiiiiiiL0LLLLLLLLLLGa00aG0a0','aiiiia0000LiiiiiiiLa0aLLLLLLLLL000GaGGa0','aiiiiiLLLiiiiiLaa000000GaLLLLLLLLLLLLLa0','aiiiiiiiiiLaG0000aLLLLaG000GaLLLLLLLLLL0','aiiiiLLaG0000dUUUUUUUUUUUUd00000aLLLLLL0','aLLa0000aaLLGUIIIIIUIIIUIIU0LLLaG000aaL0','0000aLLLLLLLGUIUUUUUUUUUUIU0LLLLLLLaG00g','gLaLLLLLLLLLGddddddddddUddd0LLLLLLLLLLag','ta0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaGt','dU0LLLLLLLLaaaaaaaaaaaLLaaaaaaaaaaaLLaUt','dU0LLLLLLLL00GGGGGGG0aLag0GGGGGG00aLLaUt','UU0LLG00LLLGaLLLLLLLaaLL0aLLLLLLLaLLLaUt','tU0aLGg0LLL0GLLLLLLLaaLL0aLLLLLLLaLLLaUt','gUUU0Gg0LLL0aLLLLLLLaaLa0aLLLLLLLaaLaUUt','0UUU0000aIU00GGGGaGG0GI000GGGGGGG0aIUUdt','UUUUtg0000dg0U00000000Ug00000000000UdUUd','dUddt000G000GGGGGGGGGG00GGGGGGGGGG00Uddd','00000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000','ggggggggggggggggggg00ggggggggggggggggggg' ];

    // ── Small Apartment / Duplex (36x24) ──
    PATTERNS.aptSmallBuilding = [ '________________0G0g________________','____________00Gaaa000000g___________','_____0aG0GGGaaaaaa00000000000__0a0__','__0GG0aGgaG0aaaaaa00000000000000L0g_','0aaaaG000000aaaaaa00000000000000L00g','0aaaaaaaaaaaaaaaG000000000000000a00g','0aaaGaaaaaaG00000000000000G00000000g','0aaaaaaG00000GaLiiiLLaG000000000000g','0aG000g000GaaaaaaaaaaaaaaG000g000000','tgtUU000IIIa00GIIIIIIG00GIII000Udtgt','_UIIIGaaIxIaGaaIIIIxIaaaaIIIGaaIIIUK','_UIII000IIIaGGaIIIIIIG0GaIII00GUIUU_','_UUU00U0ggIaaaGIIIIIIaaaGIUqU0qgUUU_','_UUU00000gIIIIIIIIIIIIIIII00000tUIU_','_aa0GGGaaaaLiLLLLLLLLLLLaGaGGGGaGaG_','_I0UIIIIIIIaaaaaaaaaaaaa0UIUIIIIII0_','_UUI00000GII0ggg0000gg0GIIG00000IUUt','_UUIaaGaaGI9a000aLLG0h0L9IGaaGaaIUU_','tUUUaGaGGGIIa0h0aaaG00GLIIaGaaGaIUUK','tUUUIIIIIIIUG000aaLG00GaII0UIIIIUIUt','g00000000UUfgGaaaaa0aaa0UUgg0000000t','000000000aU00aaaG000aaaaaUG000000000','aLaaaaaaaLLL0aaaaaaaaLLLLLa0aLaaaaLG','ggtgtgtgtgggt00000000000gggtgggtttgt' ];

    // ── Tall Apartment / High-rise (20x48) ──
    PATTERNS.aptTallBuilding = [ '____GGGa0__0GGG0____','__GGGLLL0000LLL000__','__a0g000gaa0000g0Gt_','_taaGGGGGaaaGGa0Gat_','_taLaLLLLaaaaaaaLat_','_t0000000000000000t_','__gUd0000U00000dUt__','__UIUaGGaIIaaaaUIU__','__UIUaGGaIIaaGaIIU__','__UIUa00aIIGG0aUIU__','__UI0aaaaIIaaaaUIU__','__0I0G000GIGGG00I0__','__0aGaaaaaaaaaaGaG__','__UIUaGGaIIaGGaUIU__','__UIUaGaaIIaaaaIIU__','__UIUaGGaIIGGGaIIU__','__UI0aaaaIIaaaaUIU__','__0I0GGG0GGGGG00I0__','__0aGaaaaaaaaaaGa0__','__UIUaGGaIIa0GaUIU__','__UIUaGGaIIaaGaUIU__','__UIUa0GaIIGG0aUIU__','__UI0aaaaIIaaaaUIU__','__UU0G0000G00000IU__','__GaGaaaaaaaaaaGaG__','__UIUaaaaIIaaaaUIU__','__UIUaGGaIIaGGaIIU__','__UIUaGaaIIGaGaIIU__','__UI0aaaaIIaaaaUIU__','__UI0GGGGUUGGG0UIU__','__Ga0aaaaaaaaaaGaG__','__UUUaGGaIIaGGaUIU__','__UIUa0GaIIaGGaUIU__','__UIUaGaaIIGaGaUIU__','__UIUaGGaIIaGGaUIU__','__UUdGGGGUUGGG0UIU__','__aaaaaaaaaaaaaaaa__','__aLLaLLLLLLLLaLLa__','__UUU0000000000UIU__','__IIIaGgg0GhgGaIIU__','_KIIIaG0h0ah0aaUIU__','t00IUaG0h0ah0aaUUdgt','tggIU00aG0GaG00IIttt','t00dt00aaaGaa0GUd00t','g0aaaa0aaaaGa0aaaa0g','0aaaaGGaaaaaaaaaaaG0','0aaaaaaaaaaaaaaaaaa0','tttttttttttttttttttt' ];

    // ── Chrysler Building landmark (24x63) ──
    PATTERNS.chryslerBuilding = [ '___________t____________','___________t____________','___________t____________','___________tt___________','___________00___________','___________00___________','___________G0___________','___________G0___________','__________gL0t__________','__________0a0t__________','__________aLa0t_________','_________giaaat_________','_________0iLLag_________','_________aiaaa0_________','________gaLLLaGt________','________0iLaaaag________','________aLaLLGa0________','_______gLLLaaaa0t_______','______gaLLaLaGa00t______','______0LLaLaaa000t______','______0LLaLGGaG00t______','______0LLaLaaaG00t______','______0LLaLGaaG00t______','_____t0GaaLGGa000g______','______GGGaLGGaa000______','______La0aaaaaahaa______','______LaaLaaaaLaaG______','______aaaLaaaaLaaa______','______LaaLaaaaLaaa______','______LaaLaaaaLaaa______','______LaaLaaaaLaaG______','______LaaLaaaaLaaa______','______LaaLaaaaLaaa______','______LaaLaaaaLaaa______','______LaaLaaaaLaaa______','______LaaLaaaaLaaG______','______aaaLaaaaLaaa______','______aaaLaaaaLaaG______','______LaaLaaaaLaaG______','______LaaLaaaaLaaG______','______LaaLaaaaLaaG______','______LaaLaaaaLaaG______','______LaaLaaaaLaaG______','____K0LaaLaaaaLaaat_____','____0aaaaLaaaaLaaa00____','____aaGaaLaaaaLaaa00____','___gaLLGaLaaaaLaaL00t___','___GaaaaaaaGaaLaaa0GG___','__giiLLiL0aGaaaLiLLiLg__','__0LLLLLa0aGaaaaLLLLLg__','__0LLLLLa0aGGaaaLLLLLg__','__gLLLLLa0GGGaaaLLLLLt__','_t0LLLLLa0GGGaaaLLLLL0t_','_0aLLLLLa0GGGaaaLLLLaGg_','_gaLLLLLa0G0GGaaLLLLa0t_','_gGLLLLLa0aGGGaaLLLLa0g_','_aGLLLLLa000000aLLLLa0G_','_aaaaaaaG000000GaaaaGaa_','_Gaaaaaaa0a0GG0aaaaaaaG_','taaaaaLaaK0g0htaaaaaaaat','0G0000000GaaaaG0000000ag','0aaaaaaaaaaaaaaaaaaGaaa0','tgggtggtgtgggttgttgtgttt' ];

    // ── Gas Station (48x20) ──
    PATTERNS.gasStation = [ '_______________________________IU_______________','______________________________U8Y_______________','_________________________G0000KKK00000000000000_','________________________aaaLLL0KKGLaaLaLaaaaaaL_','___Ga0aa0_______________GLiaKKKKKKIIIIIIIIUILiLG','_aa0G0GG0aaaaaaaaaaaaaaaaLiatKKKKgKKKKKKKKKdLiLa','_aLa0000aLLLLLiiiLLiLLLLaLiatKKKKtKdKKdKKKKdLiLa','_aLLLLLLLLLLLLLLLLLLLLLaaLLUddddddddddddddddGLLa','_LLLa0G0GGG00G0G0GaLLLLaMMMMMMMMMMMMMMMMMMMMMMPM','_MMMUUUUUUUUUUUUUUMMMMMUUUUUIIIIIIIIIIIIIIIUUUIU','_YYYpdUUUdddUdUUUdpYYYYptg0K_______________tht__','_ddddUUdddUUUUdddUdddddd0aat_______________0aa__','_Lahh0h0x00000aahhhhh0LG00LtUIIU______UIII_0La__','_La0sssG90hG00LahsassGiaaGLtUIIU______UIIU_0La__','tLah00h0iGha00Lah000h0iaaGLt00G0______00G0K0La__','0LaaLaIIaG0a00aIy0aLLaLaG0Lg0000h0ggh000000taLt_','000000Uqg0aaaa0UUq00G0G000UUUG0dhsgggUU0GdUgUIg_','00000GIU00aaaaaaUG000000GadUdUUthZg00UdUUtUUUUg_','aLLLLLLLaaaaaaaLLLaLLLLLLLaaaaaLaaaLLaaLaLaaLL0_','0000000000000000000000000000000000000000000000g_' ];

    // ── Mountain ──
    PATTERNS.mountain = [
        'GGGGGGGGGGGGGGGG',
        'GGGGGGGWGGGGGGGG',
        'GGGGGGWWGGGGGGLG',
        'GGGGGWWWLGGGGLLG',
        'GGGGWWWWLLGGLLLG',
        'GGGWWWWWLLLLLLGG',
        'GGWWWWWWWLLLLLGG',
        'GWWWWWLWWWLLLLGG',
        'GWWWWLLWWWLLLGGG',
        'GLLLLLLLLLLLLGGG',
        'GLLLLLLLLLLLGGGG',
        'GGLLLLLLLLGGGGGG',
        'GGGGLLLLLLGGGGGG',
        'GGGGGGLLGGGGGGGG',
        'GGGGGGGGGGGGGGGG',
        'GGGGGGGGGGGGGGGG'
    ];

    // ── Land (cobblestone — the TMNT overworld is all stone) ──
    PATTERNS.land = [
        'GWWWWGWWWWWGWWWG',
        'GWWWWGWWWWWGWWWG',
        'GLWWLGLWWWLGLWLG',
        'GGGGGGGGGGGGGGGG',
        'GGWWWWWGGWWGGWWG',
        'GGWWWWWGGWWGGWWG',
        'GGLWWWLGGLWGGLWG',
        'GGGGGGGGGGGGGGGG',
        'GWWWGGWWWWGWWWWG',
        'GWWWGGWWWWGWWWWG',
        'GLWLGGLWWLGLWWLG',
        'GGGGGGGGGGGGGGGG',
        'GGWWGGWWWWWGGWWG',
        'GGWWGGWWWWWGGWWG',
        'GGLWGGLWWWLGGLWG',
        'GGGGGGGGGGGGGGGG'
    ];

    // ── SimCity-style grass: dense stippled dither with 4 green shades ──
    // V=#00a800 (base), H=#009000 (shadow), J=#30c830 (light), Q=#58d858 (highlight)
    PATTERNS.grass1 = [
        'VJVHVJVVHJVVJVHV',
        'VVHJVVJHVVJHVVJV',
        'HVVJVHVVJVVHVJVH',
        'VJHVVJVHVJHVVHVV',
        'VVVJHVVJHVVJVVJH',
        'JHVVVJVVVJHVHJVV',
        'VVJHVHVJVVVJVVHV',
        'HVVVJVVHVJHVVJVH',
        'VJHVVJHVVVVHJVVV',
        'VVVHVVVJHVJVVJHV',
        'JHVJVHVVVHVVHVVJ',
        'VVVVJVJHVVJHVJVV',
        'HVJHVVVVJVVVVHVJ',
        'VVVVHVJHVHJVJVVV',
        'VJHVVJVVHVVVHVJH',
        'HVVJHVVJVVJHVVVV'
    ];
    PATTERNS.grass2 = [
        'HVVJVVHVJHVVJVVH',
        'VVJHVJVVVVJHVJVV',
        'JVVVHVVJHVVVVHJV',
        'VHJVVJVVVJHVJVVH',
        'VVVHVVHJVVVVHVJV',
        'JVJVHVVVHJVJVVVV',
        'VHVVVJVHVVVHVJHV',
        'VVJHVVJVVJHVVVVJ',
        'HVVVJHVVHVVJVHVV',
        'VJHVVVVJVVHVVJHV',
        'VVVHVJHVJVVJVVVH',
        'JHVVVVVHVVHJVHVV',
        'VVJVHJVVJVVVVJVH',
        'HVVHVVVJHVJHVVVJ',
        'VJVVJHVVVVVHVJVV',
        'VVHVVVJHVJVVJHVV'
    ];
    PATTERNS.grass3 = [
        'VVHJVVVJHVVJHVVV',
        'JHVVJHVVVJVVVJHV',
        'VVJVVVJHVVHJVVVJ',
        'HVVHJVVVJVVVHVJV',
        'VVJVVHJVVHJVVJVV',
        'VJHVVVVHVVVJHVVH',
        'VVVJHVJVJHVVVJVV',
        'JVHVVJVVVVHJVVHV',
        'VVVVHVVJHVVVJVVJ',
        'HJVJVJVVVJVHVVHV',
        'VVVHVVHJVHVVJVVV',
        'VQHVJVVVVVJHVJHV',
        'JVVVVHJVJHVVVVVJ',
        'VVJHVVVHVVVJHVVV',
        'HVVVJVJVVJHVVJHV',
        'VJHVVHVVHVVVHVVJ'
    ];
    // Extra grass variant with slight highlight pops (Q) for sunny patches
    PATTERNS.grass4 = [
        'VJVHVJQVHJVVJVHV',
        'VVHJVVJHVVJHQVJV',
        'HVVJVHVVJVVHVJVH',
        'VJHVVJVHVJHQVHVV',
        'VQVJHVVJHVVJVVJH',
        'JHVVVJVVVJHVHJVV',
        'VVJHVHVJQVVJVVHV',
        'HVVVJVVHVJHVVJVH',
        'VJHQVJHVVVVHJVVV',
        'VVVHVVVJHVJVVJHV',
        'JHVJVHVVQHVVHVVJ',
        'VVVVJVJHVVJHVJVV',
        'HVJHVVVVJVVQVHVJ',
        'VVVVHVJHVHJVJVVV',
        'VJHQVJVVHVVVHVJH',
        'HVVJHVVJVQJHVVVV'
    ];

    // ── SimCity-style dirt: warm stippled brown with tan highlights ──
    // M=#c84c0c (brown base), U=#886830 (warm mid), O=#fc9838 (orange accent),
    // T=#fcd8a8 (tan highlight), I=#a08848 (sandy)
    PATTERNS.dirt1 = [
        'MUUMIMMUUMUUIMMU',
        'UMMUUMMIUMMUUMMM',
        'MUUMIUUMMUUIMMUU',
        'IMUUMMUUMIMUUMMU',
        'UMMIUUMMMUUMMIUM',
        'MUUMMIUMUUMIUUMM',
        'UUMMUUMMIMUUMMIU',
        'MIUUMMUUMUUIMMUM',
        'UMMUIMUUMIUUMMMU',
        'MUUMMMUUMUUMMIUM',
        'UIMUUMMIUUMIUUMM',
        'MUUMIUUMMUUMMUUI',
        'UMMUUMMMUIMUUMMM',
        'MUUIMUUMIUUMMIUU',
        'UUMMUUMUUMUUMIUM',
        'MIUUMMIUUMMUUMMU'
    ];
    PATTERNS.dirt2 = [
        'UUMMUUMIUUMIUUMM',
        'MIUUMMUUMMUUMMIU',
        'UUMMIUUMMUUIMUUU',
        'MUUMUUIMUUMUUMMI',
        'IUMMUUMMMUUMMUUU',
        'MUUMIUUMIUMMUUMM',
        'UUMMMUUMUUMIUMMU',
        'MIUUMMIUUMMUUMUI',
        'UUMUUMIUUMMIUMMU',
        'MUIMUUMMUUMUUMMU',
        'UUMMUUIMMUUMMIUU',
        'MUUMIUMUUMIUUMMM',
        'IUMMUUMMUUMUUMMI',
        'MUUMIUUMUUMMUUIU',
        'UUMMUUMIUUMIUUMM',
        'MIUUMMUUMIUMMUUU'
    ];

    // ── Sidewalk (concrete slab pattern, SimCity-style) ──
    PATTERNS.sidewalk = [
        'LLLLLLLLLLLLLLLL',
        'LWWWWWWWLWWWWWWL',
        'LWWWWWWWLWWWWWWL',
        'LWWWWWWWLWWWWWWL',
        'LWWWWLWWLWWWLWWL',
        'LWWWWWWWLWWWWWWL',
        'LWWWWWWWLWWWWWWL',
        'LLLLLLLLLLLLLLLL',
        'LWWWWWLWWWWWWWWL',
        'LWWWWWLWWWWWWWWL',
        'LWWWWWLWWWLWWWWL',
        'LWWWWWLWWWWWWWWL',
        'LWWWWWLWWWWWWWWL',
        'LWWWWWLWWWWWWWWL',
        'LWWWWWLWWWWWWWWL',
        'LLLLLLLLLLLLLLLL'
    ];
    PATTERNS.sidewalkEdge = [
        'GLLLLLLLLLLLLLLG',
        'GLWWWWWWLWWWWWLG',
        'GLWWWWWWLWWWWWLG',
        'GLWWWLWWLWWWWWLG',
        'GLWWWWWWLWWWWWLG',
        'GLWWWWWWLWWLWWLG',
        'GLWWWWWWLWWWWWLG',
        'GLLLLLLLLLLLLLLG',
        'GLWWWWWWLWWWWWLG',
        'GLWWWWWWLWWWWWLG',
        'GLWWLWWWLWWWWWLG',
        'GLWWWWWWLWWWWWLG',
        'GLWWWWWWLWWLWWLG',
        'GLWWWWWWLWWWWWLG',
        'GLWWWWWWLWWWWWLG',
        'GLLLLLLLLLLLLLLG'
    ];

    // ── Road: SimCity-style medium gray with subtle aggregate ──
    PATTERNS.roadAsphalt = [
        'GLGGGLGGGGLGGGGL',
        'GGGLGGGGGLGGGLGG',
        'GGGGGGLGGGGLGGGG',
        'GLGGGGGGGGGGGGLG',
        'GGGGLGGGGGLGGGGG',
        'GGGGGGGLGGGGGGLG',
        'GGLGGGGGGGGLGGGG',
        'GGGGGGLGGGLGGGGG',
        'GGGGGGGGGGGGGLGG',
        'GLGGGLGGGGGGGGLG',
        'GGGGGGGGLGGGGLGG',
        'GGGGLGGGGLGGGGGG',
        'GGGGGGGGGGGGGGGG',
        'GLGGGGLGGGGGLGGG',
        'GGGGGGGGGGLGGGGG',
        'GGLGGGGGGGGGGLGG'
    ];
    // ── Highway: SimCity-style darker asphalt ──
    PATTERNS.highwayAsphalt = [
        'KGKKGKKKKGKKKGKK',
        'KKKKKKGKKKKGKKKK',
        'KGKKKKKKGKKKKKGK',
        'KKKKGKKKKKKKKKKK',
        'KKKKKKKGKKKKGKKK',
        'KGKKKKKKKGKKKKKK',
        'KKKGKKKKKKKKKGKK',
        'KKKKKGKKKKKGKKKK',
        'KGKKKKKKGKKKKKKG',
        'KKKKKGKKKKKGKKKK',
        'KKGKKKKKKKKKKGKK',
        'KKKKKKKGKKKKKKKK',
        'KGKKGKKKKGKKKKGK',
        'KKKKKKKKKKKGKKKK',
        'KKKKGKKKKKKKKKGK',
        'KGKKKKKGKKKGKKKK'
    ];
    // ── Bridge deck (wooden plank / concrete) ──
    PATTERNS.bridgeDeck = [
        'LLGLLLGLLLGLLLGL',
        'LLGLLLGLLLGLLLGL',
        'GGGGGGGGGGGGGGGG',
        'LLLGLLLLGLLLGLLL',
        'LLLGLLLLGLLLGLLL',
        'GGGGGGGGGGGGGGGG',
        'LLGLLLGLLLGLLLGL',
        'LLGLLLGLLLGLLLGL',
        'GGGGGGGGGGGGGGGG',
        'LGLLLGLLLGLLLGLL',
        'LGLLLGLLLGLLLGLL',
        'GGGGGGGGGGGGGGGG',
        'LLLLGLLLGLLLGLLL',
        'LLLLGLLLGLLLGLLL',
        'GGGGGGGGGGGGGGGG',
        'LLGLLLGLLLGLLLGL'
    ];

    // ── Neon frame for arcade ──
    PATTERNS.neonFrame = [
        'CCCCCCCCCCCCCCCC',
        'C______________C',
        'C______________C',
        'C______________C',
        'C______________C',
        'C______________C',
        'C______________C',
        'C______________C',
        'C______________C',
        'C______________C',
        'C______________C',
        'C______________C',
        'C______________C',
        'C______________C',
        'C______________C',
        'CCCCCCCCCCCCCCCC'
    ];

    // ── Party Wagon sprites (32x32 actual NES pixels, 1x resolution) ──
    // Colors: K=black, P=red/salmon(#fc7460), V=green(#00a800), _=transparent
    // Extracted pixel-perfect from partywagon/*.png at native NES resolution

    PATTERNS.wagonDown1 = [
        '_______KPPPPPPPPPPPPPPPPK_______',
        '_______KPKKKKKKKKKKKKKKPK_______',
        '_______KPKPPPPPPPPPPPPKPK_______',
        '________KPVVVVVVVVVVVVPK________',
        '_________KPPPPPPPPPPPPK_________',
        '_________KKKKKKKKKKKKKK_________',
        '_________KKKKPPPPPPKKKK_________',
        '________KPKKKKKKKKKKKKPK________',
        '________KPKVVVVVVVVVVKPK________',
        '______KKKPVKVVVVVVVVKVPKKK______',
        '_____KPKKPVVKKKKKKKKVVPKKPK_____',
        '_____KPKKPVKVVVVVVVVKVPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KPKKPVKVVVVVVVVKVPKKPK_____',
        '_____KKKKPVVKKKKKKKKVVPKKKK_____',
        '_____KVKKPVKVVVVVVVVKVPKKVK_____',
        '_____KKKKPKVVVVVVVVVVKPKKKK_____',
        '______KKKPKVVVVVVVVVVKPKKK______',
        '______KKKPVKVVVVVVVVKVPKKK______',
        '______KKPKVKKKKKKKKKKVKPKK______',
        '_____KPKPPKVVVVVVVVVVKPPKPK_____',
        '_____KPKPPPKKKKKKKKKKPPPKPK_____',
        '_____KPKKKKKKKKVVKKKKKKKKPK_____',
        '_____KVKKPPKKKKKKKKKKPPKKVK_____',
        '_____KKKKKKKPPKVVKPPKKKKKKK_____',
        '_____KPKKPPKPKVVVVKPKPPKKPK_____',
        '______KKKKKKKKVVVVKKKKKKKK______',
        '______KKKPPKVVKVVKVVKPPKKK______',
        '_______KKKKKKKKKKKKKKKKKK_______',
        '________KPPKKKKKKKKKKPPK________',
        '_________KKK________KKK_________'
    ];
    PATTERNS.wagonDown2 = [
        '_______KPPPPPPPPPPPPPPPPK_______',
        '_______KPKKKKKKKKKKKKKKPK_______',
        '_______KPKPPPPPPPPPPPPKPK_______',
        '________KPVVVVVVVVVVVVPK________',
        '_________KPPPPPPPPPPPPK_________',
        '_________KKKKKKKKKKKKKK_________',
        '_________KKKKPPPPPPKKKK_________',
        '________KPKKKKKKKKKKKKPK________',
        '________KPKVVVVVVVVVVKPK________',
        '______KKKPVKVVVVVVVVKVPKKK______',
        '_____KPKKPVVKKKKKKKKVVPKKPK_____',
        '_____KPKKPVKVVVVVVVVKVPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KPKKPVKVVVVVVVVKVPKKPK_____',
        '_____KKKKPVVKKKKKKKKVVPKKKK_____',
        '_____KVKKPVKVVVVVVVVKVPKKVK_____',
        '_____KKKKPKVVVVVVVVVVKPKKKK_____',
        '______KKKPKVVVVVVVVVVKPKKK______',
        '______KKKPVKVVVVVVVVKVPKKK______',
        '______KKPKVKKKKKKKKKKVKPKK______',
        '_____KPKPPKVVVVVVVVVVKPPKPK_____',
        '_____KPKPPPKKKKKKKKKKPPPKPK_____',
        '_____KPKKKKKKKKVVKKKKKKKKPK_____',
        '_____KVKKPPKKKKKKKKKKPPKKVK_____',
        '_____KKKKKKKPPKVVKPPKKKKKKK_____',
        '_____KPKKPPKPKVVVVKPKPPKKPK_____',
        '______KKKKKKKKVVVVKKKKKKKK______',
        '______KKKPPKVVKVVKVVKPPKKK______',
        '_______KKKKKKKKKKKKKKKKKK_______',
        '________KPPKKKKKKKKKKPPK________',
        '_________KKK________KKK_________'
    ];
    PATTERNS.wagonDown3 = [
        '_______KPPPPPPPPPPPPPPPPK_______',
        '_______KPKKKKKKKKKKKKKKPK_______',
        '_______KPKPPPPPPPPPPPPKPK_______',
        '________KPVVVVVVVVVVVVPK________',
        '_________KPPPPPPPPPPPPK_________',
        '_________KKKKKKKKKKKKKK_________',
        '_________KKKKPPPPPPKKKK_________',
        '________KPKKKKKKKKKKKKPK________',
        '________KPKVVVVVVVVVVKPK________',
        '______KKKPVKVVVVVVVVKVPKKK______',
        '_____KPKKPVVKKKKKKKKVVPKKPK_____',
        '_____KPKKPVKVVVVVVVVKVPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KPKKPVKVVVVVVVVKVPKKPK_____',
        '_____KKKKPVVKKKKKKKKVVPKKKK_____',
        '_____KKKKPVKVVVVVVVVKVPKKKK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '______KKKPKVVVVVVVVVVKPKKK______',
        '______KKKPVKVVVVVVVVKVPKKK______',
        '______KKPKVKKKKKKKKKKVKPKK______',
        '_____KPKPPKVVVVVVVVVVKPPKPK_____',
        '_____KPKPPPKKKKKKKKKKPPPKPK_____',
        '_____KPKKKKKKKKVVKKKKKKKKPK_____',
        '_____KKKKPPKKKKKKKKKKPPKKKK_____',
        '_____KVKKKKKPPKVVKPPKKKKKVK_____',
        '_____KKKKPPKPKVVVVKPKPPKKKK_____',
        '_____KVKKKKKKKVVVVKKKKKKKVK_____',
        '______KKKPPKVVKVVKVVKPPKKK______',
        '_______KKKKKKKKKKKKKKKKKK_______',
        '________KPPKKKKKKKKKKPPK________',
        '_________KKK________KKK_________'
    ];
    PATTERNS.wagonDown4 = [
        '_______KPPPPPPPPPPPPPPPPK_______',
        '_______KPKKKKKKKKKKKKKKPK_______',
        '_______KPKPPPPPPPPPPPPKPK_______',
        '________KPVVVVVVVVVVVVPK________',
        '_________KPPPPPPPPPPPPK_________',
        '_________KKKKKKKKKKKKKK_________',
        '_________KKKKPPPPPPKKKK_________',
        '________KPKKKKKKKKKKKKPK________',
        '________KPKVVVVVVVVVVKPK________',
        '______KKKPVKVVVVVVVVKVPKKK______',
        '_____KPKKPVVKKKKKKKKVVPKKPK_____',
        '_____KPKKPVKVVVVVVVVKVPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KPKKPVKVVVVVVVVKVPKKPK_____',
        '_____KKKKPVVKKKKKKKKVVPKKKK_____',
        '_____KKKKPVKVVVVVVVVKVPKKKK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '______KKKPKVVVVVVVVVVKPKKK______',
        '______KKKPVKVVVVVVVVKVPKKK______',
        '______KKPKVKKKKKKKKKKVKPKK______',
        '_____KPKPPKVVVVVVVVVVKPPKPK_____',
        '_____KPKPPPKKKKKKKKKKPPPKPK_____',
        '_____KPKKKKKKKKVVKKKKKKKKPK_____',
        '_____KKKKPPKKKKKKKKKKPPKKKK_____',
        '_____KVKKKKKPPKVVKPPKKKKKVK_____',
        '_____KKKKPPKPKVVVVKPKPPKKKK_____',
        '_____KVKKKKKKKVVVVKKKKKKKVK_____',
        '______KKKPPKVVKVVKVVKPPKKK______',
        '_______KKKKKKKKKKKKKKKKKK_______',
        '________KPPKKKKKKKKKKPPK________',
        '_________KKK________KKK_________'
    ];
    PATTERNS.wagonUp1 = [
        '________KPPK________KPPK________',
        '________KKKK________KKKK________',
        '________KPPK________KPPK________',
        '________KKKK________KKKK________',
        '________KPPKKKKKKKKKKPPK________',
        '________KKKKVVVVVVVVKKKK________',
        '_______KPPPKKKKKKKKKKPPPK_______',
        '_______KPPKKVVVVVVVVKKPPK_______',
        '_______KPKKVVVVVVVVVVKKPK_______',
        '________KPKVVVVVVVVVVKPK________',
        '______KKKPVKVVVVVVVVKVPKKK______',
        '_____KPKKPVVKKKKKKKKVVPKKPK_____',
        '_____KPKKPVKVVVVVVVVKVPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KKKKPVKVVVVVVVVKVPKKKK_____',
        '_____KVKKPVVKKKKKKKKVVPKKVK_____',
        '_____KKKKPVKVVVVVVVVKVPKKKK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '______KKKKKKKKKKKKKKKKKKKK______',
        '______KKKKPPPPPPPPPPPPKKKK______',
        '______KKKPKVVVVVVVVVVKPKKK______',
        '_____KPKPPPPPPPPPPPPPPPPKPK_____',
        '_____KPKKKKKKKKKKKKKKKKKKPK_____',
        '_____KKKKKPKPPPPPPPPKPKKKKK_____',
        '_____KPKKKPKKKKKKKKKKPKKKPK_____',
        '_____KKKKKPPPPPPPPPPPPKKKKK_____',
        '_____KVKKKKKKKKKKKKKKKKKKVK_____',
        '_____KKKKKPKPKPPPPKPKPKKKKK_____',
        '______VKKKKPKKKKKKKKPKKKKV______',
        '_______KKKKKKKKKKKKKKKKKK_______',
        '__________KKKKKKKKKKKK__________'
    ];
    PATTERNS.wagonUp2 = [
        '________KPPK________KPPK________',
        '________KKKK________KKKK________',
        '________KPPK________KPPK________',
        '________KKKK________KKKK________',
        '________KPPKKKKKKKKKKPPK________',
        '________KKKKVVVVVVVVKKKK________',
        '_______KPPPKKKKKKKKKKPPPK_______',
        '_______KPPKKVVVVVVVVKKPPK_______',
        '_______KPKKVVVVVVVVVVKKPK_______',
        '________KPKVVVVVVVVVVKPK________',
        '______KKKPVKVVVVVVVVKVPKKK______',
        '_____KPKKPVVKKKKKKKKVVPKKPK_____',
        '_____KPKKPVKVVVVVVVVKVPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KKKKPVKVVVVVVVVKVPKKKK_____',
        '_____KPKKPVVKKKKKKKKVVPKKPK_____',
        '_____KVKKPVKVVVVVVVVKVPKKVK_____',
        '_____KKKKPKVVVVVVVVVVKPKKKK_____',
        '______KKKKKKKKKKKKKKKKKKKK______',
        '______KKKKPPPPPPPPPPPPKKKK______',
        '______KKKPKVVVVVVVVVVKPKKK______',
        '_____KPKPPPPPPPPPPPPPPPPKPK_____',
        '_____KPKKKKKKKKKKKKKKKKKKPK_____',
        '_____KKKKKPKPPPPPPPPKPKKKKK_____',
        '_____KPKKKPKKKKKKKKKKPKKKPK_____',
        '_____KVKKKPPPPPPPPPPPPKKKVK_____',
        '_____KKKKKKKKKKKKKKKKKKKKKK_____',
        '______PKKKPKPKPPPPKPKPKKKP______',
        '______KKKKKPKKKKKKKKPKKKKK______',
        '_______KKKKKKKKKKKKKKKKKK_______',
        '__________KKKKKKKKKKKK__________'
    ];
    PATTERNS.wagonUp3 = [
        '________KPPK________KPPK________',
        '________KKKK________KKKK________',
        '________KPPK________KPPK________',
        '________KKKK________KKKK________',
        '________KPPKKKKKKKKKKPPK________',
        '________KKKKVVVVVVVVKKKK________',
        '_______KPPPKKKKKKKKKKPPPK_______',
        '_______KPPKKVVVVVVVVKKPPK_______',
        '_______KPKKVVVVVVVVVVKKPK_______',
        '________KPKVVVVVVVVVVKPK________',
        '______KKKPVKVVVVVVVVKVPKKK______',
        '_____KPKKPVVKKKKKKKKVVPKKPK_____',
        '_____KPKKPVKVVVVVVVVKVPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KKKKPVKVVVVVVVVKVPKKKK_____',
        '_____KVKKPVVKKKKKKKKVVPKKVK_____',
        '_____KKKKPVKVVVVVVVVKVPKKKK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '______KKKKKKKKKKKKKKKKKKKK______',
        '______KKKKPPPPPPPPPPPPKKKK______',
        '______KKKPKVVVVVVVVVVKPKKK______',
        '_____KPKPPPPPPPPPPPPPPPPKPK_____',
        '_____KPKKKKKKKKKKKKKKKKKKPK_____',
        '_____KKKKKPKPPPPPPPPKPKKKKK_____',
        '_____KPKKKPKKKKKKKKKKPKKKPK_____',
        '_____KKKKKPPPPPPPPPPPPKKKKK_____',
        '_____KVKKKKKKKKKKKKKKKKKKVK_____',
        '_____KKKKKPKPKPPPPKPKPKKKKK_____',
        '______VKKKKPKKKKKKKKPKKKKV______',
        '_______KKKKKKKKKKKKKKKKKK_______',
        '__________KKKKKKKKKKKK__________'
    ];
    PATTERNS.wagonUp4 = [
        '________KPPK________KPPK________',
        '________KKKK________KKKK________',
        '________KPPK________KPPK________',
        '________KKKK________KKKK________',
        '________KPPKKKKKKKKKKPPK________',
        '________KKKKVVVVVVVVKKKK________',
        '_______KPPPKKKKKKKKKKPPPK_______',
        '_______KPPKKVVVVVVVVKKPPK_______',
        '_______KPKKVVVVVVVVVVKKPK_______',
        '________KPKVVVVVVVVVVKPK________',
        '______KKKPVKVVVVVVVVKVPKKK______',
        '_____KPKKPVVKKKKKKKKVVPKKPK_____',
        '_____KPKKPVKVVVVVVVVKVPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KPKKPKVVVVVVVVVVKPKKPK_____',
        '_____KKKKPVKVVVVVVVVKVPKKKK_____',
        '_____KPKKPVVKKKKKKKKVVPKKPK_____',
        '_____KVKKPVKVVVVVVVVKVPKKVK_____',
        '_____KKKKPKVVVVVVVVVVKPKKKK_____',
        '______KKKKKKKKKKKKKKKKKKKK______',
        '______KKKKPPPPPPPPPPPPKKKK______',
        '______KKKPKVVVVVVVVVVKPKKK______',
        '_____KPKPPPPPPPPPPPPPPPPKPK_____',
        '_____KPKKKKKKKKKKKKKKKKKKPK_____',
        '_____KKKKKPKPPPPPPPPKPKKKKK_____',
        '_____KPKKKPKKKKKKKKKKPKKKPK_____',
        '_____KVKKKPPPPPPPPPPPPKKKVK_____',
        '_____KKKKKKKKKKKKKKKKKKKKKK_____',
        '______PKKKPKPKPPPPKPKPKKKP______',
        '______KKKKKPKKKKKKKKPKKKKK______',
        '_______KKKKKKKKKKKKKKKKKK_______',
        '__________KKKKKKKKKKKK__________'
    ];
    PATTERNS.wagonRight1 = [
        '________________________________',
        '_KKK____________________________',
        '_PPPK___________________________',
        '_PKKPK_____________KK___________',
        '_PKPVPK___________KPPKKKKKKKK___',
        '_PKPVPK___________KPPKPKPKPKPK__',
        '_PKPVPKKKVVKVVVVKVKKPKPKPKPKPK__',
        '_PKPVPKKKVVKVVVVKVVKKKKKKKKKKK__',
        '_PKPVPKKKVVKVVVVKVVVVKVVVPK_____',
        '_PKPVPKKKVVKVVVVKVVVVKVVVKPK____',
        '_PKPVPKKKVVKVVVVKVVVVKVVVKKKK___',
        '_PKPVPKKKVVKVVVVKVVKKKVVVKKKVK__',
        '_PKKPPKKKVVKVVVVKVKPPKKKKKKKKK__',
        '_PPPPKKKVVVKVVVVKVKPPKPKPKPKPK__',
        '_KKKKKKKVVKVKVVKVKKKPKPKPKPKPK__',
        '___KKKKVVKVVVKKVVVKKKKKKKKKKKK__',
        '___KPPPPKPPPPKPPPPPKPPPPPKKKVK__',
        '___KVKKVKVKKVKVKKKVKVKKKKPKKVK__',
        '___KVKKVKVKKVKVKVKVKVKKKKKPKVK__',
        '___KPPPPKPPPPKPKPKPKPPPPPPPKVK__',
        '___KPKKKKKKKKKPKPKPKKKKKKKPKVK__',
        '____KKPPPPPPPKKPKPKKPPPPPPKKVK__',
        '____KPKKKKKKKPKPPPKPKKKKKKPKK___',
        '____KKKVKKKPKKKKKKKKKPKKVKKKK___',
        '____KKKKVPVKKKKPPPKKKKVPKKKKK___',
        '____KKKKKKKKKKKKKKKKKKKKKKKKK___',
        '_____KKKKKKKKKKKKKKKKKKKKKKK____',
        '________KKKKKKKKKKKKKKKKK_______',
        '________________________________',
        '________________________________',
        '________________________________',
        '________________________________'
    ];
    PATTERNS.wagonRight2 = [
        '________________________________',
        '_KKK____________________________',
        '_PPPK___________________________',
        '_PKKPK_____________KK___________',
        '_PKPVPK___________KPPKKKKKKKK___',
        '_PKPVPK___________KPPKPKPKPKPK__',
        '_PKPVPKKKVVKVVVVKVKKPKPKPKPKPK__',
        '_PKPVPKKKVVKVVVVKVVKKKKKKKKKKK__',
        '_PKPVPKKKVVKVVVVKVVVVKVVVPK_____',
        '_PKPVPKKKVVKVVVVKVVVVKVVVKPK____',
        '_PKPVPKKKVVKVVVVKVVVVKVVVKKKK___',
        '_PKPVPKKKVVKVVVVKVVKKKVVVKKKVK__',
        '_PKKPPKKKVVKVVVVKVKPPKKKKKKKKK__',
        '_PPPPKKKVVVKVVVVKVKPPKPKPKPKPK__',
        '_KKKKKKKVVKVKVVKVKKKPKPKPKPKPK__',
        '___KKKKVVKVVVKKVVVKKKKKKKKKKKK__',
        '___KPPPPKPPPPKPPPPPKPPPPPKKKVK__',
        '___KVKKVKVKKVKVKKKVKVKKKKPKKVK__',
        '___KVKKVKVKKVKVKVKVKVKKKKKPKVK__',
        '___KPPPPKPPPPKPKPKPKPPPPPPPKVK__',
        '___KPKKKKKKKKKPKPKPKKKKKKKPKVK__',
        '____KKPPPPPPPKKPKPKKPPPPPPKKVK__',
        '____KPKKKKKKKPKPPPKPKKKKKKPKK___',
        '____KKKPKKKVKKKKKKKKKVKKPKKKK___',
        '____KKKKPVPKKKKPPPKKKKPVKKKKK___',
        '____KKKKKKKKKKKKKKKKKKKKKKKKK___',
        '_____KKKKKKKKKKKKKKKKKKKKKKK____',
        '________KKKKKKKKKKKKKKKKK_______',
        '________________________________',
        '________________________________',
        '________________________________',
        '________________________________'
    ];
    PATTERNS.wagonRight3 = [
        '________________________________',
        '_KKK____________________________',
        '_PPPK___________________________',
        '_PKKPK_____________KK___________',
        '_PKPVPK___________KPPKKKKKKKK___',
        '_PKPVPK___________KPPKPKPKPKPK__',
        '_PKPVPKKKVVKVVVVKVKKPKPKPKPKPK__',
        '_PKPVPKKKVVKVVVVKVVKKKKKKKKKKK__',
        '_PKPVPKKKVVKVVVVKVVVVKVVVPK_____',
        '_PKPVPKKKVVKVVVVKVVVVKVVVKPK____',
        '_PKPVPKKKVVKVVVVKVVVVKVVVKKKK___',
        '_PKPVPKKKVVKVVVVKVVKKKVVVKKKVK__',
        '_PKKPPKKKVVKVVVVKVKPPKKKKKKKKK__',
        '_PPPPKKKVVVKVVVVKVKPPKPKPKPKPK__',
        '_KKKKKKKVVKVKVVKVKKKPKPKPKPKPK__',
        '___KKKKVVKVVVKKVVVKKKKKKKKKKKK__',
        '___KPPPPKPPPPKPPPPPKPPPPPKKKVK__',
        '___KVKKVKVKKVKVKKKVKVKKKKPKKVK__',
        '___KVKKVKVKKVKVKVKVKVKKKKKPKVK__',
        '___KPPPPKPPPPKPKPKPKPPPPPPPKVK__',
        '___KPKKKKKKKKKPKPKPKKKKKKKPKVK__',
        '____KKPPPPPPPKKPKPKKPPPPPPKKVK__',
        '____KPKKKKKKKPKPPPKPKKKKKKPKK___',
        '____KKKVKKKPKKKKKKKKKPKKVKKKK___',
        '____KKKKVPVKKKKPPPKKKKVPKKKKK___',
        '____KKKKKKKKKKKKKKKKKKKKKKKKK___',
        '_____KKKKKKKKKKKKKKKKKKKKKKK____',
        '________KKKKKKKKKKKKKKKKK_______',
        '________________________________',
        '________________________________',
        '________________________________',
        '________________________________'
    ];
    PATTERNS.wagonRight4 = [
        '________________________________',
        '_KKK____________________________',
        '_PPPK___________________________',
        '_PKKPK_____________KK___________',
        '_PKPVPK___________KPPKKKKKKKK___',
        '_PKPVPK___________KPPKPKPKPKPK__',
        '_PKPVPKKKVVKVVVVKVKKPKPKPKPKPK__',
        '_PKPVPKKKVVKVVVVKVVKKKKKKKKKKK__',
        '_PKPVPKKKVVKVVVVKVVVVKVVVPK_____',
        '_PKPVPKKKVVKVVVVKVVVVKVVVKPK____',
        '_PKPVPKKKVVKVVVVKVVVVKVVVKKKK___',
        '_PKPVPKKKVVKVVVVKVVKKKVVVKKKVK__',
        '_PKKPPKKKVVKVVVVKVKPPKKKKKKKKK__',
        '_PPPPKKKVVVKVVVVKVKPPKPKPKPKPK__',
        '_KKKKKKKVVKVKVVKVKKKPKPKPKPKPK__',
        '___KKKKVVKVVVKKVVVKKKKKKKKKKKK__',
        '___KPPPPKPPPPKPPPPPKPPPPPKKKVK__',
        '___KVKKVKVKKVKVKKKVKVKKKKPKKVK__',
        '___KVKKVKVKKVKVKVKVKVKKKKKPKVK__',
        '___KPPPPKPPPPKPKPKPKPPPPPPPKVK__',
        '___KPKKKKKKKKKPKPKPKKKKKKKPKVK__',
        '____KKPPPPPPPKKPKPKKPPPPPPKKVK__',
        '____KPKKKKKKKPKPPPKPKKKKKKPKK___',
        '____KKKPKKKVKKKKKKKKKVKKPKKKK___',
        '____KKKKPVPKKKKPPPKKKKPVKKKKK___',
        '____KKKKKKKKKKKKKKKKKKKKKKKKK___',
        '_____KKKKKKKKKKKKKKKKKKKKKKK____',
        '________KKKKKKKKKKKKKKKKK_______',
        '________________________________',
        '________________________________',
        '________________________________',
        '________________________________'
    ];
    PATTERNS.wagonRight5 = [
        '________________________________',
        '_KKK____________________________',
        '_PPPK___________________________',
        '_PKKPK_____________KK___________',
        '_PKPVPK___________KPPKKKKKKKK___',
        '_PKPVPK___________KPPKPKPKPKPK__',
        '_PKPVPKKKVVKVVVVKVKKPKPKPKPKPK__',
        '_PKPVPKKKVVKVVVVKVVKKKKKKKKKKK__',
        '_PKPVPKKKVVKVVVVKVVVVKVVVPK_____',
        '_PKPVPKKKVVKVVVVKVVVVKVVVKPK____',
        '_PKPVPKKKVVKVVVVKVVVVKVVVKKKK___',
        '_PKPVPKKKVVKVVVVKVVKKKVVVKKKVK__',
        '_PKKPPKKKVVKVVVVKVKPPKKKKKKKKK__',
        '_PPPPKKKVVVKVVVVKVKPPKPKPKPKPK__',
        '_KKKKKKKVVKVKVVKVKKKPKPKPKPKPK__',
        '___KKKKVVKVVVKKVVVKKKKKKKKKKKK__',
        '___KPPPPKPPPPKPPPPPKPPPPPKKKVK__',
        '___KVKKVKVKKVKKKKKKKVKKKKPKKVK__',
        '___KVKKVKVKKVKKKKKKKVKKKKKPKVK__',
        '___KPPPPKPPPPKKKKKKKPPPPPPPKVK__',
        '___KPKKKKKKKKKKKKKKKKKKKKKPKVK__',
        '____KKPPPPPPPKKKKKKKPPPPPPKKVK__',
        '____KPKKKKKKKPKKPKKPKKKKKKPKK___',
        '____KKKVKKKPKKKKKKKKKPKKVKKKK___',
        '____KKKKVPVKKKKPPPKKKKVPKKKKK___',
        '____KKKKKKKKKKPKKKPKKKKKKKKKK___',
        '_____KKKKKKKKPKPPPKPKKKKKKKK____',
        '________KKKKKPKKKKKPKKKKK_______',
        '___________KKPPPPPPPKK__________',
        '____________KKKKKKKKK___________',
        '_____________KKKKKKK____________',
        '________________________________'
    ];

    // ── Pixel-perfect 32x32 building sprites (traced from NES TMNT Area 3) ──
    // Proportions: roof=22cols(69%)x20rows(63%), east=10cols, south=12rows
    // Matches original NES TMNT overview building proportions exactly
    // Colors: K=black, W=white, L=ltgray, G=gray, B=blue, N=navy, R=red, P=salmon

    // Gray stone building with blue window grid (most common Area 3 type)
    PATTERNS.bldgGrayBlue = [
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 0  top border
        'KLLLLLLLLLLLLLLLLLLLLKKGGLGLGGGK', // 1  roof L edge | east stone A
        'KLWWWWWWWWWWWWWWWWWWLKKGGLGLGGGK', // 2  white roof | stone A
        'KLWWWGWWWWWLLLLLLWWWLKKGGGGLGLGK', // 3  triangle tip + panel top | stone B
        'KLWWGKGWWWWLWWWWLWWWLKKKKKKKKKKK', // 4  triangle + panel fill | mortar
        'KLWGKKKGWWWLWWWWLWWWLKKGGGGLGLGK', // 5  triangle widens + panel | stone B
        'KLGKKKKKGWWLLLLLLWWWLKKGGGGLGLGK', // 6  triangle base + panel bottom | B
        'KLGGGGGGGWWWWWWWWWWWLKKGGLGLGGGK', // 7  triangle shadow line | stone A
        'KLWWWWWWWWWWWWWWWWWWLKKKKKKKKKKK', // 8  clean roof | mortar
        'KLWWWWWWWWWWWWWWWWWWLKKGGLGLGGGK', // 9  roof | stone A
        'KLLLLLLLLLLLLLLLLLLLLKKGGLGLGGGK', // 10 seam line | stone A
        'KLWWWWWWWWWWWWWWWWWWLKKGGGGLGLGK', // 11 roof | stone B
        'KLWWWWWWWWWWWWWWWWWWLKKKKKKKKKKK', // 12 roof | mortar
        'KLWWWWWWWWWWWWWWWWWWLKKGGGGLGLGK', // 13 roof | stone B
        'KLLLLLLLLLLLLLLLLLLLLKKGGGGLGLGK', // 14 seam line | stone B
        'KLWWWWWWWWWWWWWWWWWWLKKGGLGLGGGK', // 15 roof | stone A
        'KLWWWWWWWWWWWWWWWWWWLKKKKKKKKKKK', // 16 roof | mortar
        'KLWWWWWWWWWWWWWWWWWWLKKGGLGLGGGK', // 17 roof | stone A
        'KLWWWWWWWWWWWWWWWWWWLKKGGLGLGGGK', // 18 roof | stone A
        'KLLLLLLLLLLLLLLLLLLLLKKGGLGLGGGK', // 19 bottom roof edge | stone A
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 20 roof/south divider
        'KNBBBKNBBKKKKNBBBKNBBKKNNNNNNNNK', // 21 windows + gate frame | SE corner
        'KNBBBKNBBKGGKNBBBKNBBKKNNNNNNNNK', // 22 windows + gate bars
        'KNBBBKNBBKGGKNBBBKNBBKKNNNNNNNNK', // 23 windows + gate bars
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 24 window row divider
        'KNBBBKNBBKKKKNBBBKNBBKKNNNNNNNNK', // 25 windows + gate frame
        'KNBBBKNBBKGGKNBBBKNBBKKNNNNNNNNK', // 26 windows + gate bars
        'KNBBBKNBBKGGKNBBBKNBBKKNNNNNNNNK', // 27 windows + gate bars
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 28 window row divider
        'KNBBBKNBBKKKKNBBBKNBBKKNNNNNNNNK', // 29 windows + gate frame
        'KNBBBKNBBKGGKNBBBKNBBKKNNNNNNNNK', // 30 windows + gate bars
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK'  // 31 bottom border
    ];

    // Gray stone building with red awning -- traced from Area 3 reference sprite
    PATTERNS.bldgGrayRed = [
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 0  top border
        'KLLLLLLLLLLLLLLLLLLLLKKGGLGLGGGK', // 1  roof L edge | east stone A
        'KLWWWWWWWWWWWWWWWWWWLKKGGLGLGGGK', // 2  white roof | stone A
        'KLWWWGWWWWWLLLLLLWWWLKKGGGGLGLGK', // 3  triangle tip + panel top | stone B
        'KLWWGKGWWWWLWWWWLWWWLKKKKKKKKKKK', // 4  triangle + panel fill | mortar
        'KLWGKKKGWWWLWWWWLWWWLKKGGGGLGLGK', // 5  triangle widens + panel | stone B
        'KLGKKKKKGWWLLLLLLWWWLKKGGGGLGLGK', // 6  triangle base + panel bottom | B
        'KLGGGGGGGWWWWWWWWWWWLKKGGLGLGGGK', // 7  triangle shadow line | stone A
        'KLWWWWWWWWWWWWWWWWWWLKKKKKKKKKKK', // 8  clean roof | mortar
        'KLWWWWWWWWWWWWWWWWWWLKKGGLGLGGGK', // 9  roof | stone A
        'KLLLLLLLLLLLLLLLLLLLLKKGGLGLGGGK', // 10 seam line | stone A
        'KLWWWWWWWWWWWWWWWWWWLKKGGGGLGLGK', // 11 roof | stone B
        'KLWWWWWWWWWWWWWWWWWWLKKKKKKKKKKK', // 12 roof | mortar
        'KLWWWWWWWWWWWWWWWWWWLKKGGGGLGLGK', // 13 roof | stone B
        'KLLLLLLLLLLLLLLLLLLLLKKGGGGLGLGK', // 14 seam line | stone B
        'KLWWWWWWWWWWWWWWWWWWLKKGGLGLGGGK', // 15 roof | stone A
        'KLWWWWWWWWWWWWWWWWWWLKKKKKKKKKKK', // 16 roof | mortar
        'KLWWWWWWWWWWWWWWWWWWLKKGGLGLGGGK', // 17 roof | stone A
        'KLWWWWWWWWWWWWWWWWWWLKKGGLGLGGGK', // 18 roof | stone A
        'KLLLLLLLLLLLLLLLLLLLLKKGGLGLGGGK', // 19 bottom roof edge | stone A
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 20 roof/south divider
        'KRRPRRPRRKKKKRPRRPRRRKKNNNNNNNNK', // 21 red awning + gate frame | SE
        'KRRPRRPRRKGGKRPRRPRRRKKNNNNNNNNK', // 22 awning stripes + gate bars
        'KRRPRRPRRKGGKRPRRPRRRKKNNNNNNNNK', // 23 awning + gate bars
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 24 awning divider
        'KRRPRRPRRKKKKRPRRPRRRKKNNNNNNNNK', // 25 awning + gate frame
        'KRRPRRPRRKGGKRPRRPRRRKKNNNNNNNNK', // 26 awning + gate bars
        'KRRPRRPRRKGGKRPRRPRRRKKNNNNNNNNK', // 27 awning + gate bars
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 28 awning divider
        'KRRPRRPRRKKKKRPRRPRRRKKNNNNNNNNK', // 29 awning + gate frame
        'KRRPRRPRRKGGKRPRRPRRRKKNNNNNNNNK', // 30 awning + gate bars
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK'  // 31 bottom border
    ];

    // Red brick building with blue windows (Dimension X / special variant)
    PATTERNS.bldgRedBlue = [
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 0
        'KRRRRRKRRRRRKRRRRRRRRKKDRRDKDRRK', // 1  red brick | dark brick east
        'KRRPRRKRRPRRKRRRRRRRRKKDRRDKDRRK', // 2
        'KRRRRRKRRRRRKRRRRRRRRKKDRRRKDRRK', // 3
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 4  mortar
        'KRRKRRRRRKRRRRRKRRRRRKKDRRDKDRRK', // 5
        'KRRKRRPRRKRRRRPKRRRRRKKDRRDKDRRK', // 6
        'KRRKRRRRRKRRRRRKRRRRRKKDRRRKDRRK', // 7
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 8  mortar
        'KRRRRRKRRRRRKRRRRRRRRKKDRRDKDRRK', // 9
        'KRRPRRKRRPRRKRRRRRRRRKKDRRDKDRRK', // 10
        'KRRRRRKRRRRRKRRRRRRRRKKDRRRKDRRK', // 11
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 12 mortar
        'KRRKRRRRRKRRRRRKRRRRRKKDRRDKDRRK', // 13
        'KRRKRRPRRKRRRRPKRRRRRKKDRRDKDRRK', // 14
        'KRRKRRRRRKRRRRRKRRRRRKKDRRRKDRRK', // 15
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 16 mortar
        'KRRKRRRRRKRRRRRKRRRRRKKDRRDKDRRK', // 17
        'KRRKRRPRRKRRRRPKRRRRRKKDRRDKDRRK', // 18
        'KRRKRRRRRKRRRRRKRRRRRKKDRRRKDRRK', // 19
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 20 divider
        'KNBBBKNBBKKKKNBBBKNBBKKNNNNNNNNK', // 21
        'KNBBBKNBBKGGKNBBBKNBBKKNNNNNNNNK', // 22
        'KNBBBKNBBKGGKNBBBKNBBKKNNNNNNNNK', // 23
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 24
        'KNBBBKNBBKKKKNBBBKNBBKKNNNNNNNNK', // 25
        'KNBBBKNBBKGGKNBBBKNBBKKNNNNNNNNK', // 26
        'KNBBBKNBBKGGKNBBBKNBBKKNNNNNNNNK', // 27
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', // 28
        'KNBBBKNBBKKKKNBBBKNBBKKNNNNNNNNK', // 29
        'KNBBBKNBBKGGKNBBBKNBBKKNNNNNNNNK', // 30
        'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK'  // 31
    ];

    // ── Tile cache: pre-renders patterns to offscreen canvases ──
    var _tileCache = {};
    var _tileCacheGeneration = 0;

    function hexToRgb(hex) {
        var n = parseInt(hex.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function blendColor(rgb1, rgb2, t) {
        return [
            Math.round(rgb1[0] + (rgb2[0] - rgb1[0]) * t),
            Math.round(rgb1[1] + (rgb2[1] - rgb1[1]) * t),
            Math.round(rgb1[2] + (rgb2[2] - rgb1[2]) * t)
        ];
    }

    function rgbStr(rgb) { return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')'; }

    function getCachedTile(patternKey, w, h) {
        var cacheKey = patternKey + '|' + w + '|' + h;
        var entry = _tileCache[cacheKey];
        if (entry && entry.gen === _tileCacheGeneration) return entry.canvas;

        var pat = PATTERNS[patternKey];
        if (!pat) return null;
        var rows = pat.length, cols = pat[0].length;
        var sx = w / cols, sy = h / rows;

        var offscreen = document.createElement('canvas');
        offscreen.width = w;
        offscreen.height = h;
        var oc = offscreen.getContext('2d');

        // Base fill at pattern resolution
        for (var r = 0; r < rows; r++) {
            var row = pat[r];
            for (var c = 0; c < cols; c++) {
                var ch = row[c];
                if (ch === '_') continue;
                var color = PALCACHE[ch];
                if (!color) continue;
                oc.fillStyle = color;
                oc.fillRect(Math.floor(c * sx), Math.floor(r * sy),
                            Math.ceil(sx) + 1, Math.ceil(sy) + 1);
            }
        }

        // Edge enhancement: add subtle shading at color boundaries
        if (sx >= 2 && sy >= 2) {
            var _rgbCache = {};
            function getRgb(ch) {
                if (_rgbCache[ch]) return _rgbCache[ch];
                var hex = PALCACHE[ch];
                if (!hex) return null;
                _rgbCache[ch] = hexToRgb(hex);
                return _rgbCache[ch];
            }

            for (var r = 0; r < rows; r++) {
                var row = pat[r];
                for (var c = 0; c < cols; c++) {
                    var ch = row[c];
                    if (ch === '_') continue;
                    var baseRgb = getRgb(ch);
                    if (!baseRgb) continue;

                    var bx = Math.floor(c * sx), by = Math.floor(r * sy);
                    var bw = Math.ceil(sx), bh = Math.ceil(sy);

                    // Check neighbors for color boundaries
                    var aboveCh = r > 0 ? pat[r - 1][c] : '_';
                    var belowCh = r < rows - 1 ? pat[r + 1][c] : '_';
                    var leftCh  = c > 0 ? row[c - 1] : '_';
                    var rightCh = c < cols - 1 ? row[c + 1] : '_';

                    // Top edge highlight (light coming from top-left)
                    if (aboveCh !== ch) {
                        var hi = blendColor(baseRgb, [255, 255, 255], 0.12);
                        oc.fillStyle = rgbStr(hi);
                        oc.fillRect(bx, by, bw, Math.max(1, Math.floor(bh * 0.15)));
                    }
                    // Left edge highlight
                    if (leftCh !== ch) {
                        var hi2 = blendColor(baseRgb, [255, 255, 255], 0.08);
                        oc.fillStyle = rgbStr(hi2);
                        oc.fillRect(bx, by, Math.max(1, Math.floor(bw * 0.15)), bh);
                    }
                    // Bottom edge shadow
                    if (belowCh !== ch) {
                        var sh = blendColor(baseRgb, [0, 0, 0], 0.15);
                        oc.fillStyle = rgbStr(sh);
                        var shH = Math.max(1, Math.floor(bh * 0.15));
                        oc.fillRect(bx, by + bh - shH, bw, shH);
                    }
                    // Right edge shadow
                    if (rightCh !== ch) {
                        var sh2 = blendColor(baseRgb, [0, 0, 0], 0.10);
                        oc.fillStyle = rgbStr(sh2);
                        var shW = Math.max(1, Math.floor(bw * 0.15));
                        oc.fillRect(bx + bw - shW, by, shW, bh);
                    }
                }
            }
        }

        _tileCache[cacheKey] = { canvas: offscreen, gen: _tileCacheGeneration };
        return offscreen;
    }

    function invalidateTileCache() {
        _tileCacheGeneration++;
        _turtleSpriteCache = {};
    }

    function drawTile(ctx, px, py, patternKey, scale) {
        var pat = PATTERNS[patternKey];
        if (!pat) return;
        var w = pat[0].length * scale, h = pat.length * scale;
        var cached = getCachedTile(patternKey, Math.round(w), Math.round(h));
        if (cached) {
            ctx.drawImage(cached, px, py, w, h);
        } else {
            var rows = pat.length;
            for (var r = 0; r < rows; r++) {
                var row = pat[r];
                var cols = row.length;
                for (var c = 0; c < cols; c++) {
                    var ch = row[c];
                    if (ch === '_') continue;
                    var color = PALCACHE[ch];
                    if (!color) continue;
                    ctx.fillStyle = color;
                    ctx.fillRect(px + c * scale, py + r * scale, scale, scale);
                }
            }
        }
    }

    function drawSprite(ctx, px, py, patternKey, scale) {
        var pat = PATTERNS[patternKey];
        if (!pat) return;
        var w = pat[0].length * scale, h = pat.length * scale;
        var cached = getCachedTile(patternKey, Math.round(w), Math.round(h));
        if (cached) {
            ctx.drawImage(cached, px, py, w, h);
        } else {
            var rows = pat.length;
            for (var r = 0; r < rows; r++) {
                var row = pat[r];
                var cols = row.length;
                for (var c = 0; c < cols; c++) {
                    var ch = row[c];
                    if (ch === '_' || ch === ' ') continue;
                    var color = PALCACHE[ch];
                    if (!color) continue;
                    ctx.fillStyle = color;
                    ctx.fillRect(px + c * scale, py + r * scale, scale, scale);
                }
            }
        }
    }

    function drawTileStretched(ctx, px, py, w, h, patternKey) {
        var cached = getCachedTile(patternKey, Math.round(w), Math.round(h));
        if (cached) {
            ctx.drawImage(cached, px, py, w, h);
            return;
        }
        var pat = PATTERNS[patternKey];
        if (!pat) return;
        var rows = pat.length;
        var cols = pat[0].length;
        var sx = w / cols, sy = h / rows;
        for (var r = 0; r < rows; r++) {
            var row = pat[r];
            for (var c = 0; c < cols; c++) {
                var ch = row[c];
                if (ch === '_') continue;
                var color = PALCACHE[ch];
                if (!color) continue;
                ctx.fillStyle = color;
                ctx.fillRect(px + c * sx, py + r * sy, Math.ceil(sx), Math.ceil(sy));
            }
        }
    }

    function tileHash(x, y) {
        var h = (x * 374761393 + y * 668265263) | 0;
        h = (h ^ (h >>> 13)) * 1274126177;
        return ((h ^ (h >>> 16)) >>> 0);
    }

    function waterFrame() {
        var f = Math.floor(Date.now() / 250) % 3;
        return f === 0 ? 'waterBase' : f === 1 ? 'waterHighlight' : 'waterFrame2';
    }

    // Check if adjacent tile is water/river (for water edge rendering)
    function isWaterNeighbor(tx, ty, dx, dy) {
        var nx = tx + dx, ny = ty + dy;
        if (nx < 0 || ny < 0) return false;
        if (typeof WORLD_WIDTH !== 'undefined' && (nx >= WORLD_WIDTH || ny >= WORLD_HEIGHT)) return false;
        if (typeof TERRAIN_GRID !== 'undefined' && TERRAIN_GRID && TERRAIN_GRID[ny]) {
            var t = TERRAIN_GRID[ny][nx];
            return t === 0 || t === 4;
        }
        if (typeof RIVER_GRID !== 'undefined' && RIVER_GRID) {
            var k = ny * WORLD_WIDTH + nx;
            return !!RIVER_GRID[k];
        }
        return false;
    }

    // Draw navy water edge borders on a tile adjacent to water
    function drawWaterEdge(ctx, sx, sy, tx, ty) {
        ctx.fillStyle = PAL.N;
        if (isWaterNeighbor(tx, ty, 0, -1)) ctx.fillRect(sx, sy, 64, 4);
        if (isWaterNeighbor(tx, ty, 0, 1))  ctx.fillRect(sx, sy + 60, 64, 4);
        if (isWaterNeighbor(tx, ty, -1, 0)) ctx.fillRect(sx, sy, 4, 64);
        if (isWaterNeighbor(tx, ty, 1, 0))  ctx.fillRect(sx + 60, sy, 4, 64);
    }

    // ── Isometric top-down TMNT building (pixel-accurate to Area 3 overview) ──
    // NES NW camera: roof from above with triangle vent + white panels,
    // south face shows blue window grid + gate entrance, east face is darker wall
    function drawBuilding(ctx, x, y, w, h, config) {
        var wallPat = config.wall || 'stoneBlock';
        var wallAlt = config.wallAlt || 'stoneBlockAlt';
        var hasWindows = config.windowPanel !== false;
        var signText = config.sign || '';
        var signColor = config.signBg || PAL.N;
        var neon = config.neon || false;
        var ts = 4;
        var tileW = 16 * ts;

        // Isometric face dimensions
        var southH = Math.max(14, Math.round(h * 0.20));
        var eastW = Math.max(8, Math.round(w * 0.13));
        var roofW = w - eastW;
        var roofH = h - southH;

        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();

        // 1. Roof surface (light gray base seen from above)
        ctx.fillStyle = PAL.L;
        ctx.fillRect(x, y, roofW, roofH);
        ctx.fillStyle = PAL.W;
        ctx.fillRect(x + 2, y + 2, roofW - 4, roofH - 4);
        // Subtle horizontal roof seam lines
        ctx.fillStyle = PAL.L;
        for (var ry = 6; ry < roofH - 2; ry += 10) {
            ctx.fillRect(x + 2, y + ry, roofW - 4, 1);
        }

        // Dark triangular rooftop element (upper-left, like NES TMNT pyramid/vent)
        var triSize = Math.min(Math.round(roofW * 0.18), Math.round(roofH * 0.35));
        triSize = Math.max(10, triSize);
        var triX = x + 4;
        var triY = y + 4;
        ctx.fillStyle = PAL.G;
        ctx.beginPath();
        ctx.moveTo(triX, triY + triSize);
        ctx.lineTo(triX + triSize / 2, triY);
        ctx.lineTo(triX + triSize, triY + triSize);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = PAL.K;
        ctx.beginPath();
        ctx.moveTo(triX + 2, triY + triSize);
        ctx.lineTo(triX + triSize / 2, triY + 3);
        ctx.lineTo(triX + triSize - 2, triY + triSize);
        ctx.closePath();
        ctx.fill();
        // Triangle outline
        ctx.strokeStyle = PAL.G;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(triX, triY + triSize);
        ctx.lineTo(triX + triSize / 2, triY);
        ctx.lineTo(triX + triSize, triY + triSize);
        ctx.closePath();
        ctx.stroke();

        // White rectangular panels on roof (beside triangle, like AC units)
        var panelStartX = triX + triSize + 6;
        var panelW = Math.max(12, Math.round((roofW - triSize - 20) / 3));
        var panelH = Math.max(8, Math.round(triSize * 0.65));
        var panelY = y + 6;
        var numPanels = Math.max(1, Math.floor((roofW - triSize - 16) / (panelW + 4)));
        numPanels = Math.min(numPanels, 4);
        for (var pi = 0; pi < numPanels; pi++) {
            var ppx = panelStartX + pi * (panelW + 4);
            if (ppx + panelW > x + roofW - 4) break;
            ctx.fillStyle = PAL.W;
            ctx.fillRect(ppx, panelY, panelW, panelH);
            ctx.strokeStyle = PAL.L;
            ctx.lineWidth = 1;
            ctx.strokeRect(ppx, panelY, panelW, panelH);
            // Shadow on bottom-right of panel (isometric depth)
            ctx.fillStyle = PAL.G;
            ctx.fillRect(ppx + panelW, panelY + 2, 2, panelH);
            ctx.fillRect(ppx + 2, panelY + panelH, panelW, 2);
        }

        // 2. South face (PROMINENT - visible wall face from NW camera)
        // Stone wall base
        var sfTilesX = Math.ceil(roofW / tileW) + 1;
        for (var stx = 0; stx < sfTilesX; stx++) {
            var sfPat = (tileHash(stx, 77) & 1) ? wallPat : wallAlt;
            drawTileStretched(ctx, x + stx * tileW, y + roofH, tileW, southH, sfPat);
        }

        // South face detail: either red awning band OR blue window grid
        if (config.awning) {
            // Red awning/band (like NES TMNT hotel/diner buildings)
            var awLeft = x + 2;
            var awTop = y + roofH + 1;
            var awW = roofW - 4;
            var awH = southH - 2;
            var awColor = typeof config.awning === 'string' ? config.awning : PAL.R;
            ctx.fillStyle = awColor;
            ctx.fillRect(awLeft, awTop, awW, awH);
            // Stripe detail on awning (alternating lighter strips)
            ctx.fillStyle = PAL.P;
            for (var asi = 3; asi < awW - 2; asi += 10) {
                ctx.fillRect(awLeft + asi, awTop + 1, 2, awH - 2);
            }
            // Top and bottom borders
            ctx.fillStyle = PAL.K;
            ctx.fillRect(awLeft, awTop, awW, 1);
            ctx.fillRect(awLeft, awTop + awH - 1, awW, 1);
        } else if (hasWindows) {
            // Blue window grid (the distinctive NES TMNT look)
            var gridLeft = x + 3;
            var gridTop = y + roofH + 2;
            var gridW = roofW - 6;
            var gridH = southH - 4;
            ctx.fillStyle = PAL.N;
            ctx.fillRect(gridLeft, gridTop, gridW, gridH);
            var cellW = 10, cellH = Math.max(4, Math.floor(gridH / 2));
            var cellCols = Math.max(1, Math.floor(gridW / (cellW + 2)));
            var cellRows = Math.max(1, Math.floor(gridH / (cellH + 2)));
            for (var cr = 0; cr < cellRows; cr++) {
                for (var cc = 0; cc < cellCols; cc++) {
                    var cx = gridLeft + 2 + cc * (cellW + 2);
                    var cy = gridTop + 1 + cr * (cellH + 2);
                    if (cx + cellW <= gridLeft + gridW && cy + cellH <= gridTop + gridH) {
                        ctx.fillStyle = PAL.B;
                        ctx.fillRect(cx, cy, cellW, cellH);
                    }
                }
            }
            ctx.strokeStyle = PAL.K;
            ctx.lineWidth = 1;
            ctx.strokeRect(gridLeft, gridTop, gridW, gridH);
        }

        // Gate entrance on south face (vertical bars like NES TMNT)
        if (config.door !== false) {
            var gateW = Math.max(10, Math.round(roofW * 0.14));
            var gateH = Math.max(6, southH - 3);
            var gateX = x + (roofW - gateW) / 2;
            var gateY = y + roofH + 1;
            ctx.fillStyle = PAL.K;
            ctx.fillRect(gateX, gateY, gateW, gateH);
            ctx.fillStyle = PAL.G;
            var barSpacing = Math.max(3, Math.floor(gateW / 5));
            for (var bi = 1; bi < gateW - 1; bi += barSpacing) {
                ctx.fillRect(gateX + bi, gateY + 1, 1, gateH - 2);
            }
            ctx.fillRect(gateX + 1, gateY + Math.floor(gateH / 2), gateW - 2, 1);
        }

        // 3. East face (visible side wall, gray stone with mortar)
        ctx.fillStyle = PAL.G;
        ctx.fillRect(x + roofW, y, eastW, roofH);
        ctx.fillStyle = PAL.K;
        for (var emy = 0; emy < roofH; emy += 6) {
            ctx.fillRect(x + roofW, y + emy, eastW, 1);
        }
        for (var emx = 2; emx < eastW - 1; emx += 4) {
            for (var emy2 = 3; emy2 < roofH; emy2 += 12) {
                ctx.fillRect(x + roofW + emx, y + emy2, 1, 3);
            }
        }

        // 4. SE corner (darkest shadow)
        ctx.fillStyle = PAL.K;
        ctx.fillRect(x + roofW, y + roofH, eastW, southH);
        ctx.fillStyle = PAL.N;
        ctx.fillRect(x + roofW + 1, y + roofH + 1, eastW - 2, southH - 2);

        // 5. Black outline + edge lines
        ctx.strokeStyle = PAL.K;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + roofH);
        ctx.lineTo(x + roofW, y + roofH);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + roofW, y);
        ctx.lineTo(x + roofW, y + roofH);
        ctx.stroke();

        ctx.restore();

        // Sign (positioned at roof/south-face border)
        if (signText) {
            var signW = Math.min(roofW - 4, signText.length * 7 + 12);
            var signH = 12;
            var signX = x + (roofW - signW) / 2;
            var signY = y + roofH - 6;
            ctx.fillStyle = signColor;
            ctx.fillRect(signX, signY, signW, signH);
            ctx.strokeStyle = PAL.K;
            ctx.lineWidth = 1;
            ctx.strokeRect(signX, signY, signW, signH);
            ctx.fillStyle = PAL.W;
            ctx.font = '7px "Press Start 2P", monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(signText, signX + signW / 2, signY + signH / 2 + 1);
            ctx.textBaseline = 'alphabetic';
        }

        // Neon border (arcade)
        if (neon) {
            var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
            ctx.strokeStyle = 'rgba(60,188,252,' + pulse.toFixed(2) + ')';
            ctx.lineWidth = 3;
            ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
        }

        // Black outline
        ctx.strokeStyle = PAL.K;
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
    }

    // ── Turtle sprite rendering with color swap ──
    var _turtleSpriteCache = {};

    function drawTurtleSprite(ctx, px, py, direction, frame, turtleId, scale) {
        var maskKey = TURTLE_COLORS[turtleId] || 'B';
        var frames = TURTLE_FRAMES[direction] || TURTLE_FRAMES.down;
        var patKey = frames[frame % frames.length];
        var flipX = (direction === 'left');

        if (maskKey === 'B') {
            // Leo uses the base pattern directly
            ctx.save();
            if (flipX) {
                ctx.translate(px + 16 * scale, py);
                ctx.scale(-1, 1);
                drawSprite(ctx, 0, 0, patKey, scale);
            } else {
                drawSprite(ctx, px, py, patKey, scale);
            }
            ctx.restore();
            return;
        }

        // Color-swapped render: replace B with the turtle's mask color
        var cacheKey = patKey + '|' + maskKey + '|' + Math.round(scale * 100);
        var cached = _turtleSpriteCache[cacheKey];
        if (!cached) {
            var pat = PATTERNS[patKey];
            if (!pat) return;
            var rows = pat.length, cols = pat[0].length;
            var w = Math.round(cols * scale), h = Math.round(rows * scale);
            var off = document.createElement('canvas');
            off.width = w; off.height = h;
            var oc = off.getContext('2d');
            var pxScale = w / cols;
            for (var r = 0; r < rows; r++) {
                var row = pat[r];
                for (var c = 0; c < cols; c++) {
                    var ch = row[c];
                    if (ch === '_' || ch === ' ') continue;
                    var color = (ch === 'B') ? PALCACHE[maskKey] : PALCACHE[ch];
                    if (!color) continue;
                    oc.fillStyle = color;
                    oc.fillRect(Math.floor(c * pxScale), Math.floor(r * pxScale),
                                Math.ceil(pxScale), Math.ceil(pxScale));
                }
            }
            cached = off;
            _turtleSpriteCache[cacheKey] = cached;
        }
        ctx.save();
        if (flipX) {
            ctx.translate(px + cached.width, py);
            ctx.scale(-1, 1);
            ctx.drawImage(cached, 0, 0);
        } else {
            ctx.drawImage(cached, px, py);
        }
        ctx.restore();
    }

    function getTurtleFrame(direction, animTimer) {
        var frames = TURTLE_FRAMES[direction] || TURTLE_FRAMES.down;
        var idx = Math.floor(animTimer / 0.15) % frames.length;
        return idx;
    }

    return {
        PAL: PAL,
        PATTERNS: PATTERNS,
        TURTLE_COLORS: TURTLE_COLORS,
        TURTLE_FRAMES: TURTLE_FRAMES,
        drawTile: drawTile,
        drawTileStretched: drawTileStretched,
        drawSprite: drawSprite,
        drawTurtleSprite: drawTurtleSprite,
        getTurtleFrame: getTurtleFrame,
        tileHash: tileHash,
        waterFrame: waterFrame,
        drawBuilding: drawBuilding,
        drawWaterEdge: drawWaterEdge,
        isWaterNeighbor: isWaterNeighbor,
        invalidateTileCache: invalidateTileCache
    };
})();

// ============================================
// DATA LOADING + VALIDATION
// ============================================

async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp.json();
}

const VALID_REGION_IDS = new Set(['na', 'sa', 'eu', 'asia', 'oce']);

function validateArtists(rawArray) {
    const seen = new Set();
    const valid = {};
    for (const a of rawArray) {
        if (!a.id || typeof a.id !== 'string') {
            console.warn('validateArtists: dropping entry with missing/invalid id', a);
            continue;
        }
        if (seen.has(a.id)) {
            console.warn('validateArtists: dropping duplicate id', a.id);
            continue;
        }
        seen.add(a.id);
        const regionBase = (typeof a.regionId === 'string' && VALID_REGION_IDS.has(a.regionId)) ? a.regionId : 'na';
        let regionOver = null;
        if (typeof a.regionIdOverride === 'string' && a.regionIdOverride) {
            if (VALID_REGION_IDS.has(a.regionIdOverride)) {
                regionOver = a.regionIdOverride;
            } else {
                console.warn('validateArtists: invalid regionIdOverride "' + a.regionIdOverride + '" for ' + a.id + ', ignoring');
            }
        }
        valid[a.id] = {
            name:      (typeof a.name === 'string' && a.name) ? a.name : 'Unknown Artist',
            bio:       (typeof a.bio === 'string') ? a.bio : '',
            instagram: (typeof a.instagram === 'string' && a.instagram) ? a.instagram : null,
            images:    Array.isArray(a.images) ? a.images : [],
            regionId:  regionOver || regionBase,
            lat:       (typeof a.lat === 'number') ? a.lat : null,
            lon:       (typeof a.lon === 'number') ? a.lon : null,
            city:      (typeof a.city === 'string') ? a.city : null,
            country:   (typeof a.country === 'string') ? a.country : null
        };
    }
    return valid;
}

function validateBuildings(rawArray, defaults, artistMap) {
    const seen = new Set();
    const valid = {};
    for (const b of rawArray) {
        if (!b.id || typeof b.id !== 'string') {
            console.warn('validateBuildings: dropping entry with missing/invalid id', b);
            continue;
        }
        if (seen.has(b.id)) {
            console.warn('validateBuildings: dropping duplicate id', b.id);
            continue;
        }
        seen.add(b.id);

        const artistId = (typeof b.artistId === 'string') ? b.artistId : null;
        if (artistId && !artistMap[artistId]) {
            console.warn('validateBuildings: building', b.id, 'references missing artist', artistId, '— kept as unbound');
        }

        valid[b.id] = {
            id:            b.id,
            artistId:      artistId,
            buildingType:  b.buildingType || null,
            priority:      (typeof b.priority === 'number') ? b.priority : 0,
            collisionRect: b.collisionRect || null,
            enterRect:     b.enterRect || null,
            exitRect:      b.exitRect || null
        };
    }
    return valid;
}

function applyPlacements(buildingDefs, placements, defaults) {
    const defCR = defaults.collisionRect || FALLBACK_DEFAULTS.collisionRect;
    const defER = defaults.enterRect     || FALLBACK_DEFAULTS.enterRect;
    const defXR = defaults.exitRect      || FALLBACK_DEFAULTS.exitRect;
    const placed = [];

    for (const p of placements) {
        if (!p.buildingId || typeof p.x !== 'number' || typeof p.y !== 'number') {
            console.warn('applyPlacements: dropping invalid placement', p);
            continue;
        }

        const def = buildingDefs[p.buildingId];
        if (!def) {
            console.error('applyPlacements: placement references unknown building', p.buildingId, '— skipped');
            continue;
        }

        const entry = {
            id:           p.buildingId,
            artistId:     def.artistId,
            buildingType: def.buildingType || null,
            x:            p.x,
            y:            p.y,
            priority:     def.priority
        };

        entry.worldX = entry.x * TILE_SIZE;
        entry.worldY = entry.y * TILE_SIZE;

        const cr = def.collisionRect || defCR;
        const er = def.enterRect     || defER;
        const xr = def.exitRect      || defXR;

        entry.collisionWorld = { x: entry.worldX + cr.ox, y: entry.worldY + cr.oy, w: cr.w, h: cr.h };
        entry.enterWorld     = { x: entry.worldX + er.ox, y: entry.worldY + er.oy, w: er.w, h: er.h };
        entry.exitWorld      = { x: entry.worldX + xr.ox, y: entry.worldY + xr.oy, w: xr.w, h: xr.h };

        placed.push(entry);
    }
    return placed;
}

function validateRoads(rawRoads) {
    const grid = new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT);
    let count = 0;
    for (const r of rawRoads) {
        if (typeof r.x !== 'number' || typeof r.y !== 'number' ||
            !Number.isInteger(r.x) || !Number.isInteger(r.y)) {
            console.warn('validateRoads: dropping entry with invalid x/y', r);
            continue;
        }
        if (r.x < 0 || r.x >= WORLD_WIDTH || r.y < 0 || r.y >= WORLD_HEIGHT) {
            console.warn('validateRoads: dropping out-of-bounds tile', r.x, r.y);
            continue;
        }
        const key = r.y * WORLD_WIDTH + r.x;
        if (!grid[key]) count++;
        grid[key] = 1;
    }
    return { grid, count };
}

function validateRiver(rawTiles) {
    const grid = new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT);
    let count = 0;
    for (const r of rawTiles) {
        if (typeof r.x !== 'number' || typeof r.y !== 'number' ||
            !Number.isInteger(r.x) || !Number.isInteger(r.y)) {
            continue;
        }
        if (r.x < 0 || r.x >= WORLD_WIDTH || r.y < 0 || r.y >= WORLD_HEIGHT) {
            continue;
        }
        const key = r.y * WORLD_WIDTH + r.x;
        if (!grid[key]) count++;
        grid[key] = 1;
    }
    return { grid, count };
}

function validateLandmarks(rawLandmarks) {
    const seen = new Set();
    const valid = [];
    for (const lm of rawLandmarks) {
        if (!lm.id || typeof lm.id !== 'string') {
            console.warn('validateLandmarks: dropping entry with missing/invalid id', lm);
            continue;
        }
        if (seen.has(lm.id)) {
            console.warn('validateLandmarks: dropping duplicate id', lm.id);
            continue;
        }
        if (typeof lm.x !== 'number' || typeof lm.y !== 'number' ||
            !Number.isInteger(lm.x) || !Number.isInteger(lm.y)) {
            console.warn('validateLandmarks: dropping entry with invalid x/y', lm.id);
            continue;
        }
        if (lm.x < 0 || lm.x >= WORLD_WIDTH || lm.y < 0 || lm.y >= WORLD_HEIGHT) {
            console.warn('validateLandmarks: dropping out-of-bounds landmark', lm.id, lm.x, lm.y);
            continue;
        }
        seen.add(lm.id);
        valid.push({
            id:     lm.id,
            x:      lm.x,
            y:      lm.y,
            label:  (typeof lm.label === 'string') ? lm.label : '',
            sprite: (typeof lm.sprite === 'string') ? lm.sprite : null
        });
    }
    return valid;
}

// Shared boot data (loaded once)
let BOOT_BUILDINGS_RAW = null;
let BOOT_DEFAULTS = FALLBACK_DEFAULTS;
let WORLD_DATA = null;

async function loadBootData() {
    let artistsRaw = null;
    try {
        const [aJSON, bJSON, wJSON] = await Promise.all([
            fetchJSON('data/artists.json'),
            fetchJSON('data/buildings.json'),
            fetchJSON('data/world.json').catch(function() { return null; })
        ]);
        artistsRaw = Array.isArray(aJSON.artists) ? aJSON.artists : null;
        BOOT_BUILDINGS_RAW = Array.isArray(bJSON.buildings) ? bJSON.buildings : null;
        if (bJSON.defaults) BOOT_DEFAULTS = bJSON.defaults;
        WORLD_DATA = wJSON;
    } catch (err) {
        console.error('loadBootData: fetch failed —', err.message);
    }

    if (!artistsRaw) {
        console.warn('loadBootData: no valid artists, using fallback');
        artistsRaw = [{ id: 'fallback1', name: 'GALLERY', bio: 'Art show loading...', instagram: null, images: [], regionId: 'na' }];
    }
    if (!BOOT_BUILDINGS_RAW) {
        console.warn('loadBootData: no valid buildings, using fallback');
        BOOT_BUILDINGS_RAW = [{ id: 'fb1', artistId: 'fallback1', priority: 0 }];
    }

    ARTISTS = validateArtists(artistsRaw);
    buildWorldMarkers();
    console.log('Boot data loaded: ' + Object.keys(ARTISTS).length + ' artists, world.json ' + (WORLD_DATA ? 'OK' : 'MISSING'));
}

function applyMapData(mapData) {
    if (mapData.world) {
        TILE_SIZE    = mapData.world.tileSize    || 64;
        if (typeof MP !== 'undefined' && MP.setTileSize) MP.setTileSize(TILE_SIZE);
        WORLD_WIDTH  = mapData.world.widthTiles  || 60;
        WORLD_HEIGHT = mapData.world.heightTiles || 40;
    }

    const w = WORLD_WIDTH, h = WORLD_HEIGHT, n = w * h;

    // ── Phase 1: Terrain grid ──
    // Load terrainGrid into MAP[][] as ground types. Terrain is ground, not roads.
    TERRAIN_GRID = null;
    if (Array.isArray(mapData.terrainGrid) && mapData.terrainGrid.length === h) {
        TERRAIN_GRID = mapData.terrainGrid;
    }

    // ── Phase 2: River overlay ──
    // Build from terrainGrid (type===4) when available, fallback to mapData.river
    RIVER_GRID = new Uint8Array(n);
    RIVER_COUNT = 0;
    if (TERRAIN_GRID) {
        for (let ty = 0; ty < h; ty++) {
            for (let tx = 0; tx < w; tx++) {
                if (TERRAIN_GRID[ty][tx] === 4) {
                    RIVER_GRID[ty * w + tx] = 1;
                    RIVER_COUNT++;
                }
            }
        }
    } else {
        const riv = validateRiver(Array.isArray(mapData.river) ? mapData.river : []);
        RIVER_GRID  = riv.grid;
        RIVER_COUNT = riv.count;
    }

    // ── Phase 3: Roads (highways + spurs from generator) ──
    // Support both legacy mapData.roads and new mapData.roadTiles (with type field)
    const rawRoads = Array.isArray(mapData.roadTiles) ? mapData.roadTiles
                   : Array.isArray(mapData.roads) ? mapData.roads : [];
    const roads = validateRoads(rawRoads);
    ROAD_GRID  = roads.grid;
    ROAD_COUNT = roads.count;

    // Build ROAD_TYPE_GRID from roadTiles (supports both legacy numeric `type`
    // and new urban planner string `class`: highway/arterial→2, local→1)
    ROAD_TYPE_GRID = new Uint8Array(n);
    for (const r of rawRoads) {
        if (typeof r.x !== 'number' || typeof r.y !== 'number') continue;
        if (r.x < 0 || r.x >= w || r.y < 0 || r.y >= h) continue;
        const key = r.y * w + r.x;
        var rtype = r.type || 1;
        if (r.class === 'highway' || r.class === 'arterial') rtype = 2;
        ROAD_TYPE_GRID[key] = rtype;
    }

    // New urban planner (roadGraph present) already handles town expansion,
    // highway widening, and 2-tile surface. Skip legacy Phase 4/4b.
    var hasNewUrbanPlan = Array.isArray(mapData.roadGraph) && mapData.roadGraph.length > 0;

    // Build centerline mask from roadGraph for autotile road rendering
    ROAD_CENTER_MASK = new Uint8Array(n);
    if (hasNewUrbanPlan) {
        for (var gi = 0; gi < mapData.roadGraph.length; gi++) {
            var rg = mapData.roadGraph[gi];
            if (typeof rg.x !== 'number' || typeof rg.y !== 'number') continue;
            if (rg.x < 0 || rg.x >= w || rg.y < 0 || rg.y >= h) continue;
            ROAD_CENTER_MASK[rg.y * w + rg.x] = rg.mask || 1;
        }
    }

    // ── Phase 4 (legacy): Town expansion (2-wide streets, city block grid) ──
    function placeRoadTile(rx, ry, roadType) {
        if (rx < 0 || rx >= w || ry < 0 || ry >= h) return;
        if (!TERRAIN_GRID[ry]) return;
        var terrain = TERRAIN_GRID[ry][rx];
        if (terrain !== 2 && terrain !== 3) return;
        var key = ry * w + rx;
        if (!ROAD_GRID[key]) { ROAD_GRID[key] = 1; ROAD_COUNT++; }
        if (!ROAD_TYPE_GRID[key]) ROAD_TYPE_GRID[key] = roadType || 1;
    }

    if (!hasNewUrbanPlan && Array.isArray(mapData.towns) && TERRAIN_GRID) {
        for (const t of mapData.towns) {
            var r = t.radius || 3;
            var blockSize = t.blockSize || 5;
            var streetPositions = [];
            streetPositions.push(-r);
            for (var sp = -r + blockSize; sp < r; sp += blockSize) {
                streetPositions.push(sp);
            }
            streetPositions.push(r);
            for (var si = 0; si < streetPositions.length; si++) {
                var sy = streetPositions[si];
                for (var dx = -r; dx <= r; dx++) {
                    placeRoadTile(t.x + dx, t.y + sy, 1);
                    placeRoadTile(t.x + dx, t.y + sy + 1, 1);
                }
            }
            for (var sj = 0; sj < streetPositions.length; sj++) {
                var sx = streetPositions[sj];
                for (var dy = -r; dy <= r; dy++) {
                    placeRoadTile(t.x + sx, t.y + dy, 1);
                    placeRoadTile(t.x + sx + 1, t.y + dy, 1);
                }
            }
        }
    }

    // ── Phase 4b (legacy): Widen highways to 3 tiles ──
    if (!hasNewUrbanPlan && ROAD_GRID && ROAD_TYPE_GRID && TERRAIN_GRID) {
        var hwExpand = [];
        for (var hk = 0; hk < n; hk++) {
            if (ROAD_TYPE_GRID[hk] !== 2) continue;
            var hx = hk % w, hy = (hk / w) | 0;
            var hasLeft  = hx > 0     && ROAD_TYPE_GRID[hk - 1] === 2;
            var hasRight = hx < w - 1 && ROAD_TYPE_GRID[hk + 1] === 2;
            var hasUp    = hy > 0     && ROAD_TYPE_GRID[hk - w] === 2;
            var hasDown  = hy < h - 1 && ROAD_TYPE_GRID[hk + w] === 2;
            var isHorizontal = hasLeft || hasRight;
            var isVertical = hasUp || hasDown;
            if (isHorizontal) {
                if (hy > 0) hwExpand.push({ x: hx, y: hy - 1 });
                if (hy < h - 1) hwExpand.push({ x: hx, y: hy + 1 });
            }
            if (isVertical) {
                if (hx > 0) hwExpand.push({ x: hx - 1, y: hy });
                if (hx < w - 1) hwExpand.push({ x: hx + 1, y: hy });
            }
        }
        for (var ei = 0; ei < hwExpand.length; ei++) {
            placeRoadTile(hwExpand[ei].x, hwExpand[ei].y, 1);
        }
    }

    // ── Phase 5: Bridge computation ──
    BRIDGE_GRID = new Uint8Array(n);
    BRIDGE_COUNT = 0;
    // New format: roadTiles with bridge:true flag
    if (hasNewUrbanPlan) {
        for (const r of rawRoads) {
            if (!r.bridge) continue;
            if (typeof r.x !== 'number' || typeof r.y !== 'number') continue;
            if (r.x < 0 || r.x >= w || r.y < 0 || r.y >= h) continue;
            var bkey = r.y * w + r.x;
            if (!BRIDGE_GRID[bkey]) { BRIDGE_GRID[bkey] = 1; BRIDGE_COUNT++; }
        }
    }
    // Legacy: detect bridges from road+river adjacency
    if (ROAD_GRID && RIVER_GRID) {
        for (let key = 0; key < n; key++) {
            if (BRIDGE_GRID[key]) continue;
            if (!ROAD_GRID[key]) continue;
            if (RIVER_GRID[key]) continue;
            const x = key % w;
            const y = (key / w) | 0;
            const left  = x > 0     ? RIVER_GRID[key - 1] : 0;
            const right = x < w - 1 ? RIVER_GRID[key + 1] : 0;
            const up    = y > 0     ? RIVER_GRID[key - w] : 0;
            const down  = y < h - 1 ? RIVER_GRID[key + w] : 0;
            const isCrossing = (left && right) || (up && down);
            if (isCrossing) {
                BRIDGE_GRID[key] = 1;
                BRIDGE_COUNT++;
            }
        }
    }

    // ── Phase 6: Buildings (artist placements + filler merged into BUILDINGS) ──
    const placements = Array.isArray(mapData.buildingPlacements) ? mapData.buildingPlacements : [];
    if (placements.length > 0) {
        const buildingDefs = validateBuildings(BOOT_BUILDINGS_RAW, BOOT_DEFAULTS, ARTISTS);
        BUILDINGS = applyPlacements(buildingDefs, placements, BOOT_DEFAULTS);
    } else {
        BUILDINGS = [];
    }

    // Merge filler buildings into BUILDINGS with artistId:null and default rects
    const defCR = FALLBACK_DEFAULTS.collisionRect;
    const defER = FALLBACK_DEFAULTS.enterRect;
    const defXR = FALLBACK_DEFAULTS.exitRect;
    const fillers = Array.isArray(mapData.fillerBuildings) ? mapData.fillerBuildings : [];
    for (const f of fillers) {
        const wx = f.x * TILE_SIZE;
        const wy = f.y * TILE_SIZE;
        BUILDINGS.push({
            id:           f.id,
            artistId:     null,
            buildingType: f.buildingType || 'shop',
            x:            f.x,
            y:            f.y,
            priority:     0,
            worldX:       wx,
            worldY:       wy,
            collisionWorld: { x: wx + defCR.ox, y: wy + defCR.oy, w: defCR.w, h: defCR.h },
            enterWorld:     { x: wx + defER.ox, y: wy + defER.oy, w: defER.w, h: defER.h },
            exitWorld:      { x: wx + defXR.ox, y: wy + defXR.oy, w: defXR.w, h: defXR.h }
        });
    }
    BUILDING_BY_ID = Object.fromEntries(BUILDINGS.map(function(b) { return [b.id, b]; }));
    FILLER_BUILDINGS = [];

    // ── Phase 7: Landmarks + Districts ──
    LANDMARKS = validateLandmarks(Array.isArray(mapData.landmarks) ? mapData.landmarks : []);
    // Support both y-band (legacy) and x-band (v3) districts
    DISTRICTS = Array.isArray(mapData.districts) ? mapData.districts.filter(function(d) {
        return d.id && (typeof d.x0 === 'number' || typeof d.y0 === 'number');
    }) : [];

    // ── Phase 7.3: Build blimp port list from landmarks ──
    game.blimpMenu.ports = LANDMARKS.filter(function(lm) { return lm.id.indexOf('lm_blimp_') === 0; });
    game.activeBlimpId = null;

    // ── Phase 10.12: Background buildings + streetscape props ──
    BG_BUILDINGS = Array.isArray(mapData.bgBuildings) ? mapData.bgBuildings : [];
    TOWN_PROPS = Array.isArray(mapData.townProps) ? mapData.townProps : [];
    _procParamCache = {};
    _procParamCacheSize = 0;

    // Build BG building collision grid using full footprint rectangles (SW anchor)
    BG_BUILDING_GRID = new Uint8Array(n);
    for (var bgi = 0; bgi < BG_BUILDINGS.length; bgi++) {
        var rect = getFootprintRect(BG_BUILDINGS[bgi]);
        for (var fy = rect.y0; fy < rect.y0 + rect.h; fy++) {
            for (var fx = rect.x0; fx < rect.x0 + rect.w; fx++) {
                if (fx >= 0 && fx < w && fy >= 0 && fy < h) {
                    BG_BUILDING_GRID[fy * w + fx] = 1;
                }
            }
        }
    }

    console.log('Map applied: ' + BUILDINGS.length + ' buildings, ' + FILLER_BUILDINGS.length + ' filler, ' + BG_BUILDINGS.length + ' bg, ' + TOWN_PROPS.length + ' props, ' + ROAD_COUNT + ' roads, ' + LANDMARKS.length + ' landmarks, ' + DISTRICTS.length + ' districts');
    buildRowBuckets();
    buildSidewalkGrid();
    buildDirtGrid();
    buildCollisionGrid();
    verifyDataIntegrity();
}

function spawnCollidesBuilding(px, py) {
    var pw = 128, ph = 128, inset = 24;
    var rx = px + inset, ry = py + inset, rw = pw - inset * 2, rh = ph - inset * 2;
    return rectHitsCollisionGrid(rx, ry, rw, rh) || rectHitsBuildingCollision(rx, ry, rw, rh);
}

// Verify a pixel position is drivable: the van (128x128) doesn't collide AND
// has at least MIN_FREE road/clear tiles in at least one cardinal direction so
// the player isn't boxed in immediately after spawning.
function isDrivableSpawn(px, py) {
    if (spawnCollidesBuilding(px, py)) return false;
    var pw = 128, ph = 128, inset = 24;
    var ts = TILE_SIZE;
    var minFree = 3; // need ≥ 3 clear tiles in at least 1 direction

    // Check each cardinal direction: can the van move minFree tiles that way?
    var dirs = [
        { dx: ts, dy: 0 }, { dx: -ts, dy: 0 },
        { dx: 0, dy: ts }, { dx: 0, dy: -ts }
    ];
    for (var di = 0; di < dirs.length; di++) {
        var clear = 0;
        for (var step = 1; step <= minFree; step++) {
            var nx = px + dirs[di].dx * step;
            var ny = py + dirs[di].dy * step;
            var rx = nx + inset, ry = ny + inset;
            var rw = pw - inset * 2, rh = ph - inset * 2;
            if (rx < 0 || ry < 0 || rx + rw > WORLD_WIDTH * ts || ry + rh > WORLD_HEIGHT * ts) break;
            if (rectHitsCollisionGrid(rx, ry, rw, rh)) break;
            if (rectHitsBuildingCollision(rx, ry, rw, rh)) break;
            clear++;
        }
        if (clear >= minFree) return true;
    }
    return false;
}

// Find a safe, drivable position near (cx, cy) tile coords. Spirals outward.
// Returns pixel coords { x, y } or null.
function findSafeDrivablePos(cx, cy, maxRadius, preferRoad) {
    var W = WORLD_WIDTH, H = WORLD_HEIGHT;
    for (var r = 0; r <= maxRadius; r++) {
        for (var dy = -r; dy <= r; dy++) {
            for (var dx = -r; dx <= r; dx++) {
                if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                var tx = cx + dx, ty = cy + dy;
                if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
                var k = ty * W + tx;
                if (preferRoad && ROAD_GRID && !ROAD_GRID[k]) continue;
                var px = tx * TILE_SIZE, py = ty * TILE_SIZE;
                if (isDrivableSpawn(px, py)) return { x: px, y: py };
            }
        }
    }
    // If preferRoad found nothing, retry without road requirement
    if (preferRoad) return findSafeDrivablePos(cx, cy, maxRadius, false);
    return null;
}

function findSpawnOnRoad() {
    var W = WORLD_WIDTH, H = WORLD_HEIGHT;

    // 1. Try lm_start landmark
    for (var li = 0; li < LANDMARKS.length; li++) {
        if (LANDMARKS[li].id === 'lm_start') {
            var lx = LANDMARKS[li].x, ly = LANDMARKS[li].y;
            var pos = findSafeDrivablePos(lx, ly, 20, true);
            if (pos) return pos;
            break;
        }
    }

    // 2. Find a highway tile (type=2) with good road density and drivability
    if (ROAD_GRID && ROAD_TYPE_GRID) {
        var bestKey = -1, bestRoads = 0;
        for (var k = 0; k < W * H; k++) {
            if (ROAD_TYPE_GRID[k] !== 2) continue;
            var kx = k % W, ky = (k / W) | 0;
            var px = kx * TILE_SIZE, py = ky * TILE_SIZE;
            if (!isDrivableSpawn(px, py)) continue;
            var roadCount = 0;
            for (var rdy = -2; rdy <= 2; rdy++) {
                for (var rdx = -2; rdx <= 2; rdx++) {
                    var rnx = kx + rdx, rny = ky + rdy;
                    if (rnx >= 0 && rnx < W && rny >= 0 && rny < H && ROAD_GRID[rny * W + rnx]) roadCount++;
                }
            }
            if (roadCount > bestRoads) { bestRoads = roadCount; bestKey = k; }
        }
        if (bestKey >= 0) {
            return { x: (bestKey % W) * TILE_SIZE, y: ((bestKey / W) | 0) * TILE_SIZE };
        }
    }

    // 3. Any drivable road tile
    if (ROAD_GRID) {
        for (var k2 = 0; k2 < W * H; k2++) {
            if (ROAD_GRID[k2]) {
                var rx = k2 % W, ry = (k2 / W) | 0;
                if (isDrivableSpawn(rx * TILE_SIZE, ry * TILE_SIZE))
                    return { x: rx * TILE_SIZE, y: ry * TILE_SIZE };
            }
        }
    }

    // 4. Any drivable land tile
    if (TERRAIN_GRID) {
        for (var gy = 0; gy < H; gy++) {
            for (var gx = 0; gx < W; gx++) {
                if (TERRAIN_GRID[gy][gx] >= 2 && isDrivableSpawn(gx * TILE_SIZE, gy * TILE_SIZE)) {
                    return { x: gx * TILE_SIZE, y: gy * TILE_SIZE };
                }
            }
        }
    }

    // 5. Absolute fallback: center of map
    return { x: (W >> 1) * TILE_SIZE, y: (H >> 1) * TILE_SIZE };
}

function buildRowBuckets() {
    var h = WORLD_HEIGHT;
    ROW_BG = new Array(h);
    ROW_BUILDINGS = new Array(h);
    ROW_PROPS = new Array(h);
    ROW_LANDMARKS = new Array(h);
    for (var r = 0; r < h; r++) {
        ROW_BG[r] = [];
        ROW_BUILDINGS[r] = [];
        ROW_PROPS[r] = [];
        ROW_LANDMARKS[r] = [];
    }
    for (var i = 0; i < BG_BUILDINGS.length; i++) {
        var bg = BG_BUILDINGS[i];
        if (bg.y >= 0 && bg.y < h) ROW_BG[bg.y].push(bg);
    }
    for (var j = 0; j < BUILDINGS.length; j++) {
        var b = BUILDINGS[j];
        if (b.y >= 0 && b.y < h) ROW_BUILDINGS[b.y].push(b);
    }
    for (var k = 0; k < TOWN_PROPS.length; k++) {
        var p = TOWN_PROPS[k];
        if (p.y >= 0 && p.y < h) ROW_PROPS[p.y].push(p);
    }
    for (var m = 0; m < LANDMARKS.length; m++) {
        var lm = LANDMARKS[m];
        if (lm.y >= 0 && lm.y < h) ROW_LANDMARKS[lm.y].push(lm);
    }
}

function buildCollisionGrid() {
    var w = WORLD_WIDTH, h = WORLD_HEIGHT, n = w * h;
    COLLISION_GRID = new Uint8Array(n);

    // Use TERRAIN_GRID (available now) rather than MAP (populated later by generateMap)
    // Terrain values: 0=ocean, 1=coast, 2=land, 3=mountain, 4=river
    // Only water (0), coast (1), and river (4) are impassable
    if (TERRAIN_GRID) {
        for (var y = 0; y < h; y++) {
            if (!TERRAIN_GRID[y]) continue;
            for (var x = 0; x < w; x++) {
                var terrain = TERRAIN_GRID[y][x] || 0;
                if (terrain === 0 || terrain === 1 || terrain === 4) {
                    COLLISION_GRID[y * w + x] = 1;
                }
            }
        }
    }

    // Mark BG building tiles (decorative — no enter zones)
    if (BG_BUILDING_GRID) {
        for (var k = 0; k < n; k++) {
            if (BG_BUILDING_GRID[k]) COLLISION_GRID[k] = 1;
        }
    }

    // NOTE: Enterable building collision rects are NOT in the tile grid.
    // They are checked as precise pixel-rect collisions in checkCollision /
    // checkTurtleCollision so the player can still reach the enterWorld zone.

    // Clear road and bridge tiles — they are always passable even over terrain/rivers
    if (ROAD_GRID) {
        for (var rk = 0; rk < n; rk++) {
            if (ROAD_GRID[rk]) COLLISION_GRID[rk] = 0;
        }
    }
    if (BRIDGE_GRID) {
        for (var bk = 0; bk < n; bk++) {
            if (BRIDGE_GRID[bk]) COLLISION_GRID[bk] = 0;
        }
    }

    // Sidewalk tiles are always passable (even if adjacent to BG buildings)
    if (SIDEWALK_GRID) {
        for (var sk = 0; sk < n; sk++) {
            if (SIDEWALK_GRID[sk]) COLLISION_GRID[sk] = 0;
        }
    }

    var blocked = 0;
    for (var ci = 0; ci < n; ci++) if (COLLISION_GRID[ci]) blocked++;
    console.log('Collision grid built: ' + blocked + '/' + n + ' tiles blocked (' +
        Math.round(blocked / n * 100) + '% of ' + w + 'x' + h + ')');
}

function buildSidewalkGrid() {
    var w = WORLD_WIDTH, h = WORLD_HEIGHT, n = w * h;
    SIDEWALK_GRID = new Uint8Array(n);
    if (!ROAD_GRID || !TERRAIN_GRID) return;
    var count = 0;
    for (var y = 0; y < h; y++) {
        if (!TERRAIN_GRID[y]) continue;
        for (var x = 0; x < w; x++) {
            var k = y * w + x;
            if (ROAD_GRID[k]) continue;
            var terrain = TERRAIN_GRID[y][x] || 0;
            if (terrain !== 2 && terrain !== 3) continue;
            if (BG_BUILDING_GRID && BG_BUILDING_GRID[k]) continue;
            var adjRoad = false;
            if (x > 0 && ROAD_GRID[k - 1]) adjRoad = true;
            if (!adjRoad && x < w - 1 && ROAD_GRID[k + 1]) adjRoad = true;
            if (!adjRoad && y > 0 && ROAD_GRID[k - w]) adjRoad = true;
            if (!adjRoad && y < h - 1 && ROAD_GRID[k + w]) adjRoad = true;
            if (adjRoad) { SIDEWALK_GRID[k] = 1; count++; }
        }
    }
    console.log('Sidewalk grid: ' + count + ' tiles');
}

function buildDirtGrid() {
    var w = WORLD_WIDTH, h = WORLD_HEIGHT, n = w * h;
    DIRT_GRID = new Uint8Array(n);
    if (!TERRAIN_GRID) return;
    var count = 0;
    for (var y = 0; y < h; y++) {
        if (!TERRAIN_GRID[y]) continue;
        for (var x = 0; x < w; x++) {
            var k = y * w + x;
            if (ROAD_GRID && ROAD_GRID[k]) continue;
            if (SIDEWALK_GRID && SIDEWALK_GRID[k]) continue;
            var terrain = TERRAIN_GRID[y][x] || 0;
            if (terrain !== 2 && terrain !== 3) continue;
            if (BG_BUILDING_GRID && BG_BUILDING_GRID[k]) continue;
            var adjBuilding = false;
            if (BG_BUILDING_GRID) {
                if (x > 0 && BG_BUILDING_GRID[k - 1]) adjBuilding = true;
                if (!adjBuilding && x < w - 1 && BG_BUILDING_GRID[k + 1]) adjBuilding = true;
                if (!adjBuilding && y > 0 && BG_BUILDING_GRID[k - w]) adjBuilding = true;
                if (!adjBuilding && y < h - 1 && BG_BUILDING_GRID[k + w]) adjBuilding = true;
            }
            if (!adjBuilding) {
                for (var bi = 0; bi < BUILDINGS.length; bi++) {
                    var c = BUILDINGS[bi].collisionWorld;
                    if (!c) continue;
                    var tileL = x * TILE_SIZE, tileR = tileL + TILE_SIZE;
                    var tileT = y * TILE_SIZE, tileB = tileT + TILE_SIZE;
                    var pad = TILE_SIZE;
                    if (tileR + pad > c.x && tileL - pad < c.x + c.w &&
                        tileB + pad > c.y && tileT - pad < c.y + c.h) {
                        adjBuilding = true; break;
                    }
                }
            }
            if (adjBuilding) { DIRT_GRID[k] = 1; count++; }
        }
    }
    console.log('Dirt grid: ' + count + ' tiles');
}

// Apply world map tile grid from WORLD_DATA.tiles — WORLD mode only
function applyWorldMapData() {
    if (!WORLD_DATA || !WORLD_DATA.world) return;
    TILE_SIZE    = WORLD_DATA.world.tileSize    || 32;
    WORLD_WIDTH  = WORLD_DATA.world.widthTiles  || 80;
    WORLD_HEIGHT = WORLD_DATA.world.heightTiles || 45;

    // Clear region-specific data
    BUILDINGS = [];
    BUILDING_BY_ID = {};
    ROAD_GRID = null;
    ROAD_TYPE_GRID = null;
    ROAD_COUNT = 0;
    RIVER_GRID = null;
    RIVER_COUNT = 0;
    BRIDGE_GRID = null;
    BRIDGE_COUNT = 0;
    TERRAIN_GRID = null;
    LANDMARKS = [];
    DISTRICTS = [];
    FILLER_BUILDINGS = [];
    BG_BUILDINGS = [];
    BG_BUILDING_GRID = null;
    COLLISION_GRID = null;
    SIDEWALK_GRID = null;
    DIRT_GRID = null;
    TOWN_PROPS = [];
    ROW_BG = []; ROW_BUILDINGS = []; ROW_PROPS = []; ROW_LANDMARKS = [];
    game.activeBlimpId = null;
    game.blimpMenu.active = false;
    game.blimpMenu.ports = [];
    game.blimpFade.active = false;

    WORLD_NODES = getWorldNodes();

    // Build MAP from world tile grid
    MAP.length = 0;
    var tiles = Array.isArray(WORLD_DATA.tiles) ? WORLD_DATA.tiles : null;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
        MAP[y] = [];
        for (let x = 0; x < WORLD_WIDTH; x++) {
            MAP[y][x] = (tiles && tiles[y] && typeof tiles[y][x] === 'number') ? tiles[y][x] : 0;
        }
    }

    console.log('World map applied: ' + WORLD_WIDTH + 'x' + WORLD_HEIGHT + ', ' + WORLD_NODES.length + ' nodes');
    verifyDataIntegrity();
}

async function loadMap(mapPath, reqId) {
    var myReqId = (typeof reqId === 'undefined') ? ++game.mapReqId : reqId;
    let mapData = null;
    try {
        mapData = await fetchJSON(mapPath);
    } catch (err) {
        console.error('loadMap: failed to load ' + mapPath + ' —', err.message);
    }
    if (myReqId !== game.mapReqId) {
        console.warn('loadMap: stale request (reqId ' + myReqId + ', current ' + game.mapReqId + '), ignoring');
        return false;
    }
    // Validate: must have world + terrainGrid with real data
    if (mapData && mapData.world && Array.isArray(mapData.terrainGrid) && mapData.terrainGrid.length > 10) {
        console.log('loadMap: loaded ' + mapPath + ' (' + mapData.world.widthTiles + 'x' + mapData.world.heightTiles + ', ' + (mapData.terrainGrid ? mapData.terrainGrid.length : 0) + ' terrain rows, ' + (mapData.buildingPlacements ? mapData.buildingPlacements.length : 0) + ' buildings)');
    } else if (mapData && mapData.world) {
        console.warn('loadMap: map from ' + mapPath + ' has world but missing/empty terrainGrid, attempting direct fetch bypass');
        try {
            var directResp = await (window._origFetch ? window._origFetch(mapPath, { cache: 'no-store' }) : fetch(mapPath + '?bypass=' + Date.now()));
            if (directResp.ok) {
                var directData = await directResp.json();
                if (directData && directData.world && Array.isArray(directData.terrainGrid) && directData.terrainGrid.length > 10) {
                    mapData = directData;
                    console.log('loadMap: direct fetch bypass succeeded for ' + mapPath);
                }
            }
        } catch (bypassErr) {
            console.warn('loadMap: bypass fetch also failed', bypassErr.message);
        }
    }
    if (!mapData || !mapData.world) {
        console.warn('loadMap: invalid map from ' + mapPath + ', using fallback');
        mapData = FALLBACK_MAP;
    }

    // Optional patch layer: try loading <region>.patch.json
    var patchPath = mapPath.replace('.json', '.patch.json');
    try {
        var patchData = await fetchJSON(patchPath);
        if (patchData && patchData.version) {
            mapData = applyPatch(mapData, patchData);
            console.log('Patch applied from ' + patchPath);
        }
    } catch (_) { /* no patch file, that is fine */ }

    applyMapData(mapData);
    if (myReqId !== game.mapReqId) {
        console.warn('loadMap: stale after applyMapData (reqId ' + myReqId + '), bailing');
        return false;
    }
    generateMap();
    return true;
}

function applyPatch(base, patch) {
    var result = JSON.parse(JSON.stringify(base));

    // Terrain overrides
    if (Array.isArray(patch.terrainOverrides) && Array.isArray(result.terrainGrid)) {
        for (var i = 0; i < patch.terrainOverrides.length; i++) {
            var to = patch.terrainOverrides[i];
            if (result.terrainGrid[to.y]) result.terrainGrid[to.y][to.x] = to.type;
        }
    }

    // ID-based overrides
    if (patch.overrides) {
        var collections = Object.keys(patch.overrides);
        for (var ci = 0; ci < collections.length; ci++) {
            var col = collections[ci];
            var arr = result[col];
            if (!Array.isArray(arr)) continue;
            var overrides = patch.overrides[col];
            var keys = Object.keys(overrides);
            for (var ki = 0; ki < keys.length; ki++) {
                var key = keys[ki];
                var vals = overrides[key];
                for (var ai = 0; ai < arr.length; ai++) {
                    var itemKey = arr[ai].id || arr[ai].buildingId || (arr[ai].x + ',' + arr[ai].y);
                    if (itemKey === key) { Object.assign(arr[ai], vals); break; }
                }
            }
        }
    }

    // Adds
    if (patch.adds) {
        var addCols = Object.keys(patch.adds);
        for (var aci = 0; aci < addCols.length; aci++) {
            var acol = addCols[aci];
            if (!Array.isArray(result[acol])) result[acol] = [];
            var items = patch.adds[acol];
            for (var ii = 0; ii < items.length; ii++) result[acol].push(items[ii]);
        }
    }

    // Deletes
    if (patch.deletes) {
        var delCols = Object.keys(patch.deletes);
        for (var dci = 0; dci < delCols.length; dci++) {
            var dcol = delCols[dci];
            if (!Array.isArray(result[dcol])) continue;
            var idSet = {};
            var ids = patch.deletes[dcol];
            for (var di = 0; di < ids.length; di++) idSet[ids[di]] = true;
            result[dcol] = result[dcol].filter(function(item) {
                var k = item.id || item.buildingId || (item.x + ',' + item.y);
                return !idSet[k];
            });
        }
    }

    return result;
}

// Backward-compatible wrapper (loads artists + buildings + default region map)
async function loadGameData() {
    await loadBootData();
    await loadMap('data/regions/na.json');
}

function verifyDataIntegrity() {
    let ok = true;
    const expected = WORLD_WIDTH * WORLD_HEIGHT;
    const mode = game.mode;
    function check(cond, msg) {
        if (!cond) { console.error('DATA INTEGRITY:', msg); ok = false; }
    }
    // Universal checks
    check(typeof TILE_SIZE === 'number' && TILE_SIZE > 0, 'TILE_SIZE must be a positive number, got ' + TILE_SIZE);
    check(typeof WORLD_WIDTH === 'number' && WORLD_WIDTH > 0, 'WORLD_WIDTH must be positive, got ' + WORLD_WIDTH);
    check(typeof WORLD_HEIGHT === 'number' && WORLD_HEIGHT > 0, 'WORLD_HEIGHT must be positive, got ' + WORLD_HEIGHT);
    check(Object.keys(ARTISTS).length > 0, 'ARTISTS is empty');

    if (mode === 'WORLD') {
        // World mode: no buildings, no districts, grids allowed to be null
        check(BUILDINGS.length === 0, 'WORLD mode: BUILDINGS should be empty, got ' + BUILDINGS.length);
        check(Object.keys(BUILDING_BY_ID).length === 0, 'WORLD mode: BUILDING_BY_ID should be empty');
        check(DISTRICTS.length === 0, 'WORLD mode: DISTRICTS should be empty, got ' + DISTRICTS.length);
        check(!ROAD_GRID   || ROAD_GRID.length   === expected, 'ROAD_GRID size mismatch');
        check(!RIVER_GRID  || RIVER_GRID.length  === expected, 'RIVER_GRID size mismatch');
        check(!BRIDGE_GRID || BRIDGE_GRID.length === expected, 'BRIDGE_GRID size mismatch');
        // World cleanup: region data must be cleared
        check(BG_BUILDINGS.length === 0, 'WORLD mode: BG_BUILDINGS not cleared, got ' + BG_BUILDINGS.length);
        check(TOWN_PROPS.length === 0, 'WORLD mode: TOWN_PROPS not cleared, got ' + TOWN_PROPS.length);
        check(ROW_BG.length === 0 || ROW_BUILDINGS.length === 0, 'WORLD mode: row buckets not cleared');
        check(!TERRAIN_GRID, 'WORLD mode: TERRAIN_GRID not cleared');
        check(!ROAD_TYPE_GRID, 'WORLD mode: ROAD_TYPE_GRID not cleared');
    } else {
        // Region mode: buildings required, grids required, districts expected
        check(BUILDINGS.length > 0, 'REGION mode: BUILDINGS is empty');
        check(Object.keys(BUILDING_BY_ID).length === BUILDINGS.length, 'BUILDING_BY_ID length (' + Object.keys(BUILDING_BY_ID).length + ') !== BUILDINGS length (' + BUILDINGS.length + ')');
        check(ROAD_GRID  && ROAD_GRID.length  === expected, 'ROAD_GRID size mismatch: expected ' + expected + ', got ' + (ROAD_GRID ? ROAD_GRID.length : 'null'));
        check(RIVER_GRID && RIVER_GRID.length === expected, 'RIVER_GRID size mismatch: expected ' + expected + ', got ' + (RIVER_GRID ? RIVER_GRID.length : 'null'));
        check(!BRIDGE_GRID || BRIDGE_GRID.length === expected, 'BRIDGE_GRID size mismatch: expected ' + expected + ', got ' + (BRIDGE_GRID ? BRIDGE_GRID.length : 'null'));
        check(DISTRICTS.length > 0, 'REGION mode: DISTRICTS is empty');

        // Row bucket integrity: lengths must match source arrays
        var totalRowBg = 0, totalRowBld = 0, totalRowProp = 0, totalRowLm = 0;
        for (var ri = 0; ri < ROW_BG.length; ri++) totalRowBg += ROW_BG[ri].length;
        for (var ri2 = 0; ri2 < ROW_BUILDINGS.length; ri2++) totalRowBld += ROW_BUILDINGS[ri2].length;
        for (var ri3 = 0; ri3 < ROW_PROPS.length; ri3++) totalRowProp += ROW_PROPS[ri3].length;
        for (var ri4 = 0; ri4 < ROW_LANDMARKS.length; ri4++) totalRowLm += ROW_LANDMARKS[ri4].length;
        check(totalRowBg === BG_BUILDINGS.length, 'ROW_BG total (' + totalRowBg + ') !== BG_BUILDINGS (' + BG_BUILDINGS.length + ')');
        check(totalRowBld === BUILDINGS.length, 'ROW_BUILDINGS total (' + totalRowBld + ') !== BUILDINGS (' + BUILDINGS.length + ')');
        check(totalRowProp === TOWN_PROPS.length, 'ROW_PROPS total (' + totalRowProp + ') !== TOWN_PROPS (' + TOWN_PROPS.length + ')');
        check(totalRowLm === LANDMARKS.length, 'ROW_LANDMARKS total (' + totalRowLm + ') !== LANDMARKS (' + LANDMARKS.length + ')');

        // BG buildings must not overlap enterables
        if (BG_BUILDINGS.length > 0) {
            var enterSet = new Set();
            for (var bi = 0; bi < BUILDINGS.length; bi++) enterSet.add(BUILDINGS[bi].y * WORLD_WIDTH + BUILDINGS[bi].x);
            var bgCollisions = 0;
            for (var bgi = 0; bgi < BG_BUILDINGS.length; bgi++) {
                var bgb = BG_BUILDINGS[bgi];
                if (enterSet.has(bgb.y * WORLD_WIDTH + bgb.x)) bgCollisions++;
            }
            check(bgCollisions === 0, bgCollisions + ' bg buildings overlap enterables at same tile');
        }

        // BG + props terrain validity
        if (TERRAIN_GRID) {
            var bgBadT = 0, propBadT = 0;
            for (var bti = 0; bti < BG_BUILDINGS.length; bti++) {
                var btt = TERRAIN_GRID[BG_BUILDINGS[bti].y] ? TERRAIN_GRID[BG_BUILDINGS[bti].y][BG_BUILDINGS[bti].x] : 0;
                if (btt !== 2 && btt !== 3) bgBadT++;
            }
            for (var pti = 0; pti < TOWN_PROPS.length; pti++) {
                var ptt = TERRAIN_GRID[TOWN_PROPS[pti].y] ? TERRAIN_GRID[TOWN_PROPS[pti].y][TOWN_PROPS[pti].x] : 0;
                var pk = TOWN_PROPS[pti].y * WORLD_WIDTH + TOWN_PROPS[pti].x;
                if (ptt !== 2 && ptt !== 3 && !(ROAD_GRID && ROAD_GRID[pk])) propBadT++;
            }
            if (bgBadT > 0) console.warn('DATA INTEGRITY: ' + bgBadT + ' bg buildings on invalid terrain');
            if (propBadT > 0) console.warn('DATA INTEGRITY: ' + propBadT + ' props on invalid terrain');
        }
    }
    if (ok) console.log('Integrity: mode=' + mode + ' ok');
}

// ============================================
// GAME STATE
// ============================================

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Dynamic screen size - will be set by resizeCanvas()
let CANVAS_WIDTH = window.innerWidth;
let CANVAS_HEIGHT = window.innerHeight;
let SCREEN_TILES_X = Math.ceil(CANVAS_WIDTH / TILE_SIZE);
let SCREEN_TILES_Y = Math.ceil(CANVAS_HEIGHT / TILE_SIZE);

function resizeCanvas() {
    CANVAS_WIDTH = window.innerWidth;
    CANVAS_HEIGHT = window.innerHeight;
    SCREEN_TILES_X = Math.ceil(CANVAS_WIDTH / TILE_SIZE) + 1;
    SCREEN_TILES_Y = Math.ceil(CANVAS_HEIGHT / TILE_SIZE) + 1;
    
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(CANVAS_WIDTH * dpr);
    canvas.height = Math.round(CANVAS_HEIGHT * dpr);
    canvas.style.width = CANVAS_WIDTH + 'px';
    canvas.style.height = CANVAS_HEIGHT + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
}

// Initial resize and listen for window changes
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

ctx.imageSmoothingEnabled = false;

const game = {
    player: {
        x: 3 * TILE_SIZE,
        y: 3 * TILE_SIZE,
        width: 128,
        height: 128,
        pxPerSecond: 300,    // 5 px/frame * 60fps = 300 px/sec
        direction: 'right',
        frame: 0,
        animTimer: 0,        // seconds accumulated
        animInterval: 0.083, // frame switch every ~83ms (was 5 frames at 60fps)
        moving: false
    },
    camera: {
        x: 0,
        y: 0,
        initialized: false
    },
    mode: 'REGION',              // 'WORLD', 'REGION', or 'LEVEL'
    currentRegionId: null,       // which region is loaded (null = none)
    state: 'OVERWORLD',
    transition: { active: false, dir: null, t: 0, duration: 0.25, targetBuildingId: null },
    mapTransition: { active: false, dir: null, t: 0, duration: 0.4, targetRegionId: null },
    mapReqId: 0,
    activeBuildingId: null,
    activeNodeId: null,          // world map: active region node
    overlay: {
        buildingId: null,
        artistId: null,
        heroIndex: 0,
        heroStatus: 'empty',
        heroReqId: 0
    },
    activeBlimpId: null,         // region: blimp port landmark nearby
    blimpMenu: { active: false, selectedIndex: 0, ports: [], activeLmId: null },
    blimpFade: { active: false, t: 0, duration: 0.35, targetPort: null, phase: null },
    activeTurtle: 'leo',
    controllerEntity: 'van',  // 'van' = driving party wagon, 'foot' = turtle on foot
    van: {
        x: 0, y: 0,           // parked position (world pixels)
        direction: 'right',    // last direction van was facing
        frame: 0
    },
    turtle: {
        x: 0, y: 0,
        width: 32, height: 32,
        pxPerSecond: 200,
        direction: 'down',
        frame: 0,
        animTimer: 0,
        animInterval: 0.12
    },
    level: null,
    levelState: null,
    levelReturnTile: null,
    levelReentryGrace: 0,
    progress: {
        levelWins: {},
        score: 0,
        bestScore: 0,
        scoreHistory: [],
        collectedItems: {},
        galleriesVisited: {},
        technodromeClear: false
    },
    // POI (roadside interactables)
    activePOI: null,               // { type, x, y } when near a POI
    speedBoost: 0,                 // seconds remaining for speed boost
    postcard: null,                // { text, timer } for viewpoint overlay
    poiHealReady: false,           // gas station refuel: next level starts at 5 HP
    technodromeMsg: null,
    technodromeMsgTimer: 0,
    showScoreBoard: false,
    debugZones: false,
    spritesReady: false,
    sprites: {},
    loaded: false,
    wagonFrames: {
        left: ['drive1', 'drive2'],
        right: ['drive1', 'drive2'],
        up: ['up1', 'up2'],
        down: ['down1', 'down2']
    }
};

// ============================================
// INPUT STATE — single source of truth for all input
// Keyboard and pointer events both write here.
// Movement code reads only from this.
// ============================================

const inputState = { up: false, down: false, left: false, right: false };

function clearInputState() {
    inputState.up = inputState.down = inputState.left = inputState.right = false;
}

// ============================================
// RECT UTILITIES
// ============================================

function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
}

function getPlayerRect() {
    if (game.controllerEntity === 'foot') {
        var t = game.turtle;
        return { x: t.x + 4, y: t.y + 4, w: t.width - 8, h: t.height - 8 };
    }
    var p = game.player;
    return { x: p.x + 24, y: p.y + 24, w: p.width - 48, h: p.height - 48 };
}

function rectCenter(r) {
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function distSq(a, b) {
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

// ============================================
// MAP DATA - Generate a bigger map
// 0=road, 1=building, 2=water, 3=sewer
// ============================================

const MAP = [];

function getDistrictForTileY(ty) {
    for (const d of DISTRICTS) {
        if (typeof d.y0 === 'number' && ty >= d.y0 && ty <= d.y1) return d.id;
    }
    return 'midtown';
}

function getDistrictForTile(tx, ty) {
    for (const d of DISTRICTS) {
        if (typeof d.x0 === 'number') {
            if (tx >= d.x0 && tx <= d.x1) return d.id;
        } else if (typeof d.y0 === 'number') {
            if (ty >= d.y0 && ty <= d.y1) return d.id;
        }
    }
    return 'midtown';
}

function generateMap() {
    MAP.length = 0;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
        MAP[y] = [];
        for (let x = 0; x < WORLD_WIDTH; x++) {
            if (TERRAIN_GRID && TERRAIN_GRID[y]) {
                // Use terrain from generator: 0=ocean, 1=coast, 2=land, 3=mountain, 4=river
                MAP[y][x] = TERRAIN_GRID[y][x] || 0;
            } else {
                // Legacy: district-based ground
                const dist = getDistrictForTileY(y);
                if (dist === 'downtown') {
                    MAP[y][x] = 3;
                } else if (dist === 'midtown') {
                    MAP[y][x] = 4;
                } else {
                    MAP[y][x] = 0;
                }
            }
        }
    }
}

// ============================================
// SPRITE LOADING
// ============================================

function loadSprite(name, src) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            game.sprites[name] = img;
            console.log(`Loaded: ${name} (${img.width}x${img.height})`);
            resolve(img);
        };
        img.onerror = () => {
            console.warn(`Failed to load: ${name}`);
            resolve(null);
        };
        img.src = src;
    });
}

// ============================================
// ============================================
// HI-RES BUILDING SPRITES (full web colors)
// ============================================

var HIRES_BUILDINGS = {};
var HIRES_BUILDING_DEFS = [
    { key: 'shop_spr',          src: 'sprites/buildings/shop.png',        w: 96,  h: 64 },
    { key: 'apt_med_spr',       src: 'sprites/buildings/apt_med.png',     w: 72,  h: 96 },
    { key: 'warehouse_spr',     src: 'sprites/buildings/warehouse.png',   w: 108, h: 64 },
    { key: 'apt_small_spr',     src: 'sprites/buildings/apt_small.png',   w: 96,  h: 64 },
    { key: 'apt_tall_spr',      src: 'sprites/buildings/apt_tall.png',    w: 52,  h: 128 },
    { key: 'chryslerBuilding',  src: 'sprites/buildings/chrysler.png',    w: 64,  h: 168 },
    { key: 'gas_spr',           src: 'sprites/buildings/gas_station.png', w: 128, h: 52 },
    { key: 'mall',              src: 'sprites/buildings/mall.png',        w: 128, h: 64 },
    { key: 'fastfood',          src: 'sprites/buildings/fastfood.png',    w: 128, h: 72 },
    { key: 'pizza',             src: 'sprites/buildings/pizza.png',       w: 108, h: 72 }
];

(function preloadHiresBuildings() {
    HIRES_BUILDING_DEFS.forEach(function(def) {
        var img = new Image();
        img.onload = function() {
            HIRES_BUILDINGS[def.key] = { img: img, w: def.w, h: def.h };
        };
        img.onerror = function() {
            console.warn('[hires] Failed to load ' + def.src);
        };
        img.src = def.src + '?v=1';
    });
})();

// SPRITE PACK SYSTEM
// ============================================

const DEFAULT_SPRITE_PACK_ID = 'default';
var SPRITE_PACK_LIST = ['default', 'neon_nes'];  // fallback, overwritten by index.json

async function loadPackRegistry() {
    try {
        var r = await fetch('sprites/packs/index.json', { cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        var data = await r.json();
        if (data && Array.isArray(data.packs) && data.packs.length > 0) {
            SPRITE_PACK_LIST = data.packs;
            console.log('Pack registry: ' + SPRITE_PACK_LIST.length + ' packs (' + SPRITE_PACK_LIST.join(', ') + ')');
        }
    } catch (e) {
        console.warn('Pack registry (sprites/packs/index.json) not found, using fallback list');
    }
}

function getUrlParam(name) {
    try {
        var u = new URL(window.location.href);
        return u.searchParams.get(name);
    } catch (_) {
        return null;
    }
}

function getActiveSpritePackId() {
    var p = getUrlParam('pack');
    if (p && typeof p === 'string' && p.length < 64) return p;
    return DEFAULT_SPRITE_PACK_ID;
}

function joinPath(a, b) {
    if (!a) return b;
    if (a[a.length - 1] === '/') a = a.slice(0, -1);
    if (b && b[0] === '/') b = b.slice(1);
    return a + '/' + b;
}

async function fetchJSON(path) {
    var r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) throw new Error('fetchJSON failed: ' + path + ' (' + r.status + ')');
    return await r.json();
}

async function loadSpritePackManifest(packId) {
    var base = { packId: packId, overrides: {}, aliases: {} };
    var packRoot = 'sprites/packs/' + packId;
    var manifestPath = joinPath(packRoot, 'manifest.json');
    try {
        var m = await fetchJSON(manifestPath);
        if (!m || typeof m !== 'object') return base;
        var overrides = (m.overrides && typeof m.overrides === 'object') ? m.overrides : {};
        var aliases = (m.aliases && typeof m.aliases === 'object') ? m.aliases : {};
        return { packId: packId, overrides: overrides, aliases: aliases };
    } catch (e) {
        console.warn('Sprite pack manifest not found or invalid: ' + manifestPath);
        return base;
    }
}

function buildSpriteManifestWithPack(baseManifest, packInfo) {
    var out = {};
    for (var k in baseManifest) out[k] = baseManifest[k];
    var packRoot = 'sprites/packs/' + packInfo.packId;
    var ov = packInfo.overrides || {};
    for (var k2 in ov) {
        var rel = ov[k2];
        if (typeof rel !== 'string' || !rel) continue;
        out[k2] = joinPath(packRoot, rel);
    }
    var packAliases = packInfo.aliases || {};
    return { manifest: out, packAliases: packAliases };
}

// Authoritative sprite manifest — every engine key mapped to its file
const SPRITE_MANIFEST = {
    // Reference sheets
    area1:             'sprites/area1.png',
    turtles:           'sprites/turtles.png',
    title:             'sprites/title.png',

    // Party Wagon
    drive1:            'sprites/partywagon/drive1.png',
    drive2:            'sprites/partywagon/drive2.png',
    down1:             'sprites/partywagon/down1.png',
    down2:             'sprites/partywagon/down2.png',
    up1:               'sprites/partywagon/up1.png',
    up2:               'sprites/partywagon/up2.png',

    // Ground tiles (district)
    roadTile:          'sprites/extracted/road_tile.png',
    road1:             'sprites/extracted/road_1.png',
    road2:             'sprites/extracted/road_2.png',
    sewerTile:         'sprites/extracted/sewer_tile.png',
    sewerTile2:        'sprites/extracted/sewer_tile_2.png',

    // Midtown ground (real tile — Area 3 red brick)
    midGround:         'sprites/extracted/mid_ground.png',

    // Road overlay (alias to roadTile until dedicated road overlay art is cut)
    roadOverlay:       'sprites/extracted/road_tile.png',

    // Bridge
    bridgeTile:        'sprites/extracted/bridge_tile.png',

    // Water
    waterTile:         'sprites/extracted/water_tile.png',
    waterEdge:         'sprites/extracted/water_edge_tile.png',

    // Landmarks
    lmGallery:         'sprites/extracted/lm_gallery.png',

    // Buildings
    building1:         'sprites/extracted/building_1.png',
    building2:         'sprites/extracted/building_2.png',
    building3:         'sprites/extracted/building_3.png',
    building4:         'sprites/extracted/building_4.png',
    galleryEntrance:   'sprites/extracted/gallery_entrance.png',
    buildingEntrance:  'sprites/extracted/building_entrance.png',

    // Building-type sprites (optional — procedural fallback when missing)
    buildingDiner:     'sprites/extracted/building_diner.png',
    buildingArcade:    'sprites/extracted/building_arcade.png',
    buildingGarage:    'sprites/extracted/building_garage.png',
    buildingToyShop:   'sprites/extracted/building_toy_shop.png',
    buildingWarehouse: 'sprites/extracted/building_warehouse.png',
    buildingHotel:     'sprites/extracted/building_hotel.png',

    // District ground skins (optional — fallback to DISTRICT_TERRAIN colors)
    groundWest:        'sprites/extracted/ground_west.png',
    groundMountain:    'sprites/extracted/ground_mountain.png',
    groundMidwest:     'sprites/extracted/ground_midwest.png',
    groundSouth:       'sprites/extracted/ground_south.png',
    groundNortheast:   'sprites/extracted/ground_northeast.png',

    // Level tiles (optional — fallback to procedural canvas draw)
    lvlFloorSewer:     'sprites/extracted/lvl_floor_sewer.png',
    lvlFloorStreet:    'sprites/extracted/lvl_floor_street.png',
    lvlFloorDock:      'sprites/extracted/lvl_floor_dock.png',
    lvlWallSewer:      'sprites/extracted/lvl_wall_sewer.png',
    lvlWallStreet:     'sprites/extracted/lvl_wall_street.png',
    lvlWallDock:       'sprites/extracted/lvl_wall_dock.png',
    lvlCrate:          'sprites/extracted/lvl_crate.png',
    lvlPipe:           'sprites/extracted/lvl_pipe.png',
    lvlDoor:           'sprites/extracted/lvl_door.png',
    enemyFoot:         'sprites/extracted/enemy_foot.png',
    enemyRanged:       'sprites/extracted/enemy_ranged.png',
    hitSpark:          'sprites/extracted/hit_spark.png',

    // Streetscape props (optional — fallback to procedural canvas draw)
    propLamp:          'sprites/extracted/prop_lamp.png',
    propDumpster:      'sprites/extracted/prop_dumpster.png',
    propPalm:          'sprites/extracted/prop_palm.png',
    propTree:          'sprites/extracted/prop_tree.png',
    propBench:         'sprites/extracted/prop_bench.png',
    propSignSmall:     'sprites/extracted/prop_sign_small.png',
    propVent:          'sprites/extracted/prop_vent.png',

    // New enemy types (optional)
    enemyShield:       'sprites/extracted/enemy_shield.png',
    enemyRunner:       'sprites/extracted/enemy_runner.png',

    // Hazard tiles (optional)
    hazardSludge:      'sprites/extracted/hazard_sludge.png',
    hazardCone:        'sprites/extracted/hazard_cone.png',
    hazardOil:         'sprites/extracted/hazard_oil.png',

    // World map (optional — fallback to colored rects)
    worldLand:         'sprites/world/land.png',
    worldCoast:        'sprites/world/coast.png',
    worldMountain:     'sprites/world/mountain.png',
    blimp:             'sprites/world/blimp1.png',
    blimp1:            'sprites/world/blimp1.png',
    blimp2:            'sprites/world/blimp2.png',
    blimp3:            'sprites/world/blimp3.png'
};

const REQUIRED_SPRITE_KEYS = [
    'roadTile', 'roadOverlay', 'waterTile', 'sewerTile', 'midGround',
    'building1', 'building2', 'building3', 'building4',
    'galleryEntrance', 'buildingEntrance',
    'drive1', 'drive2', 'down1', 'down2', 'up1', 'up2'
];

const OPTIONAL_SPRITE_KEYS = [
    'road1', 'road2', 'waterEdge', 'sewerTile2',
    'bridgeTile', 'lmGallery',
    'area1', 'turtles', 'title',
    'worldLand', 'worldCoast', 'worldMountain', 'blimp',
    'buildingDiner', 'buildingArcade', 'buildingGarage',
    'buildingToyShop', 'buildingWarehouse', 'buildingHotel',
    'groundWest', 'groundMountain', 'groundMidwest', 'groundSouth', 'groundNortheast',
    'lvlFloorSewer', 'lvlFloorStreet', 'lvlFloorDock',
    'lvlWallSewer', 'lvlWallStreet', 'lvlWallDock',
    'lvlCrate', 'lvlPipe', 'lvlDoor',
    'enemyFoot', 'enemyRanged', 'hitSpark',
    'bg_apt_small', 'bg_apt_tall', 'bg_office', 'bg_house', 'bg_shopfront', 'bg_warehouse_bg',
    // Streetscape props
    'propLamp', 'propDumpster', 'propPalm', 'propTree', 'propBench', 'propSignSmall', 'propVent',
    // Enemy types (12.2)
    'enemyShield', 'enemyRunner',
    // Hazard tiles (12.2)
    'hazardSludge', 'hazardCone', 'hazardOil'
];

const SPRITE_ALIASES = {
    roadOverlay: 'roadTile'
};

async function loadAllSprites() {
    var packId = getActiveSpritePackId();
    var packInfo = await loadSpritePackManifest(packId);

    var built = buildSpriteManifestWithPack(SPRITE_MANIFEST, packInfo);
    var finalManifest = built.manifest;
    var packAliases = built.packAliases;

    // 1) Dedup URLs
    var urlToKeys = {};
    for (var key in finalManifest) {
        var url = finalManifest[key];
        if (!url) continue;
        if (!urlToKeys[url]) urlToKeys[url] = [];
        urlToKeys[url].push(key);
    }

    var urls = Object.keys(urlToKeys);

    // 2) Load each unique URL once
    var urlToImage = {};
    await Promise.all(urls.map(function(url) {
        return new Promise(function(resolve) {
            var img = new Image();
            img.onload = function() {
                urlToImage[url] = img;
                resolve();
            };
            img.onerror = function() {
                console.warn('Sprite failed to load: ' + url);
                urlToImage[url] = null;
                resolve();
            };
            img.src = url;
        });
    }));

    // 3) Assign images to keys
    game.sprites = game.sprites || {};
    for (var u in urlToKeys) {
        var keys = urlToKeys[u];
        var img = urlToImage[u];
        for (var i = 0; i < keys.length; i++) {
            if (img) game.sprites[keys[i]] = img;
        }
    }

    // 4) Apply aliases (pack first, then global)
    function applyAliasMap(aliasMap) {
        if (!aliasMap) return;
        for (var ak in aliasMap) {
            var target = aliasMap[ak];
            if (!target) continue;
            if (game.sprites[target]) game.sprites[ak] = game.sprites[target];
        }
    }
    applyAliasMap(packAliases);
    applyAliasMap(SPRITE_ALIASES);

    game.loaded = true;

    // 5) Audit + coverage report
    var missingReq = [];
    for (var ri = 0; ri < REQUIRED_SPRITE_KEYS.length; ri++) {
        if (!game.sprites[REQUIRED_SPRITE_KEYS[ri]]) missingReq.push(REQUIRED_SPRITE_KEYS[ri]);
    }
    var missingOpt = [];
    for (var oi = 0; oi < OPTIONAL_SPRITE_KEYS.length; oi++) {
        if (!game.sprites[OPTIONAL_SPRITE_KEYS[oi]]) missingOpt.push(OPTIONAL_SPRITE_KEYS[oi]);
    }

    var overrideCount = Object.keys(packInfo.overrides).length;
    console.log('Sprites: ' + Object.keys(finalManifest).length + ' keys from ' + urls.length + ' unique URLs | pack=' + packId + (overrideCount ? ' (' + overrideCount + ' overrides)' : ''));
    if (missingReq.length) console.warn('Missing REQUIRED sprites:', missingReq.join(', '));
    if (Object.keys(packAliases).length > 0) console.log('Pack aliases:', Object.keys(packAliases).join(', '));
    console.log('Global aliases: ' + Object.entries(SPRITE_ALIASES).map(function(e) { return e[0] + ' -> ' + e[1]; }).join(', '));

    // Categorized coverage report
    var cats = {
        buildings: ['building1','building2','building3','building4','buildingDiner','buildingArcade','buildingGarage','buildingToyShop','buildingWarehouse','buildingHotel','galleryEntrance','buildingEntrance'],
        roads: ['roadTile','roadOverlay','road1','road2','bridgeTile'],
        water: ['waterTile','waterEdge'],
        terrain: ['sewerTile','sewerTile2','midGround','groundWest','groundMountain','groundMidwest','groundSouth','groundNortheast'],
        landmarks: ['lmGallery'],
        partywagon: ['drive1','drive2','down1','down2','up1','up2'],
        world: ['worldLand','worldCoast','worldMountain','blimp'],
        levels: ['lvlFloorSewer','lvlFloorStreet','lvlFloorDock','lvlWallSewer','lvlWallStreet','lvlWallDock','lvlCrate','lvlPipe','lvlDoor','enemyFoot','enemyRanged','enemyShield','enemyRunner','hitSpark','hazardSludge','hazardCone','hazardOil'],
        props: ['propLamp','propDumpster','propPalm','propTree','propBench','propSignSmall','propVent']
    };
    var catMissing = {};
    var totalMissing = 0;
    for (var cat in cats) {
        var missing = [];
        for (var ci = 0; ci < cats[cat].length; ci++) {
            if (!game.sprites[cats[cat][ci]]) missing.push(cats[cat][ci]);
        }
        if (missing.length > 0) { catMissing[cat] = missing; totalMissing += missing.length; }
    }
    if (totalMissing > 0) {
        console.log('%c── Pack Coverage ──', 'font-weight:bold');
        for (var cKey in catMissing) console.log('  ' + cKey + ': missing ' + catMissing[cKey].join(', '));
    }

    // Store for on-canvas badge
    game._packInfo = { id: packId, overrides: overrideCount, optMissing: totalMissing };
}

// ============================================
// CAMERA SYSTEM
// ============================================

function updateCamera(dt) {
    const p = game.player;
    
    let targetX = p.x + p.width / 2 - CANVAS_WIDTH / 2;
    let targetY = p.y + p.height / 2 - CANVAS_HEIGHT / 2;
    
    const maxX = WORLD_WIDTH * TILE_SIZE - CANVAS_WIDTH;
    const maxY = WORLD_HEIGHT * TILE_SIZE - CANVAS_HEIGHT;
    
    targetX = Math.max(0, Math.min(maxX, targetX));
    targetY = Math.max(0, Math.min(maxY, targetY));
    
    if (!game.camera.initialized) {
        game.camera.x = targetX;
        game.camera.y = targetY;
        game.camera.initialized = true;
        return;
    }
    
    // Lerp toward target (frame-rate independent)
    const smoothing = 8; // chase rate per second
    const t = Math.min(1, smoothing * dt);
    game.camera.x += (targetX - game.camera.x) * t;
    game.camera.y += (targetY - game.camera.y) * t;
}

function updateCameraTarget(cx, cy, dt) {
    var targetX = cx - CANVAS_WIDTH / 2;
    var targetY = cy - CANVAS_HEIGHT / 2;
    var maxX = WORLD_WIDTH * TILE_SIZE - CANVAS_WIDTH;
    var maxY = WORLD_HEIGHT * TILE_SIZE - CANVAS_HEIGHT;
    targetX = Math.max(0, Math.min(maxX, targetX));
    targetY = Math.max(0, Math.min(maxY, targetY));
    if (!game.camera.initialized) {
        game.camera.x = targetX;
        game.camera.y = targetY;
        game.camera.initialized = true;
        return;
    }
    var smoothing = 8;
    var t = Math.min(1, smoothing * dt);
    game.camera.x += (targetX - game.camera.x) * t;
    game.camera.y += (targetY - game.camera.y) * t;
}

// ============================================
// DRAWING WITH CAMERA OFFSET
// ============================================

// Per-district ground variant sets (no cross-contamination)
const UPTOWN_VARIANTS   = ['roadTile', 'road1'];
const MIDTOWN_VARIANTS  = ['midGround', 'road2'];
const DOWNTOWN_VARIANTS = ['sewerTile2', 'sewerTile2', 'sewerTile', 'sewerTile2'];

// Integer-only deterministic hash — no strings, no allocations
function tileHash(x, y) {
    return ((x * 73856093) ^ (y * 19349663)) >>> 0;
}

function districtVariantKey(x, y, variants) {
    return variants[tileHash(x, y) % variants.length];
}

function drawGroundSprite(px, py, spriteKey, fallbackColor) {
    const s = game.sprites[spriteKey];
    if (s) {
        ctx.drawImage(s, px, py, TILE_SIZE, TILE_SIZE);
    } else {
        var pat = (spriteKey === 'midGround' || spriteKey === 'road2') ? 'brickRed' :
                  (spriteKey === 'sewerTile' || spriteKey === 'sewerTile2') ? 'stoneBlock' :
                  'stoneBlockAlt';
        NES.drawTileStretched(ctx, px, py, TILE_SIZE, TILE_SIZE, pat);
    }
}

// District variant map keyed by tile type from generateMap
const DISTRICT_VARIANT_MAP = {
    0: UPTOWN_VARIANTS,
    3: DOWNTOWN_VARIANTS,
    4: MIDTOWN_VARIANTS
};

const DISTRICT_FALLBACK_MAP = {
    0: '#808080',
    3: '#4a3728',
    4: '#707060'
};

// Terrain type colors (used when TERRAIN_GRID is active)
const TERRAIN_COLORS = {
    0: '#1a3a5c', // ocean (dark blue)
    1: '#c8b878', // coast (sandy)
    2: '#4a7a3a', // land (green)
    3: '#8a7a6a', // mountain (gray-brown)
    4: '#2a5a8a', // river (blue — but river overlay usually covers this)
};

// District ground sprite keys (optional pack override for terrain)
const DISTRICT_GROUND_KEYS = {
    west_coast: 'groundWest',
    mountain:   'groundMountain',
    midwest:    'groundMidwest',
    south:      'groundSouth',
    northeast:  'groundNortheast'
};

// Per-district terrain tints for x-band districts (Phase 7.1)
// Each district gets a unique land/mountain/coast palette so regions feel distinct.
const DISTRICT_TERRAIN = {
    west_coast: { land: '#5a8a3a', mountain: '#a09070', coast: '#d4bc78' },
    mountain:   { land: '#3a7040', mountain: '#706058', coast: '#c8b878' },
    midwest:    { land: '#6a9a42', mountain: '#887868', coast: '#c8b878' },
    south:      { land: '#3a8a2a', mountain: '#888a68', coast: '#ccb878' },
    northeast:  { land: '#4a7848', mountain: '#887888', coast: '#c0b880' },
};

// Directional coast: detects which edges face water and draws
// grass base + sandy beach transition + water that matches the real water tiles
function drawCoastTile(px, py, tx, ty) {
    var ts = TILE_SIZE;
    var ww = WORLD_WIDTH, hh = WORLD_HEIGHT;

    // Check 4 cardinal + 4 diagonal neighbors for water (type 0)
    function isWater(nx, ny) {
        if (nx < 0 || nx >= ww || ny < 0 || ny >= hh) return true;
        if (!TERRAIN_GRID || !TERRAIN_GRID[ny]) return false;
        var t = TERRAIN_GRID[ny][nx];
        return t === 0 || t === 4;
    }
    var wN = isWater(tx, ty - 1);
    var wS = isWater(tx, ty + 1);
    var wW = isWater(tx - 1, ty);
    var wE = isWater(tx + 1, ty);
    var wNW = isWater(tx - 1, ty - 1);
    var wNE = isWater(tx + 1, ty - 1);
    var wSW = isWater(tx - 1, ty + 1);
    var wSE = isWater(tx + 1, ty + 1);

    // Start with grass base
    var grassIdx = NES.tileHash(tx, ty) % 4;
    var GRASS_PATS = ['grass1', 'grass2', 'grass3', 'grass4'];
    NES.drawTileStretched(ctx, px, py, ts, ts, GRASS_PATS[grassIdx]);

    // Beach sand strip width and water portion
    var sandW = Math.max(3, Math.round(ts * 0.15));
    var waterW = Math.max(6, Math.round(ts * 0.35));
    var totalEdge = sandW + waterW;

    // Sand colors: warm sandy transition
    var sandC = '#d4b870';
    var sandDarkC = '#b89850';
    var waterC = NES.PAL.B;   // #0070ec — matches waterBase
    var waveC = NES.PAL.C;    // #3cbcfc — matches water highlights
    var foamC = '#a0d8f8';

    // Draw water + sand on each edge that faces water
    // North edge: water at top, sand below it, rest is grass
    if (wN) {
        ctx.fillStyle = waterC;
        ctx.fillRect(px, py, ts, waterW);
        // Wave highlights
        ctx.fillStyle = waveC;
        var waveY = py + Math.max(1, waterW - 4);
        for (var wx = 0; wx < ts; wx += 6) {
            if ((NES.tileHash(tx * 16 + wx, ty) & 3) === 0)
                ctx.fillRect(px + wx, py + ((wx * 3 + ty * 7) % Math.max(1, waterW - 2)), 3, 1);
        }
        // Foam line
        ctx.fillStyle = foamC;
        ctx.fillRect(px, py + waterW - 2, ts, 1);
        // Sand strip
        ctx.fillStyle = sandC;
        ctx.fillRect(px, py + waterW, ts, sandW);
        ctx.fillStyle = sandDarkC;
        ctx.fillRect(px, py + waterW, ts, 1);
    }
    // South edge
    if (wS) {
        var sBase = py + ts - totalEdge;
        ctx.fillStyle = sandC;
        ctx.fillRect(px, sBase, ts, sandW);
        ctx.fillStyle = sandDarkC;
        ctx.fillRect(px, sBase + sandW - 1, ts, 1);
        ctx.fillStyle = foamC;
        ctx.fillRect(px, sBase + sandW, ts, 1);
        ctx.fillStyle = waterC;
        ctx.fillRect(px, sBase + sandW, ts, waterW);
        ctx.fillStyle = waveC;
        for (var wx2 = 0; wx2 < ts; wx2 += 6) {
            if ((NES.tileHash(tx * 16 + wx2, ty + 99) & 3) === 0)
                ctx.fillRect(px + wx2, sBase + sandW + 2 + ((wx2 * 5 + ty * 3) % Math.max(1, waterW - 4)), 3, 1);
        }
    }
    // West edge
    if (wW) {
        ctx.fillStyle = waterC;
        ctx.fillRect(px, py, waterW, ts);
        ctx.fillStyle = waveC;
        for (var wy = 0; wy < ts; wy += 6) {
            if ((NES.tileHash(tx, ty * 16 + wy) & 3) === 0)
                ctx.fillRect(px + ((wy * 3 + tx * 7) % Math.max(1, waterW - 2)), py + wy, 1, 3);
        }
        ctx.fillStyle = foamC;
        ctx.fillRect(px + waterW - 2, py, 1, ts);
        ctx.fillStyle = sandC;
        ctx.fillRect(px + waterW, py, sandW, ts);
        ctx.fillStyle = sandDarkC;
        ctx.fillRect(px + waterW, py, 1, ts);
    }
    // East edge
    if (wE) {
        var eBase = px + ts - totalEdge;
        ctx.fillStyle = sandC;
        ctx.fillRect(eBase, py, sandW, ts);
        ctx.fillStyle = sandDarkC;
        ctx.fillRect(eBase + sandW - 1, py, 1, ts);
        ctx.fillStyle = foamC;
        ctx.fillRect(eBase + sandW, py, 1, ts);
        ctx.fillStyle = waterC;
        ctx.fillRect(eBase + sandW, py, waterW, ts);
        ctx.fillStyle = waveC;
        for (var wy2 = 0; wy2 < ts; wy2 += 6) {
            if ((NES.tileHash(tx + 99, ty * 16 + wy2) & 3) === 0)
                ctx.fillRect(eBase + sandW + 2 + ((wy2 * 5 + tx * 3) % Math.max(1, waterW - 4)), py + wy2, 1, 3);
        }
    }

    // Corner fills: diagonal water neighbors where both cardinal edges aren't water
    // These create the rounded inner-corner beach effect
    var cornerR = Math.max(4, Math.round(ts * 0.25));
    if (wNW && !wN && !wW) {
        ctx.fillStyle = waterC;
        ctx.beginPath();
        ctx.arc(px, py, cornerR, 0, Math.PI * 0.5);
        ctx.lineTo(px, py);
        ctx.fill();
        ctx.fillStyle = sandC;
        ctx.beginPath();
        ctx.arc(px, py, cornerR + sandW, 0, Math.PI * 0.5);
        ctx.arc(px, py, cornerR, Math.PI * 0.5, 0, true);
        ctx.fill();
    }
    if (wNE && !wN && !wE) {
        ctx.fillStyle = waterC;
        ctx.beginPath();
        ctx.arc(px + ts, py, cornerR, Math.PI * 0.5, Math.PI);
        ctx.lineTo(px + ts, py);
        ctx.fill();
        ctx.fillStyle = sandC;
        ctx.beginPath();
        ctx.arc(px + ts, py, cornerR + sandW, Math.PI * 0.5, Math.PI);
        ctx.arc(px + ts, py, cornerR, Math.PI, Math.PI * 0.5, true);
        ctx.fill();
    }
    if (wSW && !wS && !wW) {
        ctx.fillStyle = waterC;
        ctx.beginPath();
        ctx.arc(px, py + ts, cornerR, -Math.PI * 0.5, 0);
        ctx.lineTo(px, py + ts);
        ctx.fill();
        ctx.fillStyle = sandC;
        ctx.beginPath();
        ctx.arc(px, py + ts, cornerR + sandW, -Math.PI * 0.5, 0);
        ctx.arc(px, py + ts, cornerR, 0, -Math.PI * 0.5, true);
        ctx.fill();
    }
    if (wSE && !wS && !wE) {
        ctx.fillStyle = waterC;
        ctx.beginPath();
        ctx.arc(px + ts, py + ts, cornerR, Math.PI, Math.PI * 1.5);
        ctx.lineTo(px + ts, py + ts);
        ctx.fill();
        ctx.fillStyle = sandC;
        ctx.beginPath();
        ctx.arc(px + ts, py + ts, cornerR + sandW, Math.PI, Math.PI * 1.5);
        ctx.arc(px + ts, py + ts, cornerR, Math.PI * 1.5, Math.PI, true);
        ctx.fill();
    }
}

function drawTile(x, y, type, rowVariants, distId) {
    const px = x * TILE_SIZE - game.camera.x;
    const py = y * TILE_SIZE - game.camera.y;

    if (px < -TILE_SIZE || px > CANVAS_WIDTH || py < -TILE_SIZE || py > CANVAS_HEIGHT) return;

    ctx.imageSmoothingEnabled = false;

    if (TERRAIN_GRID) {
        if (type === 2 && distId) {
            var groundKey = DISTRICT_GROUND_KEYS[distId];
            var groundSprite = groundKey ? game.sprites[groundKey] : null;
            if (groundSprite) {
                ctx.drawImage(groundSprite, px, py, TILE_SIZE, TILE_SIZE);
                return;
            }
        }
        var nesPat;
        var GRASS_PATS = ['grass1', 'grass2', 'grass3', 'grass4'];
        if (type === 0) nesPat = NES.waterFrame();
        else if (type === 4) nesPat = NES.waterFrame();
        else if (type === 1) {
            drawCoastTile(px, py, x, y);
            return;
        }
        else if (type === 3) nesPat = 'mountain';
        else nesPat = GRASS_PATS[NES.tileHash(x, y) % 4];

        // Canal wall: LAND tiles (type 2) adjacent to RIVER (type 4)
        // NES isometric perspective (NW camera looking down-SE):
        //   North bank (canalWallSouth) = PROMINENT deep wall face (south-facing, visible)
        //   South bank (canalWallNorth) = SUBTLE thin shadow edge (north-facing, hidden)
        //   West bank (canalWallEast)   = PROMINENT vertical wall strip (east-facing, visible)
        //   East bank (canalWallWest)   = SUBTLE thin shadow strip (west-facing, hidden)
        if (type === 2) {
            var rS = y < WORLD_HEIGHT-1 && TERRAIN_GRID[y+1] && TERRAIN_GRID[y+1][x] === 4;
            var rN = y > 0 && TERRAIN_GRID[y-1] && TERRAIN_GRID[y-1][x] === 4;
            if (rS) { nesPat = 'canalWallSouth'; }
            else if (rN) { nesPat = 'canalWallNorth'; }
        }
        NES.drawTileStretched(ctx, px, py, TILE_SIZE, TILE_SIZE, nesPat);
        if (type === 2) {
            var rW = x > 0 && TERRAIN_GRID[y][x-1] === 4;
            var rE = x < WORLD_WIDTH-1 && TERRAIN_GRID[y][x+1] === 4;
            if (rW) {
                NES.drawSprite(ctx, px, py, 'canalWallWest', TILE_SIZE / 16);
            }
            if (rE) {
                NES.drawSprite(ctx, px, py, 'canalWallEast', TILE_SIZE / 16);
            }
            // Outer corner accents: diagonal-only water (no cardinal water on that side)
            // creates isometric shadow where two wall faces would meet
            var sc = TILE_SIZE / 16;
            var ts = TILE_SIZE;
            // SE corner: most prominent (both south+east walls visible from NW camera)
            if (!rS && !rE && y < WORLD_HEIGHT-1 && x < WORLD_WIDTH-1 &&
                TERRAIN_GRID[y+1] && TERRAIN_GRID[y+1][x+1] === 4) {
                ctx.fillStyle = NES.PAL.K;
                ctx.fillRect(px + ts - 4*sc, py + ts - 4*sc, 4*sc, 4*sc);
                ctx.fillStyle = NES.PAL.N;
                ctx.fillRect(px + ts - 3*sc, py + ts - 3*sc, 3*sc, 3*sc);
            }
            // SW corner: south wall prominent, west subtle
            if (!rS && !rW && y < WORLD_HEIGHT-1 && x > 0 &&
                TERRAIN_GRID[y+1] && TERRAIN_GRID[y+1][x-1] === 4) {
                ctx.fillStyle = NES.PAL.K;
                ctx.fillRect(px, py + ts - 3*sc, 3*sc, 3*sc);
                ctx.fillStyle = NES.PAL.N;
                ctx.fillRect(px + sc, py + ts - 2*sc, 2*sc, 2*sc);
            }
            // NE corner: east wall prominent, north subtle
            if (!rN && !rE && y > 0 && x < WORLD_WIDTH-1 &&
                TERRAIN_GRID[y-1] && TERRAIN_GRID[y-1][x+1] === 4) {
                ctx.fillStyle = NES.PAL.K;
                ctx.fillRect(px + ts - 3*sc, py, 3*sc, 3*sc);
                ctx.fillStyle = NES.PAL.N;
                ctx.fillRect(px + ts - 2*sc, py + sc, 2*sc, 2*sc);
            }
            // NW corner: both walls face away = minimal shadow
            if (!rN && !rW && y > 0 && x > 0 &&
                TERRAIN_GRID[y-1] && TERRAIN_GRID[y-1][x-1] === 4) {
                ctx.fillStyle = NES.PAL.K;
                ctx.fillRect(px, py, 2*sc, 2*sc);
            }
        }

        // Grass-to-road edge transition: worn dirt strip on the grass side
        if (type === 2 && ROAD_GRID) {
            var tKey = y * WORLD_WIDTH + x;
            if (!ROAD_GRID[tKey] && !(SIDEWALK_GRID && SIDEWALK_GRID[tKey]) && !(DIRT_GRID && DIRT_GRID[tKey])) {
                var edgeW = Math.max(3, Math.round(TILE_SIZE * 0.10));
                ctx.fillStyle = NES.PAL.U || '#886830';
                ctx.globalAlpha = 0.45;
                if (x > 0 && (ROAD_GRID[tKey - 1] || (SIDEWALK_GRID && SIDEWALK_GRID[tKey - 1])))
                    ctx.fillRect(px, py, edgeW, TILE_SIZE);
                if (x < WORLD_WIDTH - 1 && (ROAD_GRID[tKey + 1] || (SIDEWALK_GRID && SIDEWALK_GRID[tKey + 1])))
                    ctx.fillRect(px + TILE_SIZE - edgeW, py, edgeW, TILE_SIZE);
                if (y > 0 && (ROAD_GRID[tKey - WORLD_WIDTH] || (SIDEWALK_GRID && SIDEWALK_GRID[tKey - WORLD_WIDTH])))
                    ctx.fillRect(px, py, TILE_SIZE, edgeW);
                if (y < WORLD_HEIGHT - 1 && (ROAD_GRID[tKey + WORLD_WIDTH] || (SIDEWALK_GRID && SIDEWALK_GRID[tKey + WORLD_WIDTH])))
                    ctx.fillRect(px, py + TILE_SIZE - edgeW, TILE_SIZE, edgeW);
                ctx.globalAlpha = 1.0;
            }
        }
        return;
    }

    const variants = rowVariants || DISTRICT_VARIANT_MAP[type];
    if (variants) {
        drawGroundSprite(px, py, districtVariantKey(x, y, variants), DISTRICT_FALLBACK_MAP[type] || '#808080');
    } else {
        var fallbackGrass = ['grass1', 'grass2', 'grass3', 'grass4'];
        NES.drawTileStretched(ctx, px, py, TILE_SIZE, TILE_SIZE, fallbackGrass[NES.tileHash(x, y) % 4]);
    }
}

// Deterministic building wall variant from buildingId
const BUILDING_WALL_KEYS = ['building1', 'building2', 'building3', 'building4'];

// ── Background building kinds (non-enterable city mass) ─────────
const BG_KIND_DRAW = {
    apt_small:    { color: '#5a5a6a', h: 0.8, windows: 2, custom: 'apt_small_spr' },
    apt_tall:     { color: '#4a4a5a', h: 1.3, windows: 4, custom: 'apt_tall_spr' },
    office:       { color: '#606878', h: 1.2, windows: 3, custom: 'apt_med_spr' },
    house:        { color: '#7a6a5a', h: 0.6, windows: 1, custom: 'apt_small_spr' },
    shopfront:    { color: '#6a5a4a', h: 0.7, windows: 1, custom: 'shop_spr' },
    warehouse_bg: { color: '#505050', h: 0.9, windows: 0, custom: 'warehouse_spr' },
    shop:         { color: '#6a5a4a', h: 0.7, windows: 1, custom: 'shop_spr' },
    apt_med:      { color: '#606878', h: 1.2, windows: 3, custom: 'apt_med_spr' },
    warehouse:    { color: '#505050', h: 0.9, windows: 0, custom: 'warehouse_spr' },
    gas_station:  { color: '#bcbcbc', h: 0.7, windows: 0, custom: 'gas_spr' },
    temple:       { color: '#8a3020', h: 1.1, windows: 0, custom: 'temple' },
    mosque:       { color: '#e8e0d0', h: 1.2, windows: 0, custom: 'mosque' },
    tower:        { color: '#c04020', h: 1.8, windows: 0, custom: 'tower' },
    palace:       { color: '#c8a848', h: 1.0, windows: 0, custom: 'palace' },
    gate:         { color: '#a04030', h: 0.9, windows: 0, custom: 'gate' },
    monument:     { color: '#b0b0b0', h: 1.0, windows: 0, custom: 'monument' },
    mall:         { color: '#bcbcbc', h: 0.8, windows: 0, custom: 'mall' },
    fastfood:     { color: '#bcbcbc', h: 0.7, windows: 0, custom: 'fastfood' },
    pizza:        { color: '#c04020', h: 0.8, windows: 0, custom: 'pizza' }
};
const BG_KINDS = Object.keys(BG_KIND_DRAW);
const PROP_SPRITE_KEYS = {
    lamppost: 'propLamp', dumpster: 'propDumpster', palm: 'propPalm',
    tree: 'propTree', bench: 'propBench', vent: 'propVent', sign: 'propSignSmall'
};
function buildingHash(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    return (h >>> 0) % BUILDING_WALL_KEYS.length;
}

// ── Phase 7.2: Building type sprite dispatch + procedural fallbacks ──

const BUILDING_TYPE_SPRITE_KEYS = {
    diner: 'buildingDiner', arcade: 'buildingArcade',
    garage: 'buildingGarage', toy_shop: 'buildingToyShop',
    warehouse: 'buildingWarehouse', hotel: 'buildingHotel',
    dimension_x: 'buildingDimensionX'
};

const SIGN_COLORS = {
    diner: '#e04040', arcade: '#40a0e0', garage: '#808080',
    toy_shop: '#e0a020', warehouse: '#606060', hotel: '#a060c0',
    dimension_x: '#8800ff'
};
const SIGN_TAGS = {
    diner: 'DIN', arcade: 'ARC', garage: 'GAR',
    toy_shop: 'TOY', warehouse: 'WHS', hotel: 'HOT',
    dimension_x: 'DIM-X'
};

function drawBldgSprite(x, y, bw, bh, patKey, signText, signBg, neon) {
    NES.drawSprite(ctx, x, y, patKey, 4);
    if (signText) {
        var signW = Math.min(60, signText.length * 7 + 12);
        var signH = 12;
        var signX = x + (64 - signW) / 2;
        var signY = y + 60;
        ctx.fillStyle = signBg || NES.PAL.N;
        ctx.fillRect(signX, signY, signW, signH);
        ctx.strokeStyle = NES.PAL.K;
        ctx.lineWidth = 1;
        ctx.strokeRect(signX, signY, signW, signH);
        ctx.fillStyle = NES.PAL.W;
        ctx.font = '7px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(signText, signX + signW / 2, signY + signH / 2 + 1);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
    }
    if (neon) {
        var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
        ctx.strokeStyle = 'rgba(60,188,252,' + pulse.toFixed(2) + ')';
        ctx.lineWidth = 3;
        ctx.strokeRect(x + 2, y + 2, bw - 4, bh - 4);
    }
}

function drawBuildingDiner(x, y, bw, bh) {
    drawBldgSprite(x, y, bw, bh, 'bldgGrayRed', 'DINER', NES.PAL.R);
}

function drawBuildingArcade(x, y, bw, bh) {
    drawBldgSprite(x, y, bw, bh, 'bldgGrayBlue', 'ARCADE', NES.PAL.K, true);
}

function drawBuildingGarage(x, y, bw, bh) {
    drawBldgSprite(x, y, bw, bh, 'bldgGrayBlue', 'GARAGE', NES.PAL.G);
}

function drawBuildingToyShop(x, y, bw, bh) {
    drawBldgSprite(x, y, bw, bh, 'bldgGrayBlue', 'TOYS', NES.PAL.P);
}

function drawBuildingWarehouse(x, y, bw, bh) {
    drawBldgSprite(x, y, bw, bh, 'bldgGrayBlue', 'WHS', NES.PAL.G);
}

function drawBuildingHotel(x, y, bw, bh) {
    drawBldgSprite(x, y, bw, bh, 'bldgGrayRed', 'HOTEL', NES.PAL.R);
}

const BUILDING_TYPE_DRAWERS = {
    diner: drawBuildingDiner, arcade: drawBuildingArcade,
    garage: drawBuildingGarage, toy_shop: drawBuildingToyShop,
    warehouse: drawBuildingWarehouse, hotel: drawBuildingHotel,
    dimension_x: drawBuildingDimensionX
};

function drawBuildingDimensionX(x, y, bw, bh) {
    var unlocked = Object.keys(game.progress.collectedItems).length >= 10;
    drawBldgSprite(x, y, bw, bh, 'bldgRedBlue', 'DIM-X', NES.PAL.N, unlocked);
    if (!unlocked) {
        ctx.strokeStyle = NES.PAL.P;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x + 20, y + 40); ctx.lineTo(x + bw - 20, y + bh - 20);
        ctx.moveTo(x + bw - 20, y + 40); ctx.lineTo(x + 20, y + bh - 20);
        ctx.stroke();
        ctx.fillStyle = NES.PAL.R;
        ctx.font = 'bold 8px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('LOCKED', x + bw / 2, y + bh / 2 + 3);
        ctx.textAlign = 'left';
    }
}

function drawBuilding(b, index) {
    const sx = b.worldX - game.camera.x;
    const sy = b.worldY - game.camera.y;

    if (sx < -128 || sx > CANVAS_WIDTH + 128 || sy < -128 || sy > CANVAS_HEIGHT + 128) return;

    const isActive = b.id === game.activeBuildingId;
    ctx.imageSmoothingEnabled = false;

    const bw = 128, bh = 128;
    const ox = (TILE_SIZE - bw) / 2;
    const oy = TILE_SIZE - bh;
    const bx = sx + ox, by = sy + oy;

    const bt = b.buildingType;
    const hasArtist = b.artistId && ARTISTS[b.artistId];
    const isGallery = !bt || bt === 'gallery';

    if (isGallery) {
        // Gallery: wall texture + gallery entrance
        // Check if visited for green tint
        var galleryVisited = b.artistId && game.progress.galleriesVisited[b.artistId];
        const wallKey = BUILDING_WALL_KEYS[buildingHash(b.id)];
        const wallSprite = game.sprites[wallKey];
        if (wallSprite) {
            ctx.drawImage(wallSprite, bx, by, bw, bh);
        } else {
            NES.drawSprite(ctx, bx, by, 'bldgGrayBlue', 4);
        }
        const entranceSprite = game.sprites.galleryEntrance;
        if (entranceSprite) {
            ctx.drawImage(entranceSprite, bx, by, bw, bh);
        }
        // Visited tint overlay
        if (galleryVisited) {
            ctx.fillStyle = 'rgba(0, 128, 0, 0.15)';
            ctx.fillRect(bx, by, bw, bh);
            // "VISITED" tag
            ctx.fillStyle = '#408040';
            ctx.fillRect(bx + 8, by - 2, bw - 16, 12);
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.strokeRect(bx + 8, by - 2, bw - 16, 12);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 7px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('VISITED', bx + bw / 2, by + 8);
            ctx.textAlign = 'left';
        }
        // Subtle pulse glow when active (approaching)
        if (isActive) {
            var glowAlpha = Math.sin(Date.now() / 300) * 0.1 + 0.1;
            ctx.fillStyle = 'rgba(255, 136, 255, ' + glowAlpha + ')';
            ctx.fillRect(bx, by, bw, bh);
        }
    } else {
        // Non-gallery: type-specific sprite or procedural fallback
        var typeSpriteKey = BUILDING_TYPE_SPRITE_KEYS[bt];
        var typeSprite = typeSpriteKey ? game.sprites[typeSpriteKey] : null;
        if (typeSprite) {
            ctx.drawImage(typeSprite, bx, by, bw, bh);
        } else {
            var drawer = BUILDING_TYPE_DRAWERS[bt];
            if (drawer) {
                drawer(bx, by, bw, bh);
            } else {
                // Unknown type: pixel-perfect sprite fallback
                const wallKey = BUILDING_WALL_KEYS[buildingHash(b.id)];
                const wallSprite = game.sprites[wallKey];
                if (wallSprite) {
                    ctx.drawImage(wallSprite, bx, by, bw, bh);
                } else {
                    NES.drawSprite(ctx, bx, by, 'bldgGrayBlue', 4);
                }
                const entranceSprite = game.sprites.buildingEntrance;
                if (entranceSprite) ctx.drawImage(entranceSprite, bx, by, bw, bh);
            }
        }
        // Sign tag label (compact, on top of all non-gallery buildings)
        var signColor = SIGN_COLORS[bt] || '#808080';
        var signTag = SIGN_TAGS[bt] || bt.substring(0, 3).toUpperCase();
        // Check if this building's level has been cleared
        var levelSeed = (game.currentRegionId || 'na') + ':' + b.id;
        var bCleared = game.progress.levelWins[levelSeed];
        if (bCleared && (bt === 'arcade' || bt === 'warehouse' || bt === 'dimension_x')) {
            signColor = '#408040';
            signTag = 'CLR';
        }
        ctx.fillStyle = signColor;
        ctx.fillRect(bx + 8, by - 2, bw - 16, 12);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx + 8, by - 2, bw - 16, 12);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(signTag, bx + bw / 2, by + 8);
        ctx.textAlign = 'left';
    }

    // Building number badge (artist buildings only)
    if (hasArtist) {
        ctx.fillStyle = '#000';
        ctx.fillRect(sx + 12, sy + 20, 10, 10);
        ctx.fillStyle = '#fcfc00';
        ctx.font = 'bold 8px monospace';
        ctx.fillText((index + 1).toString(), sx + 14, sy + 28);
    }

    // Active highlight
    if (isActive) {
        const pulse = Math.sin(Date.now() / 150) * 0.4 + 0.6;
        ctx.strokeStyle = 'rgba(252, 252, 0, ' + pulse + ')';
        ctx.lineWidth = 3;
        ctx.strokeRect(bx - 2, by - 2, bw + 4, bh + 4);

        const arrowY = by - 16 + Math.sin(Date.now() / 200) * 5;
        ctx.fillStyle = '#fcfc00';
        ctx.beginPath();
        ctx.moveTo(sx + 16, arrowY + 10);
        ctx.lineTo(sx + 10, arrowY);
        ctx.lineTo(sx + 22, arrowY);
        ctx.closePath();
        ctx.fill();
    }
}

// Map wagon frame keys (from wagonFrames) to NES pattern names
var WAGON_PATTERN_MAP = {
    drive1: 'wagonRight1', drive2: 'wagonRight2',
    up1: 'wagonUp1', up2: 'wagonUp2',
    down1: 'wagonDown1', down2: 'wagonDown2'
};

function drawPartyWagon() {
    var p = game.player;

    var screenX = p.x - game.camera.x;
    var screenY = p.y - game.camera.y;

    var frameSet = game.wagonFrames[p.direction];
    var frameKey = frameSet[p.frame % frameSet.length];
    var flipX = (p.direction === 'left');

    var drawW = p.width || 128;
    var drawH = p.height || 128;
    var patKey = WAGON_PATTERN_MAP[frameKey];

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(screenX + drawW / 2, screenY + drawH / 2);
    if (flipX) ctx.scale(-1, 1);

    if (patKey) {
        var scale = drawW / 32;
        NES.drawSprite(ctx, -drawW / 2, -drawH / 2, patKey, scale);
    }

    ctx.restore();
}

function drawParkedVan() {
    var v = game.van;
    var p = game.player;
    var screenX = v.x - game.camera.x;
    var screenY = v.y - game.camera.y;

    var flipX = (v.direction === 'left');
    var drawW = p.width || 128;
    var drawH = p.height || 128;

    var patKey;
    if (v.direction === 'left' || v.direction === 'right') {
        patKey = 'wagonRight5';
    } else {
        var frameSet = game.wagonFrames[v.direction];
        var frameKey = frameSet[0];
        patKey = WAGON_PATTERN_MAP[frameKey];
    }

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.85;
    ctx.translate(screenX + drawW / 2, screenY + drawH / 2);
    if (flipX) ctx.scale(-1, 1);
    if (patKey) {
        var scale = drawW / 32;
        NES.drawSprite(ctx, -drawW / 2, -drawH / 2, patKey, scale);
    }
    ctx.restore();

    // "Press T" hint near van when turtle is far
    if (getVanReenterDist() > p.width * 2) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(screenX + drawW / 2 - 20, screenY - 14, 40, 12);
        ctx.fillStyle = '#aaa';
        ctx.font = '7px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('VAN [T]', screenX + drawW / 2, screenY - 5);
        ctx.textAlign = 'left';
    }
}

function drawOnFootTurtle() {
    var t = game.turtle;
    var screenX = t.x - game.camera.x;
    var screenY = t.y - game.camera.y;
    var drawScale = t.width / 16;
    NES.drawTurtleSprite(ctx, screenX, screenY, t.direction, t.frame, game.activeTurtle, drawScale);
}

var _blimpAnimTimer = 0;
var _blimpAnimFrame = 0;
var BLIMP_FRAMES = ['blimp1', 'blimp2', 'blimp3'];

function drawBlimp() {
    var p = game.player;
    var sx = p.x - game.camera.x;
    var sy = p.y - game.camera.y;

    // Animate propeller between 3 frames
    _blimpAnimTimer += 0.016;
    if (_blimpAnimTimer >= 0.12) {
        _blimpAnimTimer = 0;
        _blimpAnimFrame = (_blimpAnimFrame + 1) % 3;
    }
    var frameKey = BLIMP_FRAMES[_blimpAnimFrame];
    var blimpSprite = game.sprites[frameKey] || game.sprites.blimp;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (blimpSprite) {
        var bw = p.width;
        var bh = p.height;
        // Add a gentle bobbing motion
        var bob = Math.sin(Date.now() / 600) * 3;
        if (p.direction === 'left') {
            ctx.translate(sx + bw / 2, sy + bh / 2 + bob);
            ctx.scale(-1, 1);
            ctx.drawImage(blimpSprite, -bw / 2, -bh / 2, bw, bh);
        } else {
            ctx.drawImage(blimpSprite, sx, sy + bob, bw, bh);
        }
        // Shadow on the ground
        ctx.globalAlpha = 0.2;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(sx + bw / 2, sy + bh + 8 + bob * 0.3, bw * 0.35, 4, 0, 0, Math.PI * 2);
        ctx.fill();
    } else {
        ctx.fillStyle = '#28a828';
        ctx.fillRect(sx + 4, sy + 8, p.width - 8, p.height - 20);
        ctx.fillStyle = '#fcfc00';
        ctx.font = 'bold 7px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('TURTLES', sx + p.width / 2, sy + p.height / 2);
        ctx.textAlign = 'left';
    }
    ctx.restore();
}

function drawTitle() {
    const title = game.sprites.title;
    if (title) {
        ctx.drawImage(title, 265, 48, 180, 32, CANVAS_WIDTH/2 - 90, 2, 180, 24);
    }
}

const WAYPOINT_IDS = new Set(['lm_start', 'lm_info', 'lm_sewer', 'lm_boss']);
const WAYPOINT_EDGE_PAD = 12;
const WAYPOINT_SIZE = 6;

function drawWaypointPip(wx, wy, pcx, pcy, vpLeft, vpTop, vpRight, vpBottom, color, label) {
    var margin = TILE_SIZE;
    if (wx + TILE_SIZE > vpLeft - margin && wx - TILE_SIZE < vpRight + margin &&
        wy + TILE_SIZE > vpTop - margin && wy - TILE_SIZE < vpBottom + margin) return;

    var ang = Math.atan2(wy - pcy, wx - pcx);
    var minX = WAYPOINT_EDGE_PAD;
    var maxX = CANVAS_WIDTH - WAYPOINT_EDGE_PAD;
    var minY = WAYPOINT_EDGE_PAD;
    var maxY = CANVAS_HEIGHT - WAYPOINT_EDGE_PAD;
    var cx = CANVAS_WIDTH / 2;
    var cy = CANVAS_HEIGHT / 2;
    var edgeX = Math.max(minX, Math.min(maxX, cx + Math.cos(ang) * (cx - WAYPOINT_EDGE_PAD)));
    var edgeY = Math.max(minY, Math.min(maxY, cy + Math.sin(ang) * (cy - WAYPOINT_EDGE_PAD)));

    ctx.save();
    ctx.translate(edgeX, edgeY);
    ctx.rotate(ang);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(WAYPOINT_SIZE, 0);
    ctx.lineTo(-WAYPOINT_SIZE, -WAYPOINT_SIZE * 0.6);
    ctx.lineTo(-WAYPOINT_SIZE, WAYPOINT_SIZE * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    if (label) {
        ctx.fillStyle = color;
        ctx.font = '7px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(label, edgeX, edgeY - WAYPOINT_SIZE - 2);
        ctx.textAlign = 'left';
    }
}

function drawWaypointPips() {
    if (game.state !== 'OVERWORLD') return;

    var entity = (game.controllerEntity === 'foot') ? game.turtle : game.player;
    var pcx = entity.x + entity.width / 2;
    var pcy = entity.y + entity.height / 2;
    var vpLeft = game.camera.x;
    var vpTop = game.camera.y;
    var vpRight = vpLeft + CANVAS_WIDTH;
    var vpBottom = vpTop + CANVAS_HEIGHT;

    // Landmark waypoints (sewer, boss, etc.)
    for (var i = 0; i < LANDMARKS.length; i++) {
        var lm = LANDMARKS[i];
        if (!WAYPOINT_IDS.has(lm.id)) continue;
        var wx = lm.x * TILE_SIZE + TILE_SIZE / 2;
        var wy = lm.y * TILE_SIZE + TILE_SIZE / 2;
        var color = lm.id === 'lm_boss' ? '#ff0' : '#0f0';
        drawWaypointPip(wx, wy, pcx, pcy, vpLeft, vpTop, vpRight, vpBottom, color, lm.label);
    }

    // Artist building locator arrows (yellow pips for unvisited, dim for visited)
    for (var b = 0; b < BUILDINGS.length; b++) {
        var bld = BUILDINGS[b];
        if (!bld.artistId) continue;
        var bwx = bld.worldX + TILE_SIZE / 2;
        var bwy = bld.worldY + TILE_SIZE / 2;
        var visited = bld.artistId && game.progress.galleriesVisited[bld.artistId];
        var bcolor = visited ? '#555' : '#fcfc00';
        var bnum = (b + 1).toString();
        drawWaypointPip(bwx, bwy, pcx, pcy, vpLeft, vpTop, vpRight, vpBottom, bcolor, visited ? null : bnum);
    }
}

function drawUI() {
    // Header
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(0, 0, CANVAS_WIDTH, 28);
    
    drawTitle();

    if (game.mode === 'WORLD') {
        ctx.fillStyle = '#00ff00';
        ctx.font = '8px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(BRAND.title, CANVAS_WIDTH / 2, 18);
        ctx.fillStyle = '#fcfc00';
        ctx.font = '10px "Press Start 2P", monospace';
        ctx.textAlign = 'right';
        ctx.fillText(WORLD_NODES.length + ' REGIONS', CANVAS_WIDTH - 10, 18);
        ctx.textAlign = 'left';
    } else {
        const dist = getPlayerDistrict();
        if (dist) {
            ctx.fillStyle = '#ff66ff';
            ctx.font = '8px "Press Start 2P", monospace';
            ctx.textAlign = 'center';
            ctx.fillText(dist.id.toUpperCase(), CANVAS_WIDTH / 2, 18);
        }
        ctx.fillStyle = '#fcfc00';
        ctx.font = '10px "Press Start 2P", monospace';
        ctx.textAlign = 'right';
        ctx.fillText(BUILDINGS.length + ' GALLERIES', CANVAS_WIDTH - 10, 18);
        ctx.textAlign = 'left';

        drawWaypointPips();
    }

    // Footer
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, CANVAS_HEIGHT - 22, CANVAS_WIDTH, 22);
    ctx.fillStyle = '#58d8f8';
    ctx.font = '8px "Press Start 2P", monospace';
    if (game.mode === 'WORLD') {
        ctx.fillText('ARROWS:Move  ENTER:Region', 10, CANVAS_HEIGHT - 8);
    } else if (game.controllerEntity === 'foot') {
        ctx.fillText('ARROWS:Move  ENTER:Visit/Level  T:Van', 10, CANVAS_HEIGHT - 8);
    } else {
        ctx.fillText('ARROWS:Move  ENTER:Visit  T:Exit Van  M:World', 10, CANVAS_HEIGHT - 8);
    }
}

// ============================================
// GAME LOGIC
// ============================================

function rectHitsCollisionGrid(rx, ry, rw, rh) {
    if (!COLLISION_GRID) return false;
    var txMin = Math.max(0, Math.floor(rx / TILE_SIZE));
    var txMax = Math.min(WORLD_WIDTH - 1, Math.floor((rx + rw - 1) / TILE_SIZE));
    var tyMin = Math.max(0, Math.floor(ry / TILE_SIZE));
    var tyMax = Math.min(WORLD_HEIGHT - 1, Math.floor((ry + rh - 1) / TILE_SIZE));
    for (var ty = tyMin; ty <= tyMax; ty++) {
        for (var tx = txMin; tx <= txMax; tx++) {
            if (COLLISION_GRID[ty * WORLD_WIDTH + tx]) return true;
        }
    }
    return false;
}

function rectHitsBuildingCollision(rx, ry, rw, rh) {
    for (var i = 0; i < BUILDINGS.length; i++) {
        var c = BUILDINGS[i].collisionWorld;
        if (!c) continue;
        if (rx < c.x + c.w && rx + rw > c.x &&
            ry < c.y + c.h && ry + rh > c.y) return true;
    }
    return false;
}

function checkCollision(newX, newY) {
    var p = game.player;
    var worldPixelW = WORLD_WIDTH * TILE_SIZE;
    var worldPixelH = WORLD_HEIGHT * TILE_SIZE;

    if (newX < 0 || newX + p.width > worldPixelW ||
        newY < 0 || newY + p.height > worldPixelH) {
        return true;
    }

    var inset = 24;
    var rx = newX + inset, ry = newY + inset;
    var rw = p.width - inset * 2, rh = p.height - inset * 2;
    if (rectHitsCollisionGrid(rx, ry, rw, rh)) return true;
    if (rectHitsBuildingCollision(rx, ry, rw, rh)) return true;
    return false;
}

// ============================================
// INTERACTION CONTROLLER — single active building with hysteresis
// ============================================

function updateInteraction() {
    const pRect = getPlayerRect();
    const pCenter = rectCenter(pRect);
    
    if (game.activeBuildingId !== null) {
        const active = BUILDING_BY_ID[game.activeBuildingId];
        if (!active) { setActiveBuilding(null); }
        else if (rectsOverlap(pRect, active.exitWorld)) { return; }
        else { setActiveBuilding(null); }
    }
    
    const candidates = BUILDINGS.filter(b => rectsOverlap(pRect, b.enterWorld));
    if (candidates.length === 0) return;
    
    // Sort: nearest first, then lower priority number wins, then stable ID
    candidates.sort((a, b) => {
        const dA = distSq(pCenter, rectCenter(a.enterWorld));
        const dB = distSq(pCenter, rectCenter(b.enterWorld));
        if (dA !== dB) return dA - dB;
        if (a.priority !== b.priority) return a.priority - b.priority; // 0 beats 1
        return a.id < b.id ? -1 : 1;
    });
    
    setActiveBuilding(candidates[0].id);
}

// ── Phase 7.3: Blimp port proximity + fast travel ──────────────

function updateBlimpInteraction() {
    if (game.mode !== 'REGION' || game.state !== 'OVERWORLD') {
        game.activeBlimpId = null;
        return;
    }
    if (game.blimpMenu.active || game.blimpFade.active) return;

    var ports = game.blimpMenu.ports;
    if (ports.length === 0) { game.activeBlimpId = null; return; }

    var px = game.player.x + game.player.width / 2;
    var py = game.player.y + game.player.height / 2;
    var blimpEnterR = 2 * TILE_SIZE;
    var blimpExitR = 3 * TILE_SIZE;

    // Hysteresis: keep active blimp until player leaves exit radius
    if (game.activeBlimpId) {
        for (var i = 0; i < ports.length; i++) {
            if (ports[i].id === game.activeBlimpId) {
                var ax = ports[i].x * TILE_SIZE + TILE_SIZE / 2;
                var ay = ports[i].y * TILE_SIZE + TILE_SIZE / 2;
                if (Math.hypot(px - ax, py - ay) < blimpExitR) return;
                break;
            }
        }
        game.activeBlimpId = null;
    }

    // Scan for nearest blimp port within enter radius
    var nearest = null;
    var nearDist = Infinity;
    for (var j = 0; j < ports.length; j++) {
        var bx = ports[j].x * TILE_SIZE + TILE_SIZE / 2;
        var by = ports[j].y * TILE_SIZE + TILE_SIZE / 2;
        var d = Math.hypot(px - bx, py - by);
        if (d < blimpEnterR && d < nearDist) {
            nearest = ports[j];
            nearDist = d;
        }
    }
    if (nearest) game.activeBlimpId = nearest.id;
}

function openBlimpMenu() {
    if (game.blimpMenu.active) return;
    game.blimpMenu.active = true;
    game.blimpMenu.selectedIndex = 0;
    game.blimpMenu.scrollOff = 0;
    game.blimpMenu.activeLmId = game.activeBlimpId;
    clearInputState();
}

function closeBlimpMenu() {
    game.blimpMenu.active = false;
    game.blimpMenu.selectedIndex = 0;
    game.blimpMenu.scrollOff = 0;
    game.blimpMenu.activeLmId = null;
}

function travelToBlimp(portLm) {
    if (!portLm) return;
    game.blimpFade.active = true;
    game.blimpFade.t = 0;
    game.blimpFade.phase = 'out';
    game.blimpFade.targetPort = portLm;
    closeBlimpMenu();
    clearInputState();
}

function updateBlimpFade(dt) {
    if (!game.blimpFade.active) return;
    game.blimpFade.t += dt;
    if (game.blimpFade.t >= game.blimpFade.duration) {
        if (game.blimpFade.phase === 'out') {
            // Teleport at peak darkness — find safe drivable landing near port
            var port = game.blimpFade.targetPort;
            if (port) {
                var safePos = findSafeDrivablePos(port.x, port.y, 25, true);
                if (safePos) {
                    game.player.x = safePos.x;
                    game.player.y = safePos.y;
                } else {
                    game.player.x = port.x * TILE_SIZE;
                    game.player.y = port.y * TILE_SIZE;
                    console.warn('Blimp: no safe drivable position near port ' + port.id + ', using raw coords');
                }
                game.camera.initialized = false;
            }
            game.blimpFade.t = 0;
            game.blimpFade.phase = 'in';
        } else {
            // Fade-in complete
            game.blimpFade.active = false;
            game.blimpFade.t = 0;
            game.blimpFade.phase = null;
            game.blimpFade.targetPort = null;
            game.state = 'OVERWORLD';
        }
    }
}

function drawBlimpMenu() {
    if (!game.blimpMenu.active) return;

    var ports = game.blimpMenu.ports;
    if (ports.length === 0) return;

    var portNames = ports.map(function(p) {
        return p.id.replace('lm_blimp_', '').replace(/_/g, ' ').toUpperCase();
    });

    var itemH = 20;
    var maxVisible = Math.min(ports.length, 12);
    var panelW = 280;
    var panelH = 60 + maxVisible * itemH + 8;
    var panelX = (CANVAS_WIDTH - panelW) / 2;
    var panelY = (CANVAS_HEIGHT - panelH) / 2;

    // Scroll offset: keep selected item visible
    var sel = game.blimpMenu.selectedIndex;
    if (!game.blimpMenu.scrollOff) game.blimpMenu.scrollOff = 0;
    if (sel < game.blimpMenu.scrollOff) game.blimpMenu.scrollOff = sel;
    if (sel >= game.blimpMenu.scrollOff + maxVisible) game.blimpMenu.scrollOff = sel - maxVisible + 1;
    var scrollOff = game.blimpMenu.scrollOff;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.fillStyle = '#000000';
    ctx.fillRect(panelX - 4, panelY - 4, panelW + 8, panelH + 8);
    ctx.strokeStyle = '#fcfc00';
    ctx.lineWidth = 3;
    ctx.strokeRect(panelX - 2, panelY - 2, panelW + 4, panelH + 4);
    ctx.strokeStyle = '#c8a000';
    ctx.lineWidth = 1;
    ctx.strokeRect(panelX + 2, panelY + 2, panelW - 4, panelH - 4);

    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(panelX, panelY, panelW, panelH);

    ctx.fillStyle = '#fcfc00';
    ctx.font = 'bold 12px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('BLIMP TRAVEL', panelX + panelW / 2, panelY + 20);

    ctx.fillStyle = '#58d8f8';
    ctx.font = '8px "Press Start 2P", monospace';
    ctx.fillText(ports.length + ' DESTINATIONS', panelX + panelW / 2, panelY + 36);
    ctx.textAlign = 'left';

    // Scroll indicators
    if (scrollOff > 0) {
        ctx.fillStyle = '#fcfc00';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('\u25B2 MORE', panelX + panelW / 2, panelY + 46);
        ctx.textAlign = 'left';
    }

    var listY = panelY + 50;
    for (var vi = 0; vi < maxVisible; vi++) {
        var i = vi + scrollOff;
        if (i >= ports.length) break;
        var iy = listY + vi * itemH;
        var isCurrent = ports[i].id === game.blimpMenu.activeLmId;
        var isSelected = i === sel;

        if (isSelected) {
            ctx.fillStyle = 'rgba(252, 252, 0, 0.2)';
            ctx.fillRect(panelX + 6, iy - 2, panelW - 12, itemH - 2);
            ctx.fillStyle = '#fcfc00';
            ctx.font = 'bold 10px monospace';
            ctx.fillText('\u25B6', panelX + 10, iy + 12);
        }

        if (isCurrent) {
            ctx.fillStyle = '#555555';
            ctx.font = '9px "Press Start 2P", monospace';
            ctx.fillText(portNames[i] + ' (HERE)', panelX + 28, iy + 12);
        } else {
            ctx.fillStyle = isSelected ? '#fcfc00' : '#ffffff';
            ctx.font = '9px "Press Start 2P", monospace';
            ctx.fillText(portNames[i], panelX + 28, iy + 12);
        }
    }

    // Bottom scroll indicator
    if (scrollOff + maxVisible < ports.length) {
        ctx.fillStyle = '#fcfc00';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('\u25BC MORE', panelX + panelW / 2, listY + maxVisible * itemH + 4);
        ctx.textAlign = 'left';
    }

    ctx.fillStyle = '#58d8f8';
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('\u2191\u2193:SELECT  ENTER:GO  ESC:CANCEL', panelX + panelW / 2, panelY + panelH - 6);
    ctx.textAlign = 'left';
}

function drawBlimpFade() {
    if (!game.blimpFade.active) return;
    var p = Math.min(1, game.blimpFade.t / game.blimpFade.duration);
    var alpha = game.blimpFade.phase === 'out' ? p : 1 - p;
    if (alpha > 0.001) {
        ctx.fillStyle = 'rgba(0, 0, 0, ' + alpha + ')';
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
}

function updateMobileActionVisibility() {
    const btn = document.getElementById('btnAction');
    if (!btn) return;
    if (game.mode === 'WORLD') {
        const shouldShow = game.state === 'OVERWORLD' && game.activeNodeId !== null;
        btn.classList.toggle('visible', shouldShow);
        btn.textContent = shouldShow ? 'FLY' : 'A';
    } else {
        var showBlimp = game.state === 'OVERWORLD' && game.activeBlimpId !== null;
        var showBuilding = canEnterActiveBuilding();
        var shouldShow = showBlimp || showBuilding;
        btn.classList.toggle('visible', shouldShow);
        btn.textContent = showBlimp ? 'FLY' : (showBuilding ? 'ENTER' : 'A');
    }
}

function setActiveBuilding(buildingId) {
    if (buildingId === game.activeBuildingId) return;
    game.activeBuildingId = buildingId;
    
    const panel = document.getElementById('infoPanel');
    
    if (buildingId === null) {
        panel.classList.add('hidden');
        updateMobileActionVisibility();
        return;
    }
    
    const building = BUILDING_BY_ID[buildingId];
    const artist = building ? ARTISTS[building.artistId] : null;
    
    const nameEl = document.getElementById('artistName');
    const bioEl  = document.getElementById('artistBio');
    const linkEl = document.getElementById('artistLink');
    
    if (artist) {
        if (nameEl) nameEl.textContent = artist.name;
        if (bioEl)  bioEl.textContent = artist.bio;
        if (linkEl) {
            if (artist.instagram) {
                linkEl.href = artist.instagram;
                linkEl.style.display = '';
            } else {
                linkEl.style.display = 'none';
            }
        }
        panel.classList.remove('hidden');
    } else if (building) {
        if (nameEl) nameEl.textContent = 'COMING SOON';
        if (bioEl)  bioEl.textContent = 'This gallery is being prepared...';
        if (linkEl) linkEl.style.display = 'none';
        panel.classList.remove('hidden');
    } else {
        panel.classList.add('hidden');
    }
    updateMobileActionVisibility();
}

// ============================================
// ENTER / EXIT TRANSITIONS
// ============================================

function canEnterActiveBuilding() {
    return game.state === 'OVERWORLD' && game.activeBuildingId !== null;
}

function requestEnterActiveBuilding() {
    if (!canEnterActiveBuilding()) return false;
    visitArtist();
    return true;
}

function canExitBuilding() {
    return game.state === 'BUILDING';
}

function requestExitBuilding() {
    if (!canExitBuilding()) return false;
    startExitBuilding();
    return true;
}

// Unified action routing — all UI bindings funnel through these two
function requestPrimaryAction() {
    // Score board toggle
    if (game.showScoreBoard) {
        game.showScoreBoard = false;
        return;
    }

    // Level mode results screen: dismiss and exit
    if (game.mode === 'LEVEL' && game.level && game.level.showResults && game.level.resultsTimer > 0.5) {
        // For gallery levels, show artist info overlay before exiting
        if (game.level.artistId && game.level.data.theme === 'gallery') {
            showGalleryCompleteOverlay(game.level.artistId);
        }
        exitLevel();
        return;
    }

    // Boss victory screen: dismiss
    if (game.mode === 'LEVEL' && game.level && game.level.bossDefeated && game.level.victoryTimer > 2.0) {
        exitLevel();
        return;
    }

    // Level mode: initiate attack (respects cooldown + phase gate)
    if (game.mode === 'LEVEL' && game.level && game.level.player) {
        var lp = game.level.player;
        if (lp.atkPhase === 'IDLE' && lp.atkCooldown <= 0) {
            lp.atkPhase = 'WINDUP';
            lp.atkTimer = ATK_WINDUP;
        }
        return;
    }

    // Blimp menu confirm
    if (game.blimpMenu.active) {
        var ports = game.blimpMenu.ports;
        var sel = ports[game.blimpMenu.selectedIndex];
        if (sel && sel.id !== game.blimpMenu.activeLmId) {
            travelToBlimp(sel);
        }
        return;
    }

    if (game.mode === 'WORLD' && game.activeNodeId) {
        var node = WORLD_NODE_BY_ID[game.activeNodeId];
        if (node) startEnterRegion(node.regionId);
        return;
    }

    // Blimp port: open menu when near a blimp port
    if (game.mode === 'REGION' && game.state === 'OVERWORLD' && game.activeBlimpId) {
        openBlimpMenu();
        return;
    }

    // POI interaction (roadside gas, rest stop, viewpoint)
    if (game.mode === 'REGION' && game.state === 'OVERWORLD' && game.activePOI) {
        if (interactWithPOI()) return;
    }

    // Level entrances: check building type or landmark (blocked during re-entry grace)
    if (game.mode === 'REGION' && game.state === 'OVERWORLD' && game.levelReentryGrace <= 0) {
        var levelCtx = getLevelForContext();
        if (levelCtx) {
            startEnterLevelFromContext(levelCtx);
            return;
        }
    }

    requestEnterActiveBuilding();
}

function requestBackAction() {
    // Level mode: exit level
    if (game.mode === 'LEVEL') {
        exitLevel();
        return;
    }

    // Close blimp menu
    if (game.blimpMenu.active) {
        closeBlimpMenu();
        return;
    }

    if (game.state === 'BUILDING') {
        requestExitBuilding();
        return;
    }
    if (game.mode === 'REGION' && game.state === 'OVERWORLD') {
        if (game.controllerEntity === 'foot') return; // must be in van to leave region
        startReturnToWorld();
        return;
    }
}

function visitArtist() {
    if (!canEnterActiveBuilding()) return;
    startEnterBuilding(game.activeBuildingId);
}

function startEnterBuilding(buildingId) {
    const building = BUILDING_BY_ID[buildingId];
    if (!building) return;
    
    game.state = 'TRANSITION';
    game.transition.active = true;
    game.transition.dir = 'toBuilding';
    game.transition.t = 0;
    game.transition.targetBuildingId = buildingId;
    
    setActiveBuilding(null);
    clearInputState();
}

function startExitBuilding() {
    if (game.state !== 'BUILDING') return;
    
    game.state = 'TRANSITION';
    game.transition.active = true;
    game.transition.dir = 'toOverworld';
    game.transition.t = 0;
}

function safeReturnToOverworld() {
    game.state = 'OVERWORLD';
    game.transition.active = false;
    game.transition.t = 0;
    game.transition.dir = null;
    game.transition.targetBuildingId = null;
    game.mapTransition.active = false;
    game.mapTransition.t = 0;
    game.mapTransition.dir = null;
    game.mapTransition.targetRegionId = null;
    game.blimpMenu.active = false;
    game.blimpFade.active = false;
    const overlay = document.getElementById('buildingOverlay');
    if (overlay) overlay.classList.add('hidden');
    updateMobileActionVisibility();
}

function openBuildingOverlay(buildingId) {
    const overlay = document.getElementById('buildingOverlay');
    if (!overlay) { console.error('openBuildingOverlay: #buildingOverlay not found'); return false; }

    const building = BUILDING_BY_ID[buildingId];
    if (!building) { console.error('openBuildingOverlay: building not found:', buildingId); return false; }

    renderOverlayForBuilding(buildingId);
    overlay.classList.remove('hidden');
    return true;
}

function closeBuildingOverlay() {
    const overlay = document.getElementById('buildingOverlay');
    if (!overlay) { console.error('closeBuildingOverlay: #buildingOverlay not found'); return; }
    overlay.classList.add('hidden');

    // Invalidate any in-flight hero load and clean up
    game.overlay.heroReqId++;
    const heroImg = document.getElementById('overlayHeroImg');
    if (heroImg) { heroImg.onload = null; heroImg.onerror = null; heroImg.src = ''; }
    game.overlay.buildingId = null;
    game.overlay.artistId = null;
    game.overlay.heroIndex = 0;
    game.overlay.heroStatus = 'empty';
}

// ============================================
// GALLERY — render, hero swap, thumbs
// ============================================

function renderOverlayForBuilding(buildingId) {
    const building = BUILDING_BY_ID[buildingId];
    const artist = building ? ARTISTS[building.artistId] : null;

    game.overlay.buildingId = buildingId;
    game.overlay.artistId = building ? building.artistId : null;
    game.overlay.heroIndex = 0;
    game.overlay.heroStatus = 'empty';

    const nameEl = document.getElementById('overlayArtistName');
    const bioEl  = document.getElementById('overlayArtistBio');
    const igLink = document.getElementById('overlayIgLink');

    if (artist) {
        if (nameEl) nameEl.textContent = artist.name;
        if (bioEl)  bioEl.textContent  = artist.bio || '';
        if (igLink) {
            if (artist.instagram) {
                igLink.href = artist.instagram;
                igLink.textContent = 'VISIT INSTAGRAM →';
                igLink.style.display = '';
            } else {
                igLink.style.display = 'none';
            }
        }
    } else {
        if (nameEl) nameEl.textContent = 'COMING SOON';
        if (bioEl)  bioEl.textContent  = 'This gallery is being prepared...';
        if (igLink) igLink.style.display = 'none';
    }

    const images = (artist && Array.isArray(artist.images)) ? artist.images : [];
    buildThumbs(images);

    if (images.length > 0) {
        setHeroIndex(0);
    } else {
        showHeroEmpty();
    }
}

function showHeroEmpty() {
    game.overlay.heroStatus = 'empty';
    const placeholder = document.getElementById('overlayHeroPlaceholder');
    const heroImg     = document.getElementById('overlayHeroImg');
    const errorEl     = document.getElementById('overlayError');

    if (placeholder) { placeholder.textContent = 'NO IMAGE YET'; placeholder.classList.remove('hidden'); }
    if (heroImg)     { heroImg.classList.add('hidden'); heroImg.onload = null; heroImg.onerror = null; heroImg.src = ''; }
    if (errorEl)     { errorEl.classList.add('hidden'); }
}

function setHeroIndex(i) {
    const artist = ARTISTS[game.overlay.artistId];
    if (!artist || !Array.isArray(artist.images)) return;
    if (i < 0 || i >= artist.images.length) return;

    game.overlay.heroIndex = i;
    loadHero(artist.images[i]);
    highlightThumb(i);
}

function loadHero(url) {
    const reqId = ++game.overlay.heroReqId;
    game.overlay.heroStatus = 'loading';

    const placeholder = document.getElementById('overlayHeroPlaceholder');
    const heroImg     = document.getElementById('overlayHeroImg');
    const errorEl     = document.getElementById('overlayError');

    if (placeholder) { placeholder.textContent = 'LOADING\u2026'; placeholder.classList.remove('hidden'); }
    if (heroImg)     { heroImg.classList.add('hidden'); heroImg.onload = null; heroImg.onerror = null; }
    if (errorEl)     { errorEl.classList.add('hidden'); }

    if (!heroImg) return;

    heroImg.onload = function() {
        if (reqId !== game.overlay.heroReqId) return;
        game.overlay.heroStatus = 'ready';
        heroImg.classList.remove('hidden');
        if (placeholder) placeholder.classList.add('hidden');
        if (errorEl) errorEl.classList.add('hidden');
    };

    heroImg.onerror = function() {
        if (reqId !== game.overlay.heroReqId) return;
        game.overlay.heroStatus = 'error';
        heroImg.classList.add('hidden');
        if (placeholder) placeholder.classList.add('hidden');
        if (errorEl) errorEl.classList.remove('hidden');
    };

    heroImg.src = url;
}

function buildThumbs(images) {
    const container = document.getElementById('overlayThumbs');
    if (!container) return;

    container.innerHTML = '';

    if (images.length <= 1) {
        container.classList.add('hidden');
        return;
    }

    container.classList.remove('hidden');

    images.forEach((url, i) => {
        const btn = document.createElement('button');
        btn.className = 'thumb-btn';
        btn.type = 'button';
        btn.setAttribute('aria-label', `Image ${i + 1}`);
        btn.dataset.index = i;

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = url;
        img.alt = '';
        img.onerror = function() {
            btn.disabled = true;
            btn.classList.add('thumb-bad');
        };
        btn.appendChild(img);

        btn.addEventListener('click', function() {
            if (!btn.disabled) setHeroIndex(i);
        });

        container.appendChild(btn);
    });
}

function highlightThumb(activeIndex) {
    const container = document.getElementById('overlayThumbs');
    if (!container || container.classList.contains('hidden')) return;
    const buttons = container.querySelectorAll('.thumb-btn');
    if (buttons.length === 0) return;
    buttons.forEach((btn, i) => {
        btn.classList.toggle('active', i === activeIndex);
    });
}

function updateTransition(dt) {
    if (!game.transition.active) return;

    game.transition.t = Math.min(game.transition.t + dt, game.transition.duration);
    if (game.transition.t < game.transition.duration) return;

    const dir = game.transition.dir;
    const targetId = game.transition.targetBuildingId;

    // Full reset before side-effects
    game.transition.active = false;
    game.transition.t = 0;
    game.transition.dir = null;
    game.transition.targetBuildingId = null;

    if (dir === 'toBuilding') {
        if (openBuildingOverlay(targetId)) {
            game.state = 'BUILDING';
        } else {
            safeReturnToOverworld();
        }
    } else {
        closeBuildingOverlay();
        game.state = 'OVERWORLD';
        // Unstick: nudge player out of building collision on exit
        _unstickFromBuilding();
    }
    updateMobileActionVisibility();
}

function _unstickFromBuilding() {
    var p = game.player;
    if (!checkCollision(p.x, p.y)) return;
    // Try nudging in each cardinal direction with increasing distance
    var step = 4;
    for (var dist = step; dist <= TILE_SIZE * 3; dist += step) {
        if (!checkCollision(p.x + dist, p.y)) { p.x += dist; return; }
        if (!checkCollision(p.x - dist, p.y)) { p.x -= dist; return; }
        if (!checkCollision(p.x, p.y + dist)) { p.y += dist; return; }
        if (!checkCollision(p.x, p.y - dist)) { p.y -= dist; return; }
        if (!checkCollision(p.x + dist, p.y + dist)) { p.x += dist; p.y += dist; return; }
        if (!checkCollision(p.x - dist, p.y + dist)) { p.x -= dist; p.y += dist; return; }
        if (!checkCollision(p.x + dist, p.y - dist)) { p.x += dist; p.y -= dist; return; }
        if (!checkCollision(p.x - dist, p.y - dist)) { p.x -= dist; p.y -= dist; return; }
    }
}

// ── Van/Foot toggle ──────────────────────────────────────────
function attemptToggleVanFoot() {
    if (game.mode !== 'REGION') return;
    if (game.state !== 'OVERWORLD') return;
    if (game.mapTransition.active || game.blimpFade.active) return;

    var p = game.player;
    var t = game.turtle;

    if (game.controllerEntity === 'van') {
        // Exit van: park it, spawn turtle next to it
        game.van.x = p.x;
        game.van.y = p.y;
        game.van.direction = p.direction;
        game.van.frame = p.frame;

        // Turtle exits from the van door
        t.y = p.y + p.height / 2 - t.height / 2;
        if (p.direction === 'right') {
            // wagonRight5: door on the left (rear) side
            t.x = p.x - t.width - 4;
            t.direction = 'left';
        } else if (p.direction === 'left') {
            // flipped: door on the right (rear) side
            t.x = p.x + p.width + 4;
            t.direction = 'right';
        } else {
            // Vertical: spawn offset in facing direction
            t.x = p.x + p.width / 2 - t.width / 2;
            t.y = p.y + p.height / 2 - t.height / 2;
            var spawnOffset = 48;
            if (p.direction === 'down') t.y += spawnOffset;
            else t.y -= spawnOffset;
            t.direction = p.direction;
        }
        t.frame = 0;
        t.animTimer = 0;

        game.controllerEntity = 'foot';
    } else {
        // Re-enter van: check proximity
        var vanCX = game.van.x + p.width / 2;
        var vanCY = game.van.y + p.height / 2;
        var tCX = t.x + t.width / 2;
        var tCY = t.y + t.height / 2;
        var dist = Math.hypot(tCX - vanCX, tCY - vanCY);
        if (dist > p.width * 0.8) return; // too far from van

        // Snap player back to van position
        p.x = game.van.x;
        p.y = game.van.y;
        p.direction = game.van.direction;
        game.controllerEntity = 'van';
    }
}

function getVanReenterDist() {
    var p = game.player;
    var t = game.turtle;
    var vanCX = game.van.x + p.width / 2;
    var vanCY = game.van.y + p.height / 2;
    var tCX = t.x + t.width / 2;
    var tCY = t.y + t.height / 2;
    return Math.hypot(tCX - vanCX, tCY - vanCY);
}

function checkTurtleCollision(newX, newY) {
    var t = game.turtle;
    var worldPixelW = WORLD_WIDTH * TILE_SIZE;
    var worldPixelH = WORLD_HEIGHT * TILE_SIZE;
    if (newX < 0 || newX + t.width > worldPixelW ||
        newY < 0 || newY + t.height > worldPixelH) return true;

    var inset = 4;
    var rx = newX + inset, ry = newY + inset;
    var rw = t.width - inset * 2, rh = t.height - inset * 2;
    if (rectHitsCollisionGrid(rx, ry, rw, rh)) return true;
    if (rectHitsBuildingCollision(rx, ry, rw, rh)) return true;
    return false;
}

function update(dt) {
    // Re-entry grace timer
    if (game.levelReentryGrace > 0) game.levelReentryGrace -= dt;

    // Level mode: separate update loop
    if (game.mode === 'LEVEL') {
        updateLevel(dt);
        return;
    }

    // Map-level transitions (WORLD <-> REGION)
    if (game.mapTransition.active) {
        updateMapTransition(dt);
        return;
    }

    // Blimp fast-travel fade
    if (game.blimpFade.active) {
        updateBlimpFade(dt);
        return;
    }

    if (game.state === 'TRANSITION') {
        updateTransition(dt);
        return;
    }
    
    if (game.state !== 'OVERWORLD') return;

    // Blimp menu blocks movement but still runs
    if (game.blimpMenu.active) {
        updateCamera(dt);
        return;
    }
    
    let dx = 0, dy = 0;
    
    if (inputState.up) dy -= 1;
    if (inputState.down) dy += 1;
    if (inputState.left) dx -= 1;
    if (inputState.right) dx += 1;
    
    const len = Math.hypot(dx, dy);
    const isMoving = len > 0;

    // On-foot mode: move turtle instead of van
    if (game.mode === 'REGION' && game.controllerEntity === 'foot') {
        var t = game.turtle;
        if (isMoving) {
            var ndx = dx / len, ndy = dy / len;
            if (ndx < 0) t.direction = 'left';
            else if (ndx > 0) t.direction = 'right';
            else if (ndy < 0) t.direction = 'up';
            else if (ndy > 0) t.direction = 'down';

            var tnx = t.x + ndx * t.pxPerSecond * dt;
            var tny = t.y + ndy * t.pxPerSecond * dt;
            if (!checkTurtleCollision(tnx, t.y)) t.x = tnx;
            if (!checkTurtleCollision(t.x, tny)) t.y = tny;

            var _fFacing = ndx < 0 ? 'w' : ndx > 0 ? 'e' : ndy < 0 ? 'n' : 's';
            if (typeof MP !== 'undefined' && MP.isConnected()) {
                MP.sendPosSync(t.x, t.y, _fFacing, 'foot', game.activeTurtle);
            }
        } else if (typeof MP !== 'undefined' && MP.isConnected()) {
            var _idleFootF = t.direction === 'left' ? 'w' : t.direction === 'right' ? 'e' : t.direction === 'up' ? 'n' : 's';
            MP.sendPosSync(t.x, t.y, _idleFootF, 'foot', game.activeTurtle);
        }
        t.moving = isMoving;
        if (isMoving) {
            t.animTimer += dt;
            if (t.animTimer >= t.animInterval) {
                t.animTimer -= t.animInterval;
                t.frame = (t.frame + 1) % 2;
            }
        }
        // Camera follows turtle when on foot
        updateCameraTarget(t.x + t.width / 2, t.y + t.height / 2, dt);
        updateInteraction();
        updateBlimpInteraction();
        updatePOIProximity();
        return;
    }
    
    const p = game.player;
    if (isMoving) {
        dx /= len;
        dy /= len;
        
        if (dx < 0) p.direction = 'left';
        else if (dx > 0) p.direction = 'right';
        else if (dy < 0) p.direction = 'up';
        else if (dy > 0) p.direction = 'down';
        
        const newX = p.x + dx * p.pxPerSecond * dt;
        const newY = p.y + dy * p.pxPerSecond * dt;
        
        if (game.mode === 'WORLD') {
            p.x = Math.max(0, Math.min(newX, (WORLD_WIDTH - 1) * TILE_SIZE));
            p.y = Math.max(0, Math.min(newY, (WORLD_HEIGHT - 1) * TILE_SIZE));
        } else {
            if (!checkCollision(newX, p.y)) p.x = newX;
            if (!checkCollision(p.x, newY)) p.y = newY;
        }

        var _facing = dx < 0 ? 'w' : dx > 0 ? 'e' : dy < 0 ? 'n' : 's';
        if (typeof MP !== 'undefined' && MP.isConnected()) {
            MP.sendPosSync(p.x, p.y, _facing, 'van', game.activeTurtle);
        }
    } else if (typeof MP !== 'undefined' && MP.isConnected()) {
        var _idleFacing = p.direction === 'left' ? 'w' : p.direction === 'right' ? 'e' : p.direction === 'up' ? 'n' : 's';
        MP.sendPosSync(p.x, p.y, _idleFacing, game.controllerEntity === 'foot' ? 'foot' : 'van', game.activeTurtle);
    }
    
    p.moving = isMoving;
    if (isMoving) {
        p.animTimer += dt;
        if (p.animTimer >= p.animInterval) {
            p.animTimer -= p.animInterval;
            p.frame = (p.frame + 1) % 2;
        }
    }
    
    // Speed boost decay
    if (game.speedBoost > 0) {
        game.speedBoost -= dt;
        if (game.speedBoost <= 0) {
            game.speedBoost = 0;
            if (game.mode === 'REGION') game.player.pxPerSecond = 400;
        }
    }
    // Postcard overlay decay
    if (game.postcard && game.postcard.timer > 0) {
        game.postcard.timer -= dt;
        if (game.postcard.timer <= 0) game.postcard = null;
    }

    updateCamera(dt);
    if (game.mode === 'WORLD') {
        updateWorldInteraction();
    } else {
        updateInteraction();
        updateBlimpInteraction();
        updatePOIProximity();
    }
}

function drawRiverTile(sx, sy) {
    const sprite = game.sprites.waterTile;
    if (sprite) {
        ctx.drawImage(sprite, sx, sy, TILE_SIZE, TILE_SIZE);
    } else {
        NES.drawTileStretched(ctx, sx, sy, TILE_SIZE, TILE_SIZE, NES.waterFrame());
    }
}

function roadNeighborCount(tx, ty) {
    var w = WORLD_WIDTH, h = WORLD_HEIGHT, n = 0;
    if (tx > 0     && ROAD_GRID[ty * w + tx - 1]) n++;
    if (tx < w - 1 && ROAD_GRID[ty * w + tx + 1]) n++;
    if (ty > 0     && ROAD_GRID[(ty - 1) * w + tx]) n++;
    if (ty < h - 1 && ROAD_GRID[(ty + 1) * w + tx]) n++;
    return n;
}
function isHwNeighbor(tx, ty) {
    var w = WORLD_WIDTH, h = WORLD_HEIGHT;
    if (tx > 0     && ROAD_TYPE_GRID[ty * w + tx - 1] === 2) return true;
    if (tx < w - 1 && ROAD_TYPE_GRID[ty * w + tx + 1] === 2) return true;
    if (ty > 0     && ROAD_TYPE_GRID[(ty - 1) * w + tx] === 2) return true;
    if (ty < h - 1 && ROAD_TYPE_GRID[(ty + 1) * w + tx] === 2) return true;
    return false;
}

// ── Road topology: classify each road tile by its 4-cardinal neighbors ──
// Returns { n, s, e, w, count, type } where n/s/e/w are booleans
function roadNeighbors(tx, ty) {
    var ww = WORLD_WIDTH, hh = WORLD_HEIGHT, k = ty * ww + tx;
    var n = ty > 0      && !!ROAD_GRID[k - ww];
    var s = ty < hh - 1 && !!ROAD_GRID[k + ww];
    var w = tx > 0      && !!ROAD_GRID[k - 1];
    var e = tx < ww - 1 && !!ROAD_GRID[k + 1];
    var count = (n ? 1 : 0) + (s ? 1 : 0) + (w ? 1 : 0) + (e ? 1 : 0);
    var type;
    if (count === 4) type = 'cross';
    else if (count === 3) {
        if (!n) type = 't_s';       // T open to south (missing north)
        else if (!s) type = 't_n';  // T open to north (missing south)
        else if (!w) type = 't_e';  // T open to east (missing west)
        else type = 't_w';          // T open to west (missing east)
    } else if (count === 2) {
        if (n && s) type = 'v';
        else if (e && w) type = 'h';
        else if (n && e) type = 'corner_ne';
        else if (n && w) type = 'corner_nw';
        else if (s && e) type = 'corner_se';
        else type = 'corner_sw';
    } else if (count === 1) {
        if (n || s) type = 'dead_v';
        else type = 'dead_h';
    } else {
        type = 'isolated';
    }
    return { n: n, s: s, e: e, w: w, count: count, type: type };
}

function isRoadEdge(tx, ty, dir) {
    var ww = WORLD_WIDTH, hh = WORLD_HEIGHT, k = ty * ww + tx;
    if (dir === 'n') return ty === 0      || !ROAD_GRID[k - ww];
    if (dir === 's') return ty >= hh - 1  || !ROAD_GRID[k + ww];
    if (dir === 'w') return tx === 0      || !ROAD_GRID[k - 1];
    if (dir === 'e') return tx >= ww - 1  || !ROAD_GRID[k + 1];
    return false;
}

// Determine the dominant flow direction for a road tile, accounting for
// multi-tile-wide roads where every tile has 4 neighbors but the road
// clearly runs in one direction.
function roadFlowDir(tx, ty) {
    var ww = WORLD_WIDTH, hh = WORLD_HEIGHT;
    var k = ty * ww + tx;
    if (!ROAD_GRID) return 'h';
    // Count how far the road extends in each axis
    var extE = 0, extW = 0, extN = 0, extS = 0;
    for (var i = 1; i <= 6; i++) { if (tx + i < ww && ROAD_GRID[k + i]) extE++; else break; }
    for (var i2 = 1; i2 <= 6; i2++) { if (tx - i2 >= 0 && ROAD_GRID[k - i2]) extW++; else break; }
    for (var i3 = 1; i3 <= 6; i3++) { if (ty + i3 < hh && ROAD_GRID[k + i3 * ww]) extS++; else break; }
    for (var i4 = 1; i4 <= 6; i4++) { if (ty - i4 >= 0 && ROAD_GRID[k - i4 * ww]) extN++; else break; }
    var hExt = extE + extW;
    var vExt = extN + extS;
    if (hExt > vExt) return 'h';
    if (vExt > hExt) return 'v';
    return 'h';
}

function drawRoadOverlay(sx, sy, tx, ty) {
    var sprite = game.sprites.roadOverlay;
    if (sprite) {
        ctx.drawImage(sprite, sx, sy, TILE_SIZE, TILE_SIZE);
        return;
    }

    var nb = roadNeighbors(tx, ty);
    var ts = TILE_SIZE;

    var curbC   = '#505050';
    var edgeC   = '#707070';
    var yellowC = '#e8c800';
    var whiteC  = '#f0f0f0';

    var ew  = Math.max(2, Math.round(ts * 0.05));
    var ew2 = Math.max(1, Math.round(ts * 0.03));

    // Solid dark asphalt base
    ctx.fillStyle = '#383838';
    ctx.fillRect(sx, sy, ts, ts);

    // Curb + gutter on non-road edges only
    if (!nb.n) { ctx.fillStyle = curbC; ctx.fillRect(sx, sy, ts, ew); ctx.fillStyle = edgeC; ctx.fillRect(sx, sy + ew, ts, ew2); }
    if (!nb.s) { ctx.fillStyle = curbC; ctx.fillRect(sx, sy + ts - ew, ts, ew); ctx.fillStyle = edgeC; ctx.fillRect(sx, sy + ts - ew - ew2, ts, ew2); }
    if (!nb.w) { ctx.fillStyle = curbC; ctx.fillRect(sx, sy, ew, ts); ctx.fillStyle = edgeC; ctx.fillRect(sx + ew, sy, ew2, ts); }
    if (!nb.e) { ctx.fillStyle = curbC; ctx.fillRect(sx + ts - ew, sy, ew, ts); ctx.fillStyle = edgeC; ctx.fillRect(sx + ts - ew - ew2, sy, ew2, ts); }

    // Curb corners where two edges meet
    var cr = Math.max(3, Math.round(ts * 0.10));
    if (!nb.n && !nb.w) { ctx.fillStyle = curbC; ctx.fillRect(sx, sy, cr, cr); }
    if (!nb.n && !nb.e) { ctx.fillStyle = curbC; ctx.fillRect(sx + ts - cr, sy, cr, cr); }
    if (!nb.s && !nb.w) { ctx.fillStyle = curbC; ctx.fillRect(sx, sy + ts - cr, cr, cr); }
    if (!nb.s && !nb.e) { ctx.fillStyle = curbC; ctx.fillRect(sx + ts - cr, sy + ts - cr, cr, cr); }

    // Center-line dashes: ONLY on centerline tiles with straight mask
    // Vertical (mask=5=N|S): dashes at right edge (seam with east expansion)
    // Horizontal (mask=10=E|W): dashes at bottom edge (seam with south expansion)
    // Corners/T/4-way/expansion tiles: NO center lines
    var clMask = ROAD_CENTER_MASK ? ROAD_CENTER_MASK[ty * WORLD_WIDTH + tx] : 0;
    var dashLen = Math.max(8, Math.round(ts * 0.18));
    var dashGap = Math.max(6, Math.round(ts * 0.14));
    var dashW   = Math.max(2, Math.round(ts * 0.04));

    if (clMask === 5) {
        // Vertical straight: yellow dashes at right edge (seam between 2 surface tiles)
        ctx.fillStyle = yellowC;
        var dashX = sx + ts - dashW;
        for (var dyV = sy + dashGap; dyV < sy + ts - dashGap; dyV += dashLen + dashGap)
            ctx.fillRect(dashX, dyV, dashW, Math.min(dashLen, sy + ts - dashGap - dyV));
    } else if (clMask === 10) {
        // Horizontal straight: yellow dashes at bottom edge (seam between 2 surface tiles)
        ctx.fillStyle = yellowC;
        var dashY = sy + ts - dashW;
        for (var dxH = sx + dashGap; dxH < sx + ts - dashGap; dxH += dashLen + dashGap)
            ctx.fillRect(dxH, dashY, Math.min(dashLen, sx + ts - dashGap - dxH), dashW);
    }
    // Dead-end centerlines (mask=1 N-only, 4 S-only → vertical; mask=2 E-only, 8 W-only → horizontal)
    else if (clMask === 1 || clMask === 4) {
        ctx.fillStyle = yellowC;
        var dashX2 = sx + ts - dashW;
        for (var dyD = sy + dashGap; dyD < sy + ts - dashGap; dyD += dashLen + dashGap)
            ctx.fillRect(dashX2, dyD, dashW, Math.min(dashLen, sy + ts - dashGap - dyD));
    } else if (clMask === 2 || clMask === 8) {
        ctx.fillStyle = yellowC;
        var dashY2 = sy + ts - dashW;
        for (var dxD = sx + dashGap; dxD < sx + ts - dashGap; dxD += dashLen + dashGap)
            ctx.fillRect(dxD, dashY2, Math.min(dashLen, sx + ts - dashGap - dxD), dashW);
    }
    // All other masks (corners, T, 4-way, expansion tiles): clean asphalt, no dashes

    // Isolated tile: full curb border
    if (nb.count === 0) {
        ctx.fillStyle = curbC;
        ctx.fillRect(sx, sy, ts, ew); ctx.fillRect(sx, sy + ts - ew, ts, ew);
        ctx.fillRect(sx, sy, ew, ts); ctx.fillRect(sx + ts - ew, sy, ew, ts);
    }
}

function drawHighwayOverlay(sx, sy, tx, ty) {
    var sprite = game.sprites.highwayOverlay;
    if (sprite) {
        ctx.drawImage(sprite, sx, sy, TILE_SIZE, TILE_SIZE);
        return;
    }

    var ts = TILE_SIZE;
    var ww = WORLD_WIDTH, hh = WORLD_HEIGHT, k = ty * ww + tx;

    // Darker asphalt base for highways
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(sx, sy, ts, ts);

    var sw = Math.max(3, Math.round(ts * 0.06));

    // Bold white shoulder lines at road edges
    ctx.fillStyle = '#e0e0e0';
    var edgeN = isRoadEdge(tx, ty, 'n'), edgeS = isRoadEdge(tx, ty, 's');
    var edgeW = isRoadEdge(tx, ty, 'w'), edgeE = isRoadEdge(tx, ty, 'e');
    if (edgeN) ctx.fillRect(sx, sy, ts, sw);
    if (edgeS) ctx.fillRect(sx, sy + ts - sw, ts, sw);
    if (edgeW) ctx.fillRect(sx, sy, sw, ts);
    if (edgeE) ctx.fillRect(sx + ts - sw, sy, sw, ts);

    // Dark border outside shoulder
    ctx.fillStyle = '#1a1a1a';
    if (edgeN) ctx.fillRect(sx, sy, ts, 1);
    if (edgeS) ctx.fillRect(sx, sy + ts - 1, ts, 1);
    if (edgeW) ctx.fillRect(sx, sy, 1, ts);
    if (edgeE) ctx.fillRect(sx + ts - 1, sy, 1, ts);

    // Center divider: yellow dashes on centerline straight tiles only
    var clMask = ROAD_CENTER_MASK ? ROAD_CENTER_MASK[k] : 0;
    var dashW   = Math.max(2, Math.round(ts * 0.04));
    var dashLen = Math.max(10, Math.round(ts * 0.22));
    var dashGap = Math.max(6, Math.round(ts * 0.14));

    if (clMask === 5) {
        // Vertical highway: yellow dashes at right edge (seam)
        ctx.fillStyle = '#e8c800';
        var dxV = sx + ts - dashW;
        for (var dyy = sy + dashGap; dyy < sy + ts - dashGap; dyy += dashLen + dashGap)
            ctx.fillRect(dxV, dyy, dashW, Math.min(dashLen, sy + ts - dashGap - dyy));
    } else if (clMask === 10) {
        // Horizontal highway: yellow dashes at bottom edge (seam)
        ctx.fillStyle = '#e8c800';
        var dyH = sy + ts - dashW;
        for (var dxx = sx + dashGap; dxx < sx + ts - dashGap; dxx += dashLen + dashGap)
            ctx.fillRect(dxx, dyH, Math.min(dashLen, sx + ts - dashGap - dxx), dashW);
    } else if (clMask === 1 || clMask === 4) {
        ctx.fillStyle = '#e8c800';
        var dxD = sx + ts - dashW;
        for (var dyD = sy + dashGap; dyD < sy + ts - dashGap; dyD += dashLen + dashGap)
            ctx.fillRect(dxD, dyD, dashW, Math.min(dashLen, sy + ts - dashGap - dyD));
    } else if (clMask === 2 || clMask === 8) {
        ctx.fillStyle = '#e8c800';
        var dyD2 = sy + ts - dashW;
        for (var dxD2 = sx + dashGap; dxD2 < sx + ts - dashGap; dxD2 += dashLen + dashGap)
            ctx.fillRect(dxD2, dyD2, Math.min(dashLen, sx + ts - dashGap - dxD2), dashW);
    }
}

// ── Highway micro-features (roadside dressing, pure visual) ─────

const HW_DRESSING_INTERVAL = 11;
const HW_DRESSING_TYPES = ['billboard', 'gas', 'rest_stop', 'mile_marker'];

// ── Background buildings draw ────────────────────────────────────
var _tintVariants = [
    null,
    { filter: 'sepia(15%) saturate(120%)', label: 'warm' },
    { filter: 'hue-rotate(8deg) brightness(1.05)', label: 'cool' },
    { filter: 'brightness(0.92) contrast(1.08)', label: 'dark' },
    { filter: 'saturate(80%) brightness(1.08)', label: 'faded' }
];

function drawCustomBgBuilding(ctx, fpPxX, fpPxBottom, fpPxW, customType, tileX, tileY, colorVariant) {
    var hash = NES.tileHash(tileX, tileY);

    // Hi-res PNG sprite override: center on footprint, bottom-aligned
    if (HIRES_BUILDINGS[customType]) {
        var hb = HIRES_BUILDINGS[customType];
        var scale = TILE_SIZE / 32;
        var dw = hb.w * scale, dh = hb.h * scale;
        var dx = fpPxX + (fpPxW - dw) / 2;
        var dy = fpPxBottom - dh;
        ctx.imageSmoothingEnabled = false;

        var tint = _tintVariants[(colorVariant || 0) % _tintVariants.length];
        if (tint && typeof ctx.filter !== 'undefined') {
            ctx.save();
            ctx.filter = tint.filter;
            ctx.drawImage(hb.img, dx, dy, dw, dh);
            ctx.restore();
        } else {
            ctx.drawImage(hb.img, dx, dy, dw, dh);
        }
        return;
    }

    // NES fallback locals derived from footprint params
    var tw = fpPxW;
    var bh = Math.round(TILE_SIZE * 1.0);
    var sx = fpPxX;
    var by = fpPxBottom - bh;

    if (customType === 'temple') {
        // Multi-tier pagoda/temple roof (Asian style)
        var tiers = 2 + (hash % 2);
        var tierH = Math.floor(bh / (tiers + 1));
        var baseW = tw - 4;
        ctx.fillStyle = '#8a3020';
        ctx.fillRect(sx + 2, by + bh - tierH, baseW, tierH);
        // Stone base
        ctx.fillStyle = NES.PAL.L;
        ctx.fillRect(sx + 4, by + bh - 4, baseW - 4, 4);
        // Tiers (curved roofs narrowing upward)
        for (var ti = 0; ti < tiers; ti++) {
            var ty = by + bh - tierH - ti * tierH;
            var shrink = ti * 6;
            var rw = baseW - shrink;
            var rx = sx + 2 + shrink / 2;
            // Roof overhang
            ctx.fillStyle = '#6a2018';
            ctx.fillRect(rx - 3, ty, rw + 6, 3);
            // Curved roof edge
            ctx.fillStyle = '#a04030';
            ctx.beginPath();
            ctx.moveTo(rx - 4, ty + 3);
            ctx.quadraticCurveTo(rx + rw / 2, ty - 4, rx + rw + 4, ty + 3);
            ctx.lineTo(rx + rw + 4, ty + 6);
            ctx.lineTo(rx - 4, ty + 6);
            ctx.fill();
            // Wall section
            ctx.fillStyle = '#e8d8c0';
            ctx.fillRect(rx + 2, ty + 6, rw - 4, tierH - 8);
            // Window/door
            ctx.fillStyle = NES.PAL.K;
            ctx.fillRect(rx + rw / 2 - 3, ty + 8, 6, tierH - 12);
        }
        // Peak ornament
        ctx.fillStyle = '#c8a040';
        var peakY = by + bh - tierH - tiers * tierH;
        ctx.fillRect(sx + tw / 2 - 1, peakY - 6, 3, 8);
        ctx.fillRect(sx + tw / 2 - 3, peakY - 8, 7, 3);
        // Outline
        ctx.strokeStyle = NES.PAL.K;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 1, by, tw - 2, bh);

    } else if (customType === 'mosque') {
        // Dome + minaret mosque
        var domeR = Math.min(tw * 0.35, bh * 0.3);
        var wallH = bh - domeR;
        // Walls
        ctx.fillStyle = '#e8e0d0';
        ctx.fillRect(sx + 4, by + domeR, tw - 8, wallH);
        // Dome
        ctx.fillStyle = '#d0c8b8';
        ctx.beginPath();
        ctx.arc(sx + tw / 2, by + domeR, domeR, Math.PI, 0);
        ctx.fill();
        ctx.fillStyle = '#c8b898';
        ctx.beginPath();
        ctx.arc(sx + tw / 2, by + domeR, domeR * 0.85, Math.PI, 0);
        ctx.fill();
        // Crescent on dome
        ctx.fillStyle = '#c8a040';
        ctx.fillRect(sx + tw / 2 - 1, by + 2, 3, 6);
        ctx.beginPath();
        ctx.arc(sx + tw / 2, by + 2, 3, 0, Math.PI * 2);
        ctx.fill();
        // Minaret (right side)
        var minW = 5;
        var minH = bh + 8;
        ctx.fillStyle = '#d8d0c0';
        ctx.fillRect(sx + tw - 10, by + bh - minH, minW, minH);
        ctx.fillStyle = '#c8a040';
        ctx.fillRect(sx + tw - 11, by + bh - minH - 3, minW + 2, 3);
        // Door
        ctx.fillStyle = NES.PAL.K;
        ctx.beginPath();
        ctx.arc(sx + tw / 2, by + bh - 10, 5, Math.PI, 0);
        ctx.fillRect(sx + tw / 2 - 5, by + bh - 10, 10, 10);
        // Windows
        ctx.fillStyle = '#4080c0';
        ctx.fillRect(sx + 10, by + domeR + 4, 5, 6);
        ctx.fillRect(sx + tw - 19, by + domeR + 4, 5, 6);
        ctx.strokeStyle = NES.PAL.K;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 3, by, tw - 6, bh);

    } else if (customType === 'tower') {
        // Red lattice tower (Tokyo Tower / radio tower style)
        var baseSpread = tw * 0.7;
        var topW = 6;
        // Legs tapering upward
        ctx.fillStyle = '#c04020';
        ctx.beginPath();
        ctx.moveTo(sx + tw / 2 - baseSpread / 2, by + bh);
        ctx.lineTo(sx + tw / 2 - topW / 2, by);
        ctx.lineTo(sx + tw / 2 + topW / 2, by);
        ctx.lineTo(sx + tw / 2 + baseSpread / 2, by + bh);
        ctx.fill();
        // Cross struts
        ctx.strokeStyle = '#e06040';
        ctx.lineWidth = 1;
        var struts = 5;
        for (var si = 1; si <= struts; si++) {
            var frac = si / (struts + 1);
            var yy = by + bh * (1 - frac);
            var halfW = (baseSpread / 2) * (1 - frac * 0.8) + topW / 2 * frac * 0.8;
            ctx.beginPath();
            ctx.moveTo(sx + tw / 2 - halfW, yy);
            ctx.lineTo(sx + tw / 2 + halfW, yy);
            ctx.stroke();
        }
        // Observation deck
        var deckY = by + bh * 0.35;
        var deckW = baseSpread * 0.45;
        ctx.fillStyle = '#e8e0d0';
        ctx.fillRect(sx + tw / 2 - deckW / 2, deckY, deckW, 5);
        // Antenna
        ctx.fillStyle = NES.PAL.W;
        ctx.fillRect(sx + tw / 2 - 1, by - 8, 2, 10);
        // Red blinking light
        var blink = Math.sin(Date.now() / 400) > 0;
        if (blink) {
            ctx.fillStyle = '#ff0000';
            ctx.fillRect(sx + tw / 2 - 2, by - 9, 4, 3);
        }

    } else if (customType === 'palace') {
        // Grand palace/fortress with walls and spires
        var wallH2 = bh * 0.6;
        ctx.fillStyle = '#c8a848';
        ctx.fillRect(sx + 2, by + bh - wallH2, tw - 4, wallH2);
        // Crenellations
        ctx.fillStyle = '#b09838';
        for (var ci = 0; ci < 6; ci++) {
            ctx.fillRect(sx + 4 + ci * 9, by + bh - wallH2 - 5, 6, 5);
        }
        // Central tower
        var ctw = tw * 0.35;
        var cth = bh * 0.85;
        ctx.fillStyle = '#d8b858';
        ctx.fillRect(sx + tw / 2 - ctw / 2, by + bh - cth, ctw, cth);
        // Pointed roof
        ctx.fillStyle = '#a04030';
        ctx.beginPath();
        ctx.moveTo(sx + tw / 2 - ctw / 2 - 2, by + bh - cth);
        ctx.lineTo(sx + tw / 2, by + bh - cth - 12);
        ctx.lineTo(sx + tw / 2 + ctw / 2 + 2, by + bh - cth);
        ctx.fill();
        // Gate
        ctx.fillStyle = NES.PAL.K;
        ctx.beginPath();
        ctx.arc(sx + tw / 2, by + bh - 12, 7, Math.PI, 0);
        ctx.fillRect(sx + tw / 2 - 7, by + bh - 12, 14, 12);
        ctx.strokeStyle = NES.PAL.K;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 1, by + bh - wallH2 - 5, tw - 2, wallH2 + 5);

    } else if (customType === 'gate') {
        // Torii gate / ceremonial arch
        var postW = 5;
        var postH = bh * 0.85;
        var beamH = 6;
        var gateW = tw * 0.7;
        var gx = sx + (tw - gateW) / 2;
        // Posts
        ctx.fillStyle = '#a04030';
        ctx.fillRect(gx, by + bh - postH, postW, postH);
        ctx.fillRect(gx + gateW - postW, by + bh - postH, postW, postH);
        // Top beam (with slight upward curve at ends)
        ctx.fillStyle = '#c04030';
        ctx.fillRect(gx - 4, by + bh - postH, gateW + 8, beamH);
        // Second beam
        ctx.fillStyle = '#a04030';
        var beam2Y = by + bh - postH + beamH + 6;
        ctx.fillRect(gx + 2, beam2Y, gateW - 4, 4);
        // Curved roof tips
        ctx.beginPath();
        ctx.moveTo(gx - 6, by + bh - postH + beamH);
        ctx.lineTo(gx - 8, by + bh - postH - 3);
        ctx.lineTo(gx - 2, by + bh - postH);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(gx + gateW + 6, by + bh - postH + beamH);
        ctx.lineTo(gx + gateW + 8, by + bh - postH - 3);
        ctx.lineTo(gx + gateW + 2, by + bh - postH);
        ctx.fill();

    } else if (customType === 'monument') {
        // Stone monument / obelisk
        var mw = tw * 0.3;
        var baseH2 = 8;
        // Base platform
        ctx.fillStyle = NES.PAL.L;
        ctx.fillRect(sx + 8, by + bh - baseH2, tw - 16, baseH2);
        // Obelisk body tapering upward
        ctx.fillStyle = '#b0b0b0';
        ctx.beginPath();
        ctx.moveTo(sx + tw / 2 - mw / 2, by + bh - baseH2);
        ctx.lineTo(sx + tw / 2 - mw / 4, by + 4);
        ctx.lineTo(sx + tw / 2 + mw / 4, by + 4);
        ctx.lineTo(sx + tw / 2 + mw / 2, by + bh - baseH2);
        ctx.fill();
        // Pyramid cap
        ctx.fillStyle = '#c8a040';
        ctx.beginPath();
        ctx.moveTo(sx + tw / 2 - mw / 4, by + 4);
        ctx.lineTo(sx + tw / 2, by - 4);
        ctx.lineTo(sx + tw / 2 + mw / 4, by + 4);
        ctx.fill();
        ctx.strokeStyle = NES.PAL.K;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 8, by + bh - baseH2, tw - 16, baseH2);
    } else if (customType === 'mall' && NES.PATTERNS.mallBuilding) {
        var pat = NES.PATTERNS.mallBuilding;
        var pw = pat[0].length, ph = pat.length;
        var scale = tw / 16;
        var sprW = pw * scale, sprH = ph * scale;
        var mx = sx + tw / 2 - sprW / 2;
        var my = by + bh - sprH;
        NES.drawSprite(ctx, mx, my, 'mallBuilding', scale);
    } else if (customType === 'fastfood' && NES.PATTERNS.fastFood) {
        var pat = NES.PATTERNS.fastFood;
        var pw = pat[0].length, ph = pat.length;
        var scale = tw / 16;
        var sprW = pw * scale, sprH = ph * scale;
        var fx = sx + tw / 2 - sprW / 2;
        var fy = by + bh - sprH;
        NES.drawSprite(ctx, fx, fy, 'fastFood', scale);
    } else if (customType === 'pizza' && NES.PATTERNS.pizzaPlace) {
        var pat = NES.PATTERNS.pizzaPlace;
        var pw = pat[0].length, ph = pat.length;
        var scale = tw / 16;
        var sprW = pw * scale, sprH = ph * scale;
        var pzx = sx + tw / 2 - sprW / 2;
        var pzy = by + bh - sprH;
        NES.drawSprite(ctx, pzx, pzy, 'pizzaPlace', scale);
    } else if (customType === 'shop_spr' && NES.PATTERNS.shopBuilding) {
        var sc = tw / 16;
        var p = NES.PATTERNS.shopBuilding;
        NES.drawSprite(ctx, sx + tw/2 - p[0].length*sc/2, by + bh - p.length*sc, 'shopBuilding', sc);
    } else if (customType === 'apt_med_spr' && NES.PATTERNS.aptMedBuilding) {
        var sc = tw / 16;
        var p = NES.PATTERNS.aptMedBuilding;
        NES.drawSprite(ctx, sx + tw/2 - p[0].length*sc/2, by + bh - p.length*sc, 'aptMedBuilding', sc);
    } else if (customType === 'warehouse_spr' && NES.PATTERNS.warehouseBuilding) {
        var sc = tw / 16;
        var p = NES.PATTERNS.warehouseBuilding;
        NES.drawSprite(ctx, sx + tw/2 - p[0].length*sc/2, by + bh - p.length*sc, 'warehouseBuilding', sc);
    } else if (customType === 'apt_small_spr' && NES.PATTERNS.aptSmallBuilding) {
        var sc = tw / 16;
        var p = NES.PATTERNS.aptSmallBuilding;
        NES.drawSprite(ctx, sx + tw/2 - p[0].length*sc/2, by + bh - p.length*sc, 'aptSmallBuilding', sc);
    } else if (customType === 'apt_tall_spr' && NES.PATTERNS.aptTallBuilding) {
        var sc = tw / 16;
        var p = NES.PATTERNS.aptTallBuilding;
        NES.drawSprite(ctx, sx + tw/2 - p[0].length*sc/2, by + bh - p.length*sc, 'aptTallBuilding', sc);
    } else if (customType === 'gas_spr' && NES.PATTERNS.gasStation) {
        var sc = tw / 16;
        var p = NES.PATTERNS.gasStation;
        NES.drawSprite(ctx, sx + tw/2 - p[0].length*sc/2, by + bh - p.length*sc, 'gasStation', sc);
    }
}

// ── Pixel-Data Building Renderer (NES Area 1 — graphics from converted PNGs) ──
var PROC_CFG = {
    FLOOR_PX:     10,
    ROOF_DEPTH:   0.5,
    EDGE_PX:      2,
    SHADOW_PX:    5,
    SHADOW_ALPHA: 0.4,
};

var _bldgCanvasesReady = false;
function _ensureBldgCanvases() {
    if (_bldgCanvasesReady) return;
    if (typeof buildBldgCanvases === 'function' && typeof BLDG_PIXEL_DATA !== 'undefined') {
        buildBldgCanvases();
        _bldgCanvasesReady = true;
    }
}

var ZONE_FLOOR_RANGE = {
    residential: [1, 5],
    commercial:  [1, 3],
    industrial:  [1, 2],
    downtown:    [5, 40],
};

function _procPick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }

function _procBuildParams(bg) {
    var seed = tileHash(bg.x, bg.y);
    var rng = mulberry32(seed);
    var zone = bg.zone || 'residential';

    var floors = bg.floors;
    if (!floors || floors < 1) {
        var range = ZONE_FLOOR_RANGE[zone] || [1, 3];
        floors = range[0] + Math.floor(rng() * (range[1] - range[0] + 1));
    }

    var doorKeys = ['opendoor', 'closedddoors', 'doornostairs', 'doornostairsclosed', 'doorstairsclosed'];
    var doorKey = _procPick(doorKeys, rng);

    var setbacks = null;
    if (floors > 10 && rng() > 0.2) {
        setbacks = [];
        var remaining = floors;
        var baseFloors = Math.ceil(floors * (0.35 + rng() * 0.15));
        setbacks.push({ floors: baseFloors, widthFrac: 1.0 });
        remaining -= baseFloors;
        var curW = 1.0;
        while (remaining > 2 && curW > 0.35) {
            var secFloors = Math.min(remaining, Math.max(3, Math.ceil(floors * (0.12 + rng() * 0.13))));
            curW *= (0.65 + rng() * 0.15);
            if (curW < 0.3) curW = 0.3;
            setbacks.push({ floors: secFloors, widthFrac: curW });
            remaining -= secFloors;
        }
        if (remaining > 0) setbacks[setbacks.length - 1].floors += remaining;
    }

    return {
        floors: floors,
        doorKey: doorKey,
        setbacks: setbacks,
        seed: seed,
    };
}

function _procShadow(ctx, x, y, w, h) {
    if (PROC_CFG.SHADOW_PX <= 0) return;
    ctx.fillStyle = 'rgba(0,0,0,' + PROC_CFG.SHADOW_ALPHA + ')';
    ctx.fillRect(x, y + h + PROC_CFG.EDGE_PX, w + PROC_CFG.EDGE_PX + PROC_CFG.SHADOW_PX, PROC_CFG.SHADOW_PX);
    ctx.fillRect(x + w + PROC_CFG.EDGE_PX, y, PROC_CFG.SHADOW_PX, h + PROC_CFG.EDGE_PX);
}

function _procEdge(ctx, x, y, w, h, fullOutline) {
    var ep = PROC_CFG.EDGE_PX;
    ctx.fillStyle = '#000';
    if (fullOutline) {
        ctx.fillRect(x, y, w, ep);
        ctx.fillRect(x, y + h, w, ep);
        ctx.fillRect(x - ep, y, ep, h + ep);
        ctx.fillRect(x + w, y, ep, h + ep);
    } else {
        ctx.fillRect(x + w, y, ep, h + ep);
        ctx.fillRect(x, y + h, w, ep);
    }
}

function _procRoof(ctx, x, y, w, roofH) {
    var tex = (w >= 110 && BLDG_CANVASES.bigroof) ? BLDG_CANVASES.bigroof : BLDG_CANVASES.roof;
    if (!tex) return;
    ctx.drawImage(tex, x, y, w, roofH);
}

function _procWall(ctx, x, y, w, wallH, fpPxW) {
    var tex = (fpPxW >= 110 && BLDG_CANVASES.bigwall) ? BLDG_CANVASES.bigwall : BLDG_CANVASES.wall;
    if (!tex) return;
    var scaleX = w / tex.width;
    var tileH = Math.max(4, Math.round(tex.height * scaleX));
    var offset = 0;
    while (offset < wallH) {
        var drawH = Math.min(tileH, wallH - offset);
        var srcH = Math.round(drawH * tex.height / tileH);
        if (srcH > tex.height) srcH = tex.height;
        if (srcH < 1) srcH = 1;
        ctx.drawImage(tex, 0, 0, tex.width, srcH, x, y + offset, w, drawH);
        offset += drawH;
    }
}

function _procDoor(ctx, x, wallBottom, w, wallH, params) {
    var tex = BLDG_CANVASES[params.doorKey];
    if (!tex) return;
    var dw = tex.width * 2;
    var dh = tex.height * 2;
    var dx = x + Math.round((w - dw) / 2);
    var dy = wallBottom - dh;
    ctx.drawImage(tex, dx, dy, dw, dh);
}

var _minWallHCached = 0;
function _getMinWallH() {
    if (_minWallHCached > 0) return _minWallHCached;
    var maxH = 0;
    var dks = ['opendoor','closedddoors','doornostairs','doornostairsclosed','doorstairsclosed'];
    for (var i = 0; i < dks.length; i++) {
        var c = BLDG_CANVASES[dks[i]];
        if (c && c.height > maxH) maxH = c.height;
    }
    _minWallHCached = maxH * 2 + 6;
    return _minWallHCached;
}

function _procSection(ctx, x, topY, w, roofH, wallH, fpPxW, params, isBase) {
    _procRoof(ctx, x, topY, w, roofH);
    _procWall(ctx, x, topY + roofH, w, wallH, fpPxW);
    if (isBase) _procDoor(ctx, x, topY + roofH + wallH, w, wallH, params);
}

function drawProceduralBuilding(ctx, fpPxX, fpPxBottom, fpPxW, params) {
    _ensureBldgCanvases();
    if (!_bldgCanvasesReady) return;

    var floors = params.floors;
    var floorH = PROC_CFG.FLOOR_PX;
    var totalWallH = Math.max(floors * floorH, _getMinWallH());
    var roofH = Math.max(6, Math.round(fpPxW * PROC_CFG.ROOF_DEPTH));

    if (!params.setbacks || params.setbacks.length <= 1) {
        var totalH = roofH + totalWallH;
        var topY = fpPxBottom - totalH;
        _procShadow(ctx, fpPxX, topY, fpPxW, totalH);
        _procSection(ctx, fpPxX, topY, fpPxW, roofH, totalWallH, fpPxW, params, true);
        _procEdge(ctx, fpPxX, topY, fpPxW, totalH);
        return;
    }

    var sections = params.setbacks;
    var secGeo = [];
    var curBottom = fpPxBottom;
    var parentX = fpPxX;
    var parentW = fpPxW;
    for (var si = 0; si < sections.length; si++) {
        var sec = sections[si];
        var secW = Math.round(fpPxW * sec.widthFrac);
        var secX = parentX + Math.round((parentW - secW) / 2);
        var secWallH = sec.floors * floorH;
        var secRoofH = Math.max(6, Math.round(secW * PROC_CFG.ROOF_DEPTH));
        var secTotalH = secWallH + secRoofH;
        var secTopY = curBottom - secTotalH;
        secGeo.push({ x: secX, w: secW, wallH: secWallH, roofH: secRoofH, totalH: secTotalH, topY: secTopY, floors: sec.floors });
        curBottom = curBottom - secWallH;
        parentX = secX;
        parentW = secW;
    }

    for (var si = 0; si < secGeo.length; si++) {
        var g = secGeo[si];
        if (si === 0) _procShadow(ctx, g.x, g.topY, g.w, g.totalH);
        _procSection(ctx, g.x, g.topY, g.w, g.roofH, g.wallH, fpPxW, params, si === 0);
    }
    for (var si = 0; si < secGeo.length; si++) {
        var g = secGeo[si];
        _procEdge(ctx, g.x, g.topY, g.w, g.totalH, si > 0);
    }
    // Ledge-front borders at each setback step
    var ep = PROC_CFG.EDGE_PX;
    ctx.fillStyle = '#000';
    // Left border on the base section
    var base = secGeo[0];
    ctx.fillRect(base.x - ep, base.topY, ep, base.totalH + ep);
    // Horizontal ledge lines where each upper tier meets the wider tier below
    for (var si = 1; si < secGeo.length; si++) {
        var lower = secGeo[si - 1];
        var upper = secGeo[si];
        var ledgeY = upper.topY + upper.totalH;
        var leftGap = upper.x - lower.x;
        if (leftGap > 0) {
            ctx.fillRect(lower.x, ledgeY, leftGap + ep, ep);
        }
        var rightGap = (lower.x + lower.w) - (upper.x + upper.w);
        if (rightGap > 0) {
            ctx.fillRect(upper.x + upper.w, ledgeY, rightGap, ep);
        }
    }

    if (floors >= 20) {
        var topG = secGeo[secGeo.length - 1];
        var antennaX = fpPxX + Math.round(fpPxW / 2);
        var antennaH = 8 + Math.floor(floors * 0.4);
        ctx.fillStyle = '#555';
        ctx.fillRect(antennaX, topG.topY - antennaH, 2, antennaH);
        ctx.fillStyle = '#c00';
        ctx.fillRect(antennaX - 1, topG.topY - antennaH - 1, 4, 3);
        ctx.fillStyle = '#666';
        ctx.fillRect(antennaX - 2, topG.topY - Math.round(antennaH * 0.4), 6, 1);
    }
}

// ── Procedural building param cache ──
var _procParamCache = {};
var _procParamCacheSize = 0;

function _getProceduralParams(bg) {
    var key = bg.x + ',' + bg.y;
    if (_procParamCache[key]) return _procParamCache[key];
    var p = _procBuildParams(bg);
    _procParamCache[key] = p;
    _procParamCacheSize++;
    if (_procParamCacheSize > 4000) {
        _procParamCache = {};
        _procParamCacheSize = 0;
    }
    return p;
}

function drawBgBuildings(startX, startY, endX, endY) {
    var rowStart = Math.max(0, startY - 2);
    var rowEnd = Math.min(WORLD_HEIGHT - 1, endY);
    for (var row = rowStart; row <= rowEnd; row++) {
        var bucket = ROW_BG[row];
        if (!bucket) continue;
        for (var i = 0; i < bucket.length; i++) {
        var bg = bucket[i];
        var fp = resolveFP(bg);
        if (bg.x + fp.w < startX || bg.x > endX) continue;

        var fpPxX = bg.x * TILE_SIZE - game.camera.x;
        var fpPxW = fp.w * TILE_SIZE;
        var fpPxBottom = (bg.y + 1) * TILE_SIZE - game.camera.y;

        var params = _getProceduralParams(bg);
        drawProceduralBuilding(ctx, fpPxX, fpPxBottom, fpPxW, params);
        } // end bucket loop
    } // end row loop
}

// ── Streetscape props draw ───────────────────────────────────────
function drawTownProps(startX, startY, endX, endY) {
    var rowStart = Math.max(0, startY);
    var rowEnd = Math.min(WORLD_HEIGHT - 1, endY);
    for (var row = rowStart; row <= rowEnd; row++) {
        var bucket = ROW_PROPS[row];
        if (!bucket) continue;
        for (var i = 0; i < bucket.length; i++) {
        var p = bucket[i];
        if (p.x < startX || p.x > endX) continue;
        var sx = p.x * TILE_SIZE - game.camera.x;
        var sy = p.y * TILE_SIZE - game.camera.y;
        // Sprite lookup: propLamp, propTree, etc.
        var propSpriteKey = PROP_SPRITE_KEYS[p.kind];
        var propSprite = propSpriteKey ? game.sprites[propSpriteKey] : null;
        if (propSprite) {
            ctx.drawImage(propSprite, sx, sy, TILE_SIZE, TILE_SIZE);
        } else if (p.kind === 'lamppost') {
            ctx.fillStyle = NES.PAL.G;
            ctx.fillRect(sx + TILE_SIZE / 2 - 2, sy + 10, 4, TILE_SIZE - 14);
            ctx.fillStyle = NES.PAL.W;
            ctx.fillRect(sx + TILE_SIZE / 2 - 4, sy + 4, 8, 6);
            ctx.fillStyle = NES.PAL.T;
            ctx.fillRect(sx + TILE_SIZE / 2 - 3, sy + 5, 6, 4);
        } else if (p.kind === 'tree') {
            ctx.fillStyle = NES.PAL.M;
            ctx.fillRect(sx + TILE_SIZE / 2 - 2, sy + TILE_SIZE * 0.5, 4, TILE_SIZE * 0.4);
            ctx.fillStyle = NES.PAL.C;
            ctx.fillRect(sx + TILE_SIZE / 2 - 10, sy + TILE_SIZE * 0.2, 20, 20);
            ctx.fillStyle = NES.PAL.B;
            ctx.fillRect(sx + TILE_SIZE / 2 - 8, sy + TILE_SIZE * 0.22, 16, 16);
        } else if (p.kind === 'dumpster') {
            ctx.fillStyle = NES.PAL.G;
            ctx.fillRect(sx + 8, sy + TILE_SIZE - 16, TILE_SIZE - 16, 12);
            ctx.fillStyle = NES.PAL.K;
            ctx.fillRect(sx + 8, sy + TILE_SIZE - 18, TILE_SIZE - 16, 3);
        } else if (p.kind === 'palm') {
            ctx.fillStyle = NES.PAL.M;
            ctx.fillRect(sx + TILE_SIZE / 2 - 2, sy + TILE_SIZE * 0.3, 4, TILE_SIZE * 0.6);
            ctx.fillStyle = NES.PAL.C;
            ctx.fillRect(sx + TILE_SIZE / 2 - 12, sy + TILE_SIZE * 0.15, 6, 14);
            ctx.fillRect(sx + TILE_SIZE / 2 + 6, sy + TILE_SIZE * 0.15, 6, 14);
            ctx.fillRect(sx + TILE_SIZE / 2 - 8, sy + TILE_SIZE * 0.1, 16, 8);
        } else if (p.kind === 'vent') {
            ctx.fillStyle = NES.PAL.G;
            ctx.fillRect(sx + 12, sy + TILE_SIZE - 14, TILE_SIZE - 24, 10);
            ctx.fillStyle = NES.PAL.K;
            for (var vi = 0; vi < 3; vi++) ctx.fillRect(sx + 14 + vi * 10, sy + TILE_SIZE - 12, 6, 1);
        }
        } // end bucket loop
    } // end row loop
}

function drawHighwayDressing(startX, startY, endX, endY) {
    if (!ROAD_GRID || !ROAD_TYPE_GRID) return;

    for (var y = startY; y < endY; y++) {
        if (y < 0 || y >= WORLD_HEIGHT) continue;
        for (var x = startX; x < endX; x++) {
            if (x < 0 || x >= WORLD_WIDTH) continue;
            var key = y * WORLD_WIDTH + x;
            if (ROAD_TYPE_GRID[key] !== 2) continue;

            var h = tileHash(x, y);
            if (h % HW_DRESSING_INTERVAL !== 0) continue;

            var sx = x * TILE_SIZE - game.camera.x;
            var sy = y * TILE_SIZE - game.camera.y;
            if (sx < -TILE_SIZE || sx > CANVAS_WIDTH || sy < -TILE_SIZE || sy > CANVAS_HEIGHT) continue;

            var dType = HW_DRESSING_TYPES[h % HW_DRESSING_TYPES.length];
            var side = (h >> 4) & 1;
            var ox = side ? TILE_SIZE + 2 : -20;

            if (dType === 'billboard') {
                drawRoadsideBillboard(sx + ox, sy + 4, h);
            } else if (dType === 'gas') {
                drawRoadsideGas(sx + ox, sy + 8);
            } else if (dType === 'rest_stop') {
                drawRoadsideRestStop(sx + ox, sy + 6);
            } else if (dType === 'mile_marker') {
                drawRoadsideMileMarker(sx + ox + 4, sy + 10, h);
            }
        }
    }
}

function drawRoadsideBillboard(x, y, hash) {
    var bw = 28, bh = 18;
    ctx.fillStyle = NES.PAL.L;
    ctx.fillRect(x, y, bw, bh);
    ctx.fillStyle = NES.PAL.G;
    ctx.fillRect(x + bw / 2 - 1, y + bh, 3, 12);
    ctx.fillRect(x + bw / 2 - 7, y + bh, 3, 12);
    var msgs = ['EAT', 'GAS', 'MOTEL', 'EXIT', 'DINE'];
    var pals = [NES.PAL.R, NES.PAL.B, NES.PAL.N, NES.PAL.T, NES.PAL.R];
    var idx = hash % msgs.length;
    ctx.fillStyle = pals[idx];
    ctx.fillRect(x + 1, y + 1, bw - 2, bh - 2);
    ctx.fillStyle = NES.PAL.W;
    ctx.font = 'bold 7px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(msgs[idx], x + bw / 2, y + bh / 2 + 3);
    ctx.textAlign = 'left';
}

function drawRoadsideGas(x, y) {
    ctx.fillStyle = NES.PAL.R;
    ctx.fillRect(x + 2, y, 14, 14);
    ctx.fillStyle = NES.PAL.W;
    ctx.font = 'bold 6px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('GAS', x + 9, y + 10);
    ctx.textAlign = 'left';
    ctx.fillStyle = NES.PAL.G;
    ctx.fillRect(x + 8, y + 14, 2, 8);
}

function drawRoadsideRestStop(x, y) {
    ctx.fillStyle = NES.PAL.B;
    ctx.fillRect(x, y, 18, 12);
    ctx.fillStyle = NES.PAL.W;
    ctx.font = '5px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('REST', x + 9, y + 8);
    ctx.textAlign = 'left';
    ctx.fillStyle = NES.PAL.G;
    ctx.fillRect(x + 8, y + 12, 2, 6);
}

function drawRoadsideMileMarker(x, y, hash) {
    ctx.fillStyle = NES.PAL.C;
    ctx.fillRect(x, y, 12, 8);
    ctx.fillStyle = NES.PAL.K;
    ctx.font = '5px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String((hash % 900) + 100), x + 6, y + 6);
    ctx.textAlign = 'left';
    ctx.fillStyle = NES.PAL.G;
    ctx.fillRect(x + 5, y + 8, 2, 6);
}

// ── Roadside POI system ─────────────────────────────────────────
// Deterministic POIs reuse the same tileHash placement as dressing.
// Types: 'gas' (heal to full HP in next level), 'rest_stop' (speed boost), 'billboard' used as 'view' (postcard).
const POI_TYPES = { gas: true, rest_stop: true, billboard: true };
const POI_PROMPTS = { gas: 'SUPPLIES (A)', rest_stop: 'REST (A)', billboard: 'VIEW (A)' };

function updatePOIProximity() {
    if (!ROAD_GRID || !ROAD_TYPE_GRID) { game.activePOI = null; return; }
    var px = game.player.x + game.player.width / 2;
    var py = game.player.y + game.player.height / 2;
    var ptx = Math.floor(px / TILE_SIZE);
    var pty = Math.floor(py / TILE_SIZE);
    var best = null, bestDist = 2.5 * TILE_SIZE;

    for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
            var tx = ptx + dx, ty = pty + dy;
            if (tx < 0 || tx >= WORLD_WIDTH || ty < 0 || ty >= WORLD_HEIGHT) continue;
            var key = ty * WORLD_WIDTH + tx;
            if (ROAD_TYPE_GRID[key] !== 2) continue;
            var h = tileHash(tx, ty);
            if (h % HW_DRESSING_INTERVAL !== 0) continue;
            var dType = HW_DRESSING_TYPES[h % HW_DRESSING_TYPES.length];
            if (!POI_TYPES[dType]) continue;
            var cx = tx * TILE_SIZE + TILE_SIZE / 2;
            var cy = ty * TILE_SIZE + TILE_SIZE / 2;
            var dist = Math.abs(px - cx) + Math.abs(py - cy);
            if (dist < bestDist) { bestDist = dist; best = { type: dType, x: tx, y: ty }; }
        }
    }
    game.activePOI = best;
}

function interactWithPOI() {
    if (!game.activePOI) return false;
    var poi = game.activePOI;
    if (poi.type === 'gas') {
        game.poiHealReady = true;
        showPOIFlash('SUPPLIES READY! +2 HP next level');
    } else if (poi.type === 'rest_stop') {
        game.speedBoost = 20;
        game.player.pxPerSecond = 600;
        showPOIFlash('SPEED BOOST! 20s');
    } else if (poi.type === 'billboard') {
        var h = tileHash(poi.x, poi.y);
        var cards = ['Welcome to the open road!', 'Scenic view ahead', 'Home of the world\'s largest pizza',
                     'Greetings from the highway!', 'Nothing but blue sky', 'The journey is the reward'];
        game.postcard = { text: cards[h % cards.length], timer: 3.5 };
    }
    game.activePOI = null;
    return true;
}

function showPOIFlash(msg) {
    game.postcard = { text: msg, timer: 2.0 };
}

function drawPOIPrompt() {
    if (!game.activePOI) return;
    var poi = game.activePOI;
    var sx = poi.x * TILE_SIZE - game.camera.x + TILE_SIZE / 2;
    var sy = poi.y * TILE_SIZE - game.camera.y - 12;
    var label = POI_PROMPTS[poi.type] || 'INTERACT (A)';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    var tw = ctx.measureText(label).width + 8;
    ctx.fillRect(sx - tw / 2, sy - 6, tw, 14);
    ctx.fillStyle = '#ffcc00';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, sx, sy + 4);
    ctx.textAlign = 'left';
}

function drawPostcard() {
    if (!game.postcard) return;
    var alpha = Math.min(1, game.postcard.timer / 0.5);
    ctx.save();
    ctx.globalAlpha = alpha;
    // Centered banner
    var w = 280, h = 50;
    var bx = (CANVAS_WIDTH - w) / 2, by = CANVAS_HEIGHT * 0.2;
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(bx, by, w, h);
    ctx.strokeStyle = '#ffcc00';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(game.postcard.text, CANVAS_WIDTH / 2, by + h / 2 + 4);
    ctx.textAlign = 'left';
    ctx.restore();
}

function drawBridgeTile(sx, sy, tx, ty) {
    var sprite = game.sprites.bridgeTile;
    if (sprite) {
        ctx.drawImage(sprite, sx, sy, TILE_SIZE, TILE_SIZE);
        return;
    }

    var ts = TILE_SIZE;

    // Draw water underneath first
    NES.drawTileStretched(ctx, sx, sy, ts, ts, NES.waterFrame());

    // Determine bridge orientation from neighboring road tiles
    var ww = WORLD_WIDTH, hh = WORLD_HEIGHT;
    var k = (ty !== undefined) ? ty * ww + tx : -1;
    var hasN = k >= 0 && ty > 0      && ROAD_GRID && ROAD_GRID[k - ww];
    var hasS = k >= 0 && ty < hh - 1 && ROAD_GRID && ROAD_GRID[k + ww];
    var hasW = k >= 0 && tx > 0      && ROAD_GRID && ROAD_GRID[k - 1];
    var hasE = k >= 0 && tx < ww - 1 && ROAD_GRID && ROAD_GRID[k + 1];
    var isVert = hasN || hasS;
    var isHoriz = hasW || hasE;
    if (!isVert && !isHoriz) isHoriz = true; // default

    var railW   = Math.max(3, Math.round(ts * 0.08)); // guardrail width
    var postW   = Math.max(2, Math.round(ts * 0.04)); // railing post width
    var postGap = Math.max(8, Math.round(ts * 0.20)); // gap between posts
    var deckInset = Math.max(2, Math.round(ts * 0.06)); // water visible at edges

    if (isHoriz && !isVert) {
        // Horizontal bridge: deck runs left-right, water visible top+bottom
        var deckTop = sy + deckInset;
        var deckH = ts - deckInset * 2;

        // Concrete deck
        NES.drawTileStretched(ctx, sx, deckTop, ts, deckH, 'bridgeDeck');

        // Deck shadow on water (subtle)
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(sx, sy + ts - deckInset, ts, deckInset);

        // Road surface on deck
        ctx.fillStyle = '#686868';
        ctx.fillRect(sx, deckTop + railW, ts, deckH - railW * 2);

        // Yellow center dashes
        ctx.fillStyle = '#e8c800';
        var centerY = deckTop + Math.round(deckH / 2) - 1;
        for (var d = sx + 4; d < sx + ts - 4; d += Math.round(ts * 0.14))
            ctx.fillRect(d, centerY, Math.round(ts * 0.07), 2);

        // Guardrails (top and bottom)
        ctx.fillStyle = '#888888';
        ctx.fillRect(sx, deckTop, ts, railW);
        ctx.fillRect(sx, deckTop + deckH - railW, ts, railW);

        // Railing top highlight
        ctx.fillStyle = '#c0c0c0';
        ctx.fillRect(sx, deckTop, ts, 1);
        ctx.fillRect(sx, deckTop + deckH - 1, ts, 1);

        // Posts
        ctx.fillStyle = '#606060';
        for (var px = sx + postGap; px < sx + ts; px += postGap) {
            ctx.fillRect(px, deckTop, postW, railW + 2);
            ctx.fillRect(px, deckTop + deckH - railW - 2, postW, railW + 2);
        }
    } else {
        // Vertical bridge: deck runs top-bottom, water visible left+right
        var deckLeft = sx + deckInset;
        var deckW = ts - deckInset * 2;

        // Concrete deck
        NES.drawTileStretched(ctx, deckLeft, sy, deckW, ts, 'bridgeDeck');

        // Deck shadow on water
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(sx + ts - deckInset, sy, deckInset, ts);

        // Road surface on deck
        ctx.fillStyle = '#686868';
        ctx.fillRect(deckLeft + railW, sy, deckW - railW * 2, ts);

        // Yellow center dashes
        ctx.fillStyle = '#e8c800';
        var centerX = deckLeft + Math.round(deckW / 2) - 1;
        for (var d2 = sy + 4; d2 < sy + ts - 4; d2 += Math.round(ts * 0.14))
            ctx.fillRect(centerX, d2, 2, Math.round(ts * 0.07));

        // Guardrails (left and right)
        ctx.fillStyle = '#888888';
        ctx.fillRect(deckLeft, sy, railW, ts);
        ctx.fillRect(deckLeft + deckW - railW, sy, railW, ts);

        // Railing highlight
        ctx.fillStyle = '#c0c0c0';
        ctx.fillRect(deckLeft, sy, 1, ts);
        ctx.fillRect(deckLeft + deckW - 1, sy, 1, ts);

        // Posts
        ctx.fillStyle = '#606060';
        for (var py = sy + postGap; py < sy + ts; py += postGap) {
            ctx.fillRect(deckLeft, py, railW + 2, postW);
            ctx.fillRect(deckLeft + deckW - railW - 2, py, railW + 2, postW);
        }
    }
}

// World tile types: 0=ocean, 1=coast, 2=land, 3=mountain, 4=river

function drawWorldTile(sx, sy, type, tx, ty) {
    if (type === 0 || type === 4) {
        NES.drawTileStretched(ctx, sx, sy, TILE_SIZE, TILE_SIZE, NES.waterFrame());
    } else if (type === 1) {
        // Directional coast on world map too
        drawWorldCoastTile(sx, sy, tx, ty);
    } else if (type === 3) {
        NES.drawTileStretched(ctx, sx, sy, TILE_SIZE, TILE_SIZE, 'mountain');
    } else {
        var grassIdx = (tx !== undefined && ty !== undefined) ? NES.tileHash(tx, ty) % 4 : 0;
        var WGRASS = ['grass1', 'grass2', 'grass3', 'grass4'];
        NES.drawTileStretched(ctx, sx, sy, TILE_SIZE, TILE_SIZE, WGRASS[grassIdx]);
    }
}

function drawWorldCoastTile(px, py, tx, ty) {
    var ts = TILE_SIZE;
    if (tx === undefined || ty === undefined) {
        NES.drawTileStretched(ctx, px, py, ts, ts, 'coastFallback');
        return;
    }
    // Check neighbors in MAP for water
    function isWaterW(nx, ny) {
        if (nx < 0 || nx >= WORLD_WIDTH || ny < 0 || ny >= WORLD_HEIGHT) return true;
        var t = MAP[ny] ? MAP[ny][nx] : 0;
        return t === 0 || t === 4;
    }
    var wN = isWaterW(tx, ty - 1);
    var wS = isWaterW(tx, ty + 1);
    var wW = isWaterW(tx - 1, ty);
    var wE = isWaterW(tx + 1, ty);
    var wNW = isWaterW(tx - 1, ty - 1);
    var wNE = isWaterW(tx + 1, ty - 1);
    var wSW = isWaterW(tx - 1, ty + 1);
    var wSE = isWaterW(tx + 1, ty + 1);

    // Grass base
    var gi = NES.tileHash(tx, ty) % 4;
    var GP = ['grass1', 'grass2', 'grass3', 'grass4'];
    NES.drawTileStretched(ctx, px, py, ts, ts, GP[gi]);

    var sandW = Math.max(2, Math.round(ts * 0.15));
    var waterW = Math.max(3, Math.round(ts * 0.35));
    var waterC = NES.PAL.B;
    var waveC = NES.PAL.C;
    var sandC = '#d4b870';
    var foamC = '#a0d8f8';

    if (wN) {
        ctx.fillStyle = waterC; ctx.fillRect(px, py, ts, waterW);
        ctx.fillStyle = waveC;
        for (var i = 0; i < ts; i += 4) if ((NES.tileHash(tx * 8 + i, ty) & 1) === 0) ctx.fillRect(px + i, py + waterW - 3, 2, 1);
        ctx.fillStyle = foamC; ctx.fillRect(px, py + waterW - 1, ts, 1);
        ctx.fillStyle = sandC; ctx.fillRect(px, py + waterW, ts, sandW);
    }
    if (wS) {
        var sb = py + ts - waterW - sandW;
        ctx.fillStyle = sandC; ctx.fillRect(px, sb, ts, sandW);
        ctx.fillStyle = foamC; ctx.fillRect(px, sb + sandW, ts, 1);
        ctx.fillStyle = waterC; ctx.fillRect(px, sb + sandW, ts, waterW);
        ctx.fillStyle = waveC;
        for (var i2 = 0; i2 < ts; i2 += 4) if ((NES.tileHash(tx * 8 + i2, ty + 50) & 1) === 0) ctx.fillRect(px + i2, sb + sandW + 2, 2, 1);
    }
    if (wW) {
        ctx.fillStyle = waterC; ctx.fillRect(px, py, waterW, ts);
        ctx.fillStyle = waveC;
        for (var j = 0; j < ts; j += 4) if ((NES.tileHash(tx, ty * 8 + j) & 1) === 0) ctx.fillRect(px + waterW - 3, py + j, 1, 2);
        ctx.fillStyle = foamC; ctx.fillRect(px + waterW - 1, py, 1, ts);
        ctx.fillStyle = sandC; ctx.fillRect(px + waterW, py, sandW, ts);
    }
    if (wE) {
        var eb = px + ts - waterW - sandW;
        ctx.fillStyle = sandC; ctx.fillRect(eb, py, sandW, ts);
        ctx.fillStyle = foamC; ctx.fillRect(eb + sandW, py, 1, ts);
        ctx.fillStyle = waterC; ctx.fillRect(eb + sandW, py, waterW, ts);
        ctx.fillStyle = waveC;
        for (var j2 = 0; j2 < ts; j2 += 4) if ((NES.tileHash(tx + 50, ty * 8 + j2) & 1) === 0) ctx.fillRect(eb + sandW + 2, py + j2, 1, 2);
    }

    // Diagonal corner fills
    var cr = Math.max(2, Math.round(ts * 0.2));
    if (wNW && !wN && !wW) { ctx.fillStyle = waterC; ctx.fillRect(px, py, cr, cr); ctx.fillStyle = sandC; ctx.fillRect(px + cr, py, sandW, cr); ctx.fillRect(px, py + cr, cr + sandW, sandW); }
    if (wNE && !wN && !wE) { ctx.fillStyle = waterC; ctx.fillRect(px + ts - cr, py, cr, cr); ctx.fillStyle = sandC; ctx.fillRect(px + ts - cr - sandW, py, sandW, cr); ctx.fillRect(px + ts - cr - sandW, py + cr, cr + sandW, sandW); }
    if (wSW && !wS && !wW) { ctx.fillStyle = waterC; ctx.fillRect(px, py + ts - cr, cr, cr); ctx.fillStyle = sandC; ctx.fillRect(px + cr, py + ts - cr, sandW, cr); ctx.fillRect(px, py + ts - cr - sandW, cr + sandW, sandW); }
    if (wSE && !wS && !wE) { ctx.fillStyle = waterC; ctx.fillRect(px + ts - cr, py + ts - cr, cr, cr); ctx.fillStyle = sandC; ctx.fillRect(px + ts - cr - sandW, py + ts - cr, sandW, cr); ctx.fillRect(px + ts - cr - sandW, py + ts - cr - sandW, cr + sandW, sandW); }
}

// ── Phase 7.1: Type-specific landmark rendering ────────────────

function drawHighwaySignpost(sx, sy, label) {
    var cx = sx + (TILE_SIZE >> 1);
    ctx.fillStyle = NES.PAL.G;
    ctx.fillRect(cx - 2, sy + 28, 4, TILE_SIZE - 28);
    var shieldW = 38, shieldH = 24;
    var shieldX = cx - (shieldW >> 1);
    var shieldY = sy + 4;
    ctx.fillStyle = NES.PAL.N;
    ctx.fillRect(shieldX, shieldY, shieldW, shieldH);
    ctx.strokeStyle = NES.PAL.W;
    ctx.lineWidth = 2;
    ctx.strokeRect(shieldX, shieldY, shieldW, shieldH);
    ctx.fillStyle = NES.PAL.R;
    ctx.fillRect(shieldX + 2, shieldY + 2, shieldW - 4, 5);
    ctx.fillStyle = NES.PAL.B;
    ctx.fillRect(shieldX + 2, shieldY + shieldH - 7, shieldW - 4, 5);
    ctx.fillStyle = NES.PAL.W;
    ctx.font = 'bold 8px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, shieldY + 17);
}

function drawWelcomeSign(sx, sy, label) {
    var cx = sx + (TILE_SIZE >> 1);
    ctx.fillStyle = NES.PAL.M;
    ctx.fillRect(sx + 10, sy + 24, 4, TILE_SIZE - 24);
    ctx.fillRect(sx + TILE_SIZE - 14, sy + 24, 4, TILE_SIZE - 24);
    var boardW = TILE_SIZE - 6, boardH = 28;
    var boardX = sx + 3, boardY = sy + 2;
    ctx.fillStyle = NES.PAL.T;
    ctx.fillRect(boardX, boardY, boardW, boardH);
    ctx.strokeStyle = NES.PAL.K;
    ctx.lineWidth = 2;
    ctx.strokeRect(boardX, boardY, boardW, boardH);
    ctx.fillStyle = NES.PAL.K;
    ctx.font = '5px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('WELCOME TO', cx, boardY + 10);
    ctx.font = 'bold 7px "Press Start 2P", monospace';
    ctx.fillText(label, cx, boardY + 22);
}

function drawTownSign(sx, sy, label) {
    var cx = sx + (TILE_SIZE >> 1);
    ctx.font = 'bold 9px monospace';
    var textW = ctx.measureText(label).width;
    var bgW = Math.max(TILE_SIZE - 4, textW + 14);
    var bgX = cx - (bgW >> 1);
    // Dark background panel
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(bgX, sy, bgW, 18);
    // Accent underline
    ctx.fillStyle = '#fcfc00';
    ctx.fillRect(bgX, sy + 16, bgW, 2);
    // City name
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, sy + 12);
}

function drawBlimpPortMarker(sx, sy, label) {
    var cx = sx + (TILE_SIZE >> 1);
    var cy = sy + TILE_SIZE - 16;
    // Landing pad circle
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(80, 80, 80, 0.5)';
    ctx.fill();
    ctx.strokeStyle = '#fcfc00';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Dashed inner ring
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(252, 252, 0, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // H mark
    ctx.fillStyle = '#fcfc00';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('H', cx, cy + 5);
    // Label
    if (label) {
        ctx.font = '7px monospace';
        ctx.fillStyle = '#000';
        ctx.fillRect(cx - 26, sy, 52, 10);
        ctx.fillStyle = '#fcfc00';
        ctx.fillText(label, cx, sy + 8);
    }
}

function drawSewerEntrance(sx, sy) {
    var bobY = Math.sin(Date.now() / 600) * 2;
    var cx = sx + (TILE_SIZE >> 1);
    var cy = sy + (TILE_SIZE >> 1) + bobY;
    var cleared = game.progress.levelWins['level_sewer'];
    NES.drawTileStretched(ctx, cx - 16, cy - 16, 32, 32, 'manhole');
    if (!cleared) {
        var pulse = Math.sin(Date.now() / 400) * 0.3 + 0.4;
        ctx.beginPath();
        ctx.arc(cx, cy, 18, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(60,188,252,' + pulse.toFixed(2) + ')';
        ctx.lineWidth = 2;
        ctx.stroke();
    }
    ctx.fillStyle = NES.PAL.K;
    ctx.fillRect(cx - 20, sy - 2, 40, 10);
    ctx.fillStyle = cleared ? NES.PAL.L : NES.PAL.C;
    ctx.font = 'bold 7px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(cleared ? 'CLEARED' : 'SEWER', cx, sy + 6);
    ctx.textAlign = 'left';
}

function drawOsmLandmark(sx, sy, spriteType, label) {
    var ts = TILE_SIZE;

    if (spriteType === 'temple' && NES.PATTERNS.pagoda) {
        NES.drawTileStretched(ctx, sx, sy, ts, ts, 'pagoda');
    } else if (spriteType === 'gate' && NES.PATTERNS.torii) {
        NES.drawTileStretched(ctx, sx, sy, ts, ts, 'torii');
    } else if (spriteType === 'mosque' && NES.PATTERNS.minaret) {
        NES.drawTileStretched(ctx, sx, sy, ts, ts, 'minaret');
    } else if (spriteType === 'tower') {
        drawCustomBgBuilding(ctx, sx, sy + ts, ts, 'tower', 0, 0, 0);
    } else if (spriteType === 'palace') {
        drawCustomBgBuilding(ctx, sx, sy + ts, ts, 'palace', 0, 0, 0);
    } else if (spriteType === 'monument') {
        drawCustomBgBuilding(ctx, sx, sy + ts, ts, 'monument', 0, 0, 0);
    } else {
        ctx.fillStyle = '#a04040';
        ctx.fillRect(sx + 4, sy + 4, ts - 8, ts - 8);
        ctx.strokeStyle = NES.PAL.K;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 4, sy + 4, ts - 8, ts - 8);
    }

    if (label) {
        var truncLabel = label.length > 10 ? label.substring(0, 9) + '.' : label;
        ctx.font = '6px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        var lw = ctx.measureText(truncLabel).width + 4;
        ctx.fillRect(sx + ts / 2 - lw / 2, sy - 10, lw, 10);
        ctx.fillStyle = '#fcfc00';
        ctx.fillText(truncLabel, sx + ts / 2, sy - 2);
        ctx.textAlign = 'left';
    }
}

function drawLandmark(lm) {
    var sx = lm.x * TILE_SIZE - game.camera.x;
    var sy = lm.y * TILE_SIZE - game.camera.y;

    if (sx > CANVAS_WIDTH || sx + TILE_SIZE < 0 || sy > CANVAS_HEIGHT || sy + TILE_SIZE < 0) return;

    var sprite = lm.sprite ? game.sprites[lm.sprite] : null;
    if (sprite) {
        ctx.drawImage(sprite, sx, sy, TILE_SIZE, TILE_SIZE);
    } else if (lm.id.indexOf('lm_hw_') === 0) {
        drawHighwaySignpost(sx, sy, lm.label);
    } else if (lm.id.indexOf('lm_welcome_') === 0) {
        drawWelcomeSign(sx, sy, lm.label);
    } else if (lm.id.indexOf('lm_town_') === 0) {
        drawTownSign(sx, sy, lm.label);
    } else if (lm.id.indexOf('lm_blimp_') === 0) {
        drawBlimpPortMarker(sx, sy, lm.label);
    } else if (lm.id === 'lm_sewer') {
        drawSewerEntrance(sx, sy);
    } else if (lm.id.indexOf('lm_osm_') === 0 && lm.sprite) {
        drawOsmLandmark(sx, sy, lm.sprite, lm.label);
    } else if (lm.sprite === 'statueOfLiberty' && NES.PATTERNS.statueOfLiberty) {
        var pat = NES.PATTERNS.statueOfLiberty;
        var pw = pat[0].length, ph = pat.length;
        var pxScale = TILE_SIZE / 16;
        var sprW = pw * pxScale, sprH = ph * pxScale;
        var drawX = sx + TILE_SIZE / 2 - sprW / 2;
        var drawY = sy + TILE_SIZE - sprH;
        NES.drawSprite(ctx, drawX, drawY, 'statueOfLiberty', pxScale);
        if (lm.label) {
            ctx.font = '7px "Press Start 2P", monospace';
            ctx.textAlign = 'center';
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            var tw = ctx.measureText(lm.label).width + 6;
            ctx.fillRect(sx + TILE_SIZE / 2 - tw / 2, drawY - 14, tw, 11);
            ctx.fillStyle = '#fcfc00';
            ctx.fillText(lm.label, sx + TILE_SIZE / 2, drawY - 5);
            ctx.textAlign = 'left';
        }
    } else if (lm.sprite === 'chryslerBuilding') {
        var hb = HIRES_BUILDINGS['chryslerBuilding'];
        if (hb) {
            var scale = TILE_SIZE / 32;
            var sprW = hb.w * scale, sprH = hb.h * scale;
            var drawX = sx + TILE_SIZE / 2 - sprW / 2;
            var drawY = sy + TILE_SIZE - sprH;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(hb.img, drawX, drawY, sprW, sprH);
        } else if (NES.PATTERNS.chryslerBuilding) {
            var pat = NES.PATTERNS.chryslerBuilding;
            var pw = pat[0].length, ph = pat.length;
            var pxScale = TILE_SIZE / 16;
            var sprW = pw * pxScale, sprH = ph * pxScale;
            var drawX = sx + TILE_SIZE / 2 - sprW / 2;
            var drawY = sy + TILE_SIZE - sprH;
            NES.drawSprite(ctx, drawX, drawY, 'chryslerBuilding', pxScale);
        }
        if (lm.label) {
            var _dY = sy + TILE_SIZE - (HIRES_BUILDINGS['chryslerBuilding'] ? HIRES_BUILDINGS['chryslerBuilding'].h * (TILE_SIZE/32) : 252);
            ctx.font = '7px "Press Start 2P", monospace';
            ctx.textAlign = 'center';
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            var tw2 = ctx.measureText(lm.label).width + 6;
            ctx.fillRect(sx + TILE_SIZE / 2 - tw2 / 2, _dY - 14, tw2, 11);
            ctx.fillStyle = '#fcfc00';
            ctx.fillText(lm.label, sx + TILE_SIZE / 2, _dY - 5);
            ctx.textAlign = 'left';
        }
    } else if (lm.sprite === 'empireState' && NES.PATTERNS.empireState) {
        var pat = NES.PATTERNS.empireState;
        var pw = pat[0].length, ph = pat.length;
        var pxScale = TILE_SIZE / 16;
        var sprW = pw * pxScale, sprH = ph * pxScale;
        var drawX = sx + TILE_SIZE / 2 - sprW / 2;
        var drawY = sy + TILE_SIZE - sprH;
        NES.drawSprite(ctx, drawX, drawY, 'empireState', pxScale);
        if (lm.label) {
            ctx.font = '7px "Press Start 2P", monospace';
            ctx.textAlign = 'center';
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            var tw = ctx.measureText(lm.label).width + 6;
            ctx.fillRect(sx + TILE_SIZE / 2 - tw / 2, drawY - 14, tw, 11);
            ctx.fillStyle = '#fcfc00';
            ctx.fillText(lm.label, sx + TILE_SIZE / 2, drawY - 5);
            ctx.textAlign = 'left';
        }
    } else {
        ctx.fillStyle = '#8B4513';
        ctx.fillRect(sx + (TILE_SIZE >> 1) - 4, sy + 8, 8, TILE_SIZE - 8);
        ctx.fillStyle = '#D2691E';
        ctx.fillRect(sx + 4, sy + 4, TILE_SIZE - 8, 16);
        if (lm.label) {
            ctx.font = '8px monospace';
            var labelY = Math.max(sy, 2);
            ctx.fillStyle = '#000';
            ctx.fillRect(sx + 2, labelY - 2, TILE_SIZE - 4, 12);
            ctx.fillStyle = '#fcfc00';
            ctx.textAlign = 'center';
            ctx.fillText(lm.label, sx + (TILE_SIZE >> 1), labelY + 7);
        }
    }
}

function drawLandmarks() {
    if (LANDMARKS.length === 0) return;
    var savedFont = ctx.font;
    var savedAlign = ctx.textAlign;
    for (var i = 0; i < LANDMARKS.length; i++) drawLandmark(LANDMARKS[i]);
    ctx.font = savedFont;
    ctx.textAlign = savedAlign;
}

function draw() {
    // Level mode: completely separate render
    if (game.mode === 'LEVEL') {
        drawLevel();
        return;
    }

    ctx.fillStyle = game.mode === 'WORLD' ? NES.PAL.B : NES.PAL.G;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    
    // Draw only visible tiles
    const startX = Math.floor(game.camera.x / TILE_SIZE);
    const startY = Math.floor(game.camera.y / TILE_SIZE);
    const endX = startX + SCREEN_TILES_X + 2;
    const endY = startY + SCREEN_TILES_Y + 2;
    
    const isWorldMode = game.mode === 'WORLD';

    for (let y = startY; y < endY; y++) {
        const inBoundsY = y >= 0 && y < WORLD_HEIGHT;

        if (isWorldMode) {
            for (let x = startX; x < endX; x++) {
                const sx = x * TILE_SIZE - game.camera.x;
                const sy = y * TILE_SIZE - game.camera.y;
                if (sx < -TILE_SIZE || sx > CANVAS_WIDTH || sy < -TILE_SIZE || sy > CANVAS_HEIGHT) continue;
                let tile = 0;
                if (inBoundsY && x >= 0 && x < WORLD_WIDTH) tile = MAP[y][x];
                drawWorldTile(sx, sy, tile, x, y);
            }
            continue;
        }

        // Region mode: district variants + road/river/bridge overlays
        for (let x = startX; x < endX; x++) {
            let tile = 0;
            if (inBoundsY && x >= 0 && x < WORLD_WIDTH) {
                tile = MAP[y][x];
                const key = y * WORLD_WIDTH + x;
                const sx = x * TILE_SIZE - game.camera.x;
                const sy = y * TILE_SIZE - game.camera.y;
                const distId = getDistrictForTile(x, y);
                const rowVariants = distId === 'downtown' ? DOWNTOWN_VARIANTS
                                  : distId === 'midtown'  ? MIDTOWN_VARIANTS
                                  : distId != null         ? UPTOWN_VARIANTS
                                  : null;

                // Priority: base ground → dirt → sidewalk → river → bridge → road
                drawTile(x, y, tile, rowVariants, distId);

                if (RIVER_GRID && RIVER_GRID[key]) {
                    drawRiverTile(sx, sy);
                    continue;
                }
                if (BRIDGE_GRID && BRIDGE_GRID[key]) {
                    drawBridgeTile(sx, sy, x, y);
                    continue;
                }
                if (ROAD_GRID && ROAD_GRID[key]) {
                    if (ROAD_TYPE_GRID && ROAD_TYPE_GRID[key] === 2) {
                        drawHighwayOverlay(sx, sy, x, y);
                    } else {
                        drawRoadOverlay(sx, sy, x, y);
                    }
                    continue;
                }
                // Sidewalk overlay on grass tiles adjacent to roads
                if (SIDEWALK_GRID && SIDEWALK_GRID[key]) {
                    NES.drawTileStretched(ctx, sx, sy, TILE_SIZE, TILE_SIZE, 'sidewalk');
                    // Draw curb edge toward adjacent road
                    var curbW = Math.max(2, Math.round(TILE_SIZE * 0.06));
                    ctx.fillStyle = '#909090';
                    if (x > 0 && ROAD_GRID && ROAD_GRID[key - 1])
                        ctx.fillRect(sx, sy, curbW, TILE_SIZE);
                    if (x < WORLD_WIDTH - 1 && ROAD_GRID && ROAD_GRID[key + 1])
                        ctx.fillRect(sx + TILE_SIZE - curbW, sy, curbW, TILE_SIZE);
                    if (y > 0 && ROAD_GRID && ROAD_GRID[key - WORLD_WIDTH])
                        ctx.fillRect(sx, sy, TILE_SIZE, curbW);
                    if (y < WORLD_HEIGHT - 1 && ROAD_GRID && ROAD_GRID[key + WORLD_WIDTH])
                        ctx.fillRect(sx, sy + TILE_SIZE - curbW, TILE_SIZE, curbW);
                    continue;
                }
                // Dirt patches near buildings
                if (DIRT_GRID && DIRT_GRID[key]) {
                    var dirtPat = (NES.tileHash(x, y) & 1) ? 'dirt1' : 'dirt2';
                    NES.drawTileStretched(ctx, sx, sy, TILE_SIZE, TILE_SIZE, dirtPat);
                    continue;
                }
                continue;
            }
            drawTile(x, y, tile, null, null);
        }
    }
    
    if (game.mode === 'WORLD') {
        // World map: artist markers, then region nodes on top
        drawWorldMarkers();
        drawWorldNodes();
    } else {
        // Region map: y-sorted rendering for proper depth ordering
        // Player, BG buildings, enterable buildings, and landmarks all interleave by y
        drawHighwayDressing(startX, startY, endX, endY);

        // Determine player's sort-y (bottom edge of player sprite = "feet")
        var _playerSortY;
        if (game.controllerEntity === 'foot') {
            _playerSortY = Math.floor((game.turtle.y + game.turtle.height) / TILE_SIZE);
        } else {
            _playerSortY = Math.floor((game.player.y + game.player.height) / TILE_SIZE);
        }
        var _playerDrawn = false;

        var rStart = Math.max(0, startY - 2);
        var rEnd = Math.min(WORLD_HEIGHT - 1, endY + 1);

        for (var ry = rStart; ry <= rEnd; ry++) {
            // Y-sort: draw player BEFORE buildings on their row
            // so buildings at/below the player render ON TOP (closer to camera)
            if (!_playerDrawn && ry >= _playerSortY) {
                _playerDrawn = true;
                if (game.controllerEntity === 'foot') {
                    drawParkedVan();
                    drawOnFootTurtle();
                } else {
                    drawPartyWagon();
                }
            }

            // Draw BG buildings for this row (procedural renderer)
            var bgBucket = ROW_BG[ry];
            if (bgBucket) {
                for (var bgi = 0; bgi < bgBucket.length; bgi++) {
                    var bg = bgBucket[bgi];
                    var _fp = resolveFP(bg);
                    if (bg.x + _fp.w < startX || bg.x > endX) continue;
                    var _fpPxX = bg.x * TILE_SIZE - game.camera.x;
                    var _fpPxW = _fp.w * TILE_SIZE;
                    var _fpPxBottom = (bg.y + 1) * TILE_SIZE - game.camera.y;
                    var _pp = _getProceduralParams(bg);
                    drawProceduralBuilding(ctx, _fpPxX, _fpPxBottom, _fpPxW, _pp);
                }
            }

            // Draw enterable buildings for this row
            var bRow = ROW_BUILDINGS[ry];
            if (bRow) for (var bi = 0; bi < bRow.length; bi++) {
                var bld = bRow[bi];
                if (bld.x >= startX - 2 && bld.x <= endX + 1) drawBuilding(bld, BUILDINGS.indexOf(bld));
            }

            // Draw landmarks for this row
            var lRow = ROW_LANDMARKS[ry];
            if (lRow) for (var li = 0; li < lRow.length; li++) {
                var lm = lRow[li];
                if (lm.x >= startX - 2 && lm.x <= endX + 1) drawLandmark(lm);
            }
        }

        // If player wasn't drawn (below all buildings), draw now
        if (!_playerDrawn) {
            if (game.controllerEntity === 'foot') {
                drawParkedVan();
                drawOnFootTurtle();
            } else {
                drawPartyWagon();
            }
        }

        drawTownProps(startX, startY, endX, endY);

        // Draw remote multiplayer players (viewport-culled for scalability)
        if (typeof MP !== 'undefined') {
            var _mpRemote = MP.getRemotePlayers();
            var _facingToDir = { n: 'up', s: 'down', e: 'right', w: 'left' };
            if (_mpRemote.length > 0) {
                var _vpMargin = 256;
                for (var _ri = 0; _ri < _mpRemote.length; _ri++) {
                    var _rp = _mpRemote[_ri];
                    var _rpWorldX = _rp.px != null ? _rp.px : _rp.x * TILE_SIZE;
                    var _rpWorldY = _rp.py != null ? _rp.py : _rp.y * TILE_SIZE;
                    if (_rpWorldX < game.camera.x - _vpMargin || _rpWorldX > game.camera.x + CANVAS_WIDTH + _vpMargin ||
                        _rpWorldY < game.camera.y - _vpMargin || _rpWorldY > game.camera.y + CANVAS_HEIGHT + _vpMargin) continue;
                    var _rpx = _rpWorldX - game.camera.x;
                    var _rpy = _rpWorldY - game.camera.y;
                    var _rDir = _facingToDir[_rp.facing] || 'down';
                    var _rMode = _rp.mode || 'van';
                    var _rTid = _rp.tid || 'leo';

                    if (_rMode === 'foot' && typeof NES !== 'undefined') {
                        var _tDrawW = game.turtle.width || 32;
                        var _tDrawH = game.turtle.height || 32;
                        var _tScale = _tDrawW / 16;
                        NES.drawTurtleSprite(ctx, _rpx, _rpy, _rDir, 0, _rTid, _tScale);
                        ctx.font = '8px monospace';
                        ctx.textAlign = 'center';
                        var _tlabel = (_rp.displayName || _rp.id || '???').substring(0, 12);
                        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                        ctx.fillRect(_rpx + _tDrawW / 2 - 30, _rpy - 14, 60, 12);
                        ctx.fillStyle = '#fff';
                        ctx.fillText(_tlabel, _rpx + _tDrawW / 2, _rpy - 4);
                        ctx.textAlign = 'left';
                    } else {
                        var _rFrameSet = game.wagonFrames[_rDir];
                        var _rFrameKey = _rFrameSet ? _rFrameSet[0] : 'down1';
                        var _rPatKey = WAGON_PATTERN_MAP[_rFrameKey];
                        var _rDrawW = game.player.width || 128;
                        var _rDrawH = game.player.height || 128;
                        var _rFlip = (_rDir === 'left');
                        ctx.save();
                        ctx.imageSmoothingEnabled = false;
                        ctx.translate(_rpx + _rDrawW / 2, _rpy + _rDrawH / 2);
                        if (_rFlip) ctx.scale(-1, 1);
                        if (_rPatKey && typeof NES !== 'undefined') {
                            var _rScale = _rDrawW / 32;
                            NES.drawSprite(ctx, -_rDrawW / 2, -_rDrawH / 2, _rPatKey, _rScale);
                        } else {
                            ctx.fillStyle = 'rgba(0, 200, 255, 0.7)';
                            ctx.fillRect(-_rDrawW / 2, -_rDrawH / 2, _rDrawW, _rDrawH);
                        }
                        ctx.restore();
                        ctx.font = '8px monospace';
                        ctx.textAlign = 'center';
                        var _rlabel = (_rp.displayName || _rp.id || '???').substring(0, 12);
                        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                        ctx.fillRect(_rpx + _rDrawW / 2 - 30, _rpy - 14, 60, 12);
                        ctx.fillStyle = '#fff';
                        ctx.fillText(_rlabel, _rpx + _rDrawW / 2, _rpy - 4);
                        ctx.textAlign = 'left';
                    }
                }
            }
        }
    }
    // MP debug overlay
    if (typeof MP !== 'undefined') {
        var _dbgRemote = MP.getRemotePlayers();
        ctx.font = '9px monospace';
        ctx.fillStyle = '#0f0';
        ctx.textAlign = 'left';
        var _dbgText = 'MP:' + (MP.isConnected() ? 'ON' : 'OFF') + ' r:' + _dbgRemote.length;
        if (_dbgRemote.length > 0) {
            var _dr = _dbgRemote[0];
            _dbgText += ' px:' + (_dr.px||'?') + ',' + (_dr.py||'?') + ' id:' + (_dr.id||'?').substr(0,6);
        }
        ctx.fillText(_dbgText, 4, CANVAS_HEIGHT - 4);
    }
    
    // Draw player for WORLD mode only (region player already drawn in y-sort above)
    if (game.mode === 'WORLD') {
        drawBlimp();
    }
    
    // Debug zones overlay (before UI so UI stays on top)
    drawDebugZones();
    
    // Draw UI (on top, no camera offset)
    drawUI();

    // Mode indicator
    if (game.mode === 'WORLD') {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(CANVAS_WIDTH / 2 - 60, 4, 120, 18);
        ctx.fillStyle = '#00ff00';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(BRAND.title + ' — WORLD', CANVAS_WIDTH / 2, 16);
        ctx.textAlign = 'left';
        // Active node prompt
        if (game.activeNodeId && game.state === 'OVERWORLD') {
            var activeNode = WORLD_NODE_BY_ID[game.activeNodeId];
            if (activeNode) {
                var promptText = 'ENTER: Fly to ' + activeNode.label;
                var tw = ctx.measureText(promptText).width + 16;
                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                ctx.fillRect(CANVAS_WIDTH / 2 - tw / 2, 26, tw, 18);
                ctx.fillStyle = '#fcfc00';
                ctx.textAlign = 'center';
                ctx.fillText(promptText, CANVAS_WIDTH / 2, 38);
                ctx.textAlign = 'left';
            }
        }
    } else if (game.currentRegionId) {
        const regions = getWorldRegions();
        const reg = regions.find(function(r) { return r.id === game.currentRegionId; });
        if (reg) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(CANVAS_WIDTH / 2 - 60, 4, 120, 18);
            ctx.fillStyle = '#fcfc00';
            ctx.font = 'bold 10px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(reg.label, CANVAS_WIDTH / 2, 16);
            ctx.textAlign = 'left';
        }
        // Blimp port prompt
        if (game.activeBlimpId && game.state === 'OVERWORLD' && !game.blimpMenu.active) {
            var blimpPrompt = 'ENTER: Use Blimp Port';
            ctx.font = 'bold 10px monospace';
            var bpw = ctx.measureText(blimpPrompt).width + 16;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(CANVAS_WIDTH / 2 - bpw / 2, 26, bpw, 18);
            ctx.fillStyle = '#fcfc00';
            ctx.textAlign = 'center';
            ctx.fillText(blimpPrompt, CANVAS_WIDTH / 2, 38);
            ctx.textAlign = 'left';
        }
    }
    
    // Loading indicator when sprites are still downloading
    if (!game.spritesReady) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(CANVAS_WIDTH / 2 - 80, CANVAS_HEIGHT - 40, 160, 24);
        ctx.fillStyle = '#fcfc00';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('LOADING ART...', CANVAS_WIDTH / 2, CANVAS_HEIGHT - 24);
        ctx.textAlign = 'left';
    }
    
    // POI interaction prompt + postcard overlay
    if (game.mode === 'REGION') {
        drawPOIPrompt();
        if (game.speedBoost > 0) {
            ctx.fillStyle = 'rgba(0,80,200,0.6)';
            ctx.fillRect(CANVAS_WIDTH - 100, CANVAS_HEIGHT - 30, 92, 18);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 8px monospace';
            ctx.fillText('BOOST ' + Math.ceil(game.speedBoost) + 's', CANVAS_WIDTH - 94, CANVAS_HEIGHT - 17);
        }
    }
    drawPostcard();

    // Blimp menu overlay (on top of everything except fades)
    drawBlimpMenu();

    // ── Overworld HUD: score + items + turtle team (Phase 6c) ──────────────
    if (game.mode === 'REGION') {
        // Score counter
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(CANVAS_WIDTH - 140, 8, 132, 16);
        ctx.fillStyle = '#fcfc00';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'right';
        ctx.fillText('SCORE: ' + game.progress.score.toLocaleString(), CANVAS_WIDTH - 14, 20);
        ctx.textAlign = 'left';
        // Items counter
        var itemCount = Object.keys(game.progress.collectedItems).length;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(CANVAS_WIDTH - 140, 28, 132, 14);
        ctx.fillStyle = itemCount >= 10 ? '#ff44ff' : '#ffffff';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'right';
        ctx.fillText('ITEMS: ' + itemCount + '/10', CANVAS_WIDTH - 14, 39);
        ctx.textAlign = 'left';

        // Turtle team selector (top-left, below header)
        var tNames = ['leo', 'raph', 'donnie', 'mikey'];
        var tLabels = ['LEO', 'RAPH', 'DON', 'MIKE'];
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(8, 32, 112, 28);
        for (var ti = 0; ti < 4; ti++) {
            var tx = 12 + ti * 27;
            var isActive = (game.activeTurtle === tNames[ti]);
            if (isActive) {
                ctx.fillStyle = 'rgba(255, 255, 0, 0.3)';
                ctx.fillRect(tx - 2, 33, 26, 26);
            }
            NES.drawTurtleSprite(ctx, tx, 35, 'down', 0, tNames[ti], 1.2);
            ctx.fillStyle = isActive ? '#fcfc00' : '#666666';
            ctx.font = '5px monospace';
            ctx.fillText(tLabels[ti], tx + 1, 57);
        }

        // On-foot mode indicator
        if (game.controllerEntity === 'foot') {
            var footY = 64;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(8, footY, 112, 16);
            var vanDist = getVanReenterDist();
            var nearVan = vanDist <= game.player.width * 0.8;
            ctx.fillStyle = nearVan ? '#4ade80' : '#fbbf24';
            ctx.font = 'bold 7px monospace';
            ctx.fillText(nearVan ? '[T] ENTER VAN' : 'ON FOOT — [T] near van', 12, footY + 11);
        }
    }

    // ── Technodrome message overlay ─────────────────────────
    if (game.technodromeMsg && game.technodromeMsgTimer > 0) {
        var tmAlpha = Math.min(1.0, game.technodromeMsgTimer);
        ctx.fillStyle = 'rgba(0, 0, 0, ' + (tmAlpha * 0.8) + ')';
        ctx.fillRect(0, CANVAS_HEIGHT / 2 - 20, CANVAS_WIDTH, 40);
        ctx.fillStyle = 'rgba(255, 68, 255, ' + tmAlpha + ')';
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(game.technodromeMsg, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 4);
        ctx.textAlign = 'left';
    }

    // ── Score Board overlay ─────────────────────────────────
    if (game.showScoreBoard) {
        drawScoreBoard();
    }

    // Unified fade compositor — one black rect, max alpha from all active fades
    var fadeAlpha = 0;
    if (game.transition.active) {
        var bp = Math.min(1, game.transition.t / game.transition.duration);
        fadeAlpha = Math.max(fadeAlpha, game.transition.dir === 'toBuilding' ? bp : 1 - bp);
    }
    if (game.mapTransition.active) {
        var mp = Math.min(1, game.mapTransition.t / game.mapTransition.duration);
        fadeAlpha = Math.max(fadeAlpha, game.mapTransition.dir === 'toRegion' ? mp : 1 - mp);
    }
    if (fadeAlpha > 0.001) {
        ctx.fillStyle = 'rgba(0, 0, 0, ' + fadeAlpha + ')';
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }

    // Blimp fast-travel fade (on top of everything)
    drawBlimpFade();
}

// ============================================
// DEBUG DRAW — toggle with backtick key
// ============================================

function getPlayerDistrict() {
    var entity = (game.controllerEntity === 'foot') ? game.turtle : game.player;
    const tileX = Math.floor(entity.x / TILE_SIZE);
    const tileY = Math.floor(entity.y / TILE_SIZE);
    for (const d of DISTRICTS) {
        if (typeof d.x0 === 'number') {
            if (tileX >= d.x0 && tileX <= d.x1) return d;
        } else if (typeof d.y0 === 'number') {
            if (tileY >= d.y0 && tileY <= d.y1) return d;
        }
    }
    return null;
}

function drawDebugZones() {
    if (!game.debugZones) return;

    const startX = Math.floor(game.camera.x / TILE_SIZE);
    const startY = Math.floor(game.camera.y / TILE_SIZE);
    const endX = startX + SCREEN_TILES_X + 2;
    const endY = startY + SCREEN_TILES_Y + 2;

    for (let ty = startY; ty < endY; ty++) {
        for (let tx = startX; tx < endX; tx++) {
            if (tx < 0 || tx >= WORLD_WIDTH || ty < 0 || ty >= WORLD_HEIGHT) continue;
            const key = ty * WORLD_WIDTH + tx;
            const sx = tx * TILE_SIZE - game.camera.x;
            const sy = ty * TILE_SIZE - game.camera.y;
            if (COLLISION_GRID && COLLISION_GRID[key]) {
                ctx.fillStyle = 'rgba(255, 0, 0, 0.3)';
                ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
            } else if (RIVER_GRID && RIVER_GRID[key]) {
                ctx.fillStyle = 'rgba(0, 100, 255, 0.25)';
                ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
            } else if (ROAD_GRID && ROAD_GRID[key]) {
                ctx.fillStyle = 'rgba(200, 200, 200, 0.2)';
                ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
            }
        }
    }

    for (const d of DISTRICTS) {
        var bx, by, bw, bh;
        if (typeof d.x0 === 'number') {
            bx = d.x0 * TILE_SIZE - game.camera.x;
            by = 0 - game.camera.y;
            bw = (d.x1 - d.x0 + 1) * TILE_SIZE;
            bh = WORLD_HEIGHT * TILE_SIZE;
        } else {
            bx = 0 - game.camera.x;
            by = d.y0 * TILE_SIZE - game.camera.y;
            bw = WORLD_WIDTH * TILE_SIZE;
            bh = (d.y1 - d.y0 + 1) * TILE_SIZE;
        }
        ctx.strokeStyle = 'rgba(255, 0, 255, 0.6)';
        ctx.lineWidth = 2;
        ctx.strokeRect(bx, by, bw, bh);
        ctx.fillStyle = 'rgba(255, 0, 255, 0.8)';
        ctx.font = '12px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(d.id.toUpperCase(), bx + 4, by + 14);
    }

    BUILDINGS.forEach(b => {
        const isActive = b.id === game.activeBuildingId;
        const lw = isActive ? 3 : 1;
        drawDebugRect(b.exitWorld, 'rgba(255, 255, 0, 0.15)', 'rgba(255, 255, 0, 0.7)', lw);
        drawDebugRect(b.enterWorld, 'rgba(0, 255, 0, 0.15)', 'rgba(0, 255, 0, 0.7)', lw);
        drawDebugRect(b.collisionWorld, 'rgba(255, 0, 0, 0.15)', 'rgba(255, 0, 0, 0.7)', lw);
        const sx = b.worldX - game.camera.x;
        const sy = b.worldY - game.camera.y - 12;
        ctx.fillStyle = isActive ? '#ff0' : '#fff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(b.id + (isActive ? ' [ACTIVE]' : ''), sx, sy);
    });

    const pRect = getPlayerRect();
    drawDebugRect(pRect, 'rgba(0, 128, 255, 0.2)', 'rgba(0, 128, 255, 0.9)', 2);

    const dist = getPlayerDistrict();
    const pcx = game.player.x + 64;
    const pcy = game.player.y + 64;
    let nearestLm = null;
    let nearestDist = Infinity;
    for (const lm of LANDMARKS) {
        const lx = lm.x * TILE_SIZE + TILE_SIZE / 2;
        const ly = lm.y * TILE_SIZE + TILE_SIZE / 2;
        const d = Math.hypot(lx - pcx, ly - pcy);
        if (d < nearestDist) { nearestDist = d; nearestLm = lm; }
    }

    ctx.fillStyle = '#0af';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    const tileX = Math.floor(game.player.x / TILE_SIZE);
    const tileY = Math.floor(game.player.y / TILE_SIZE);
    ctx.fillText('active: ' + (game.activeBuildingId || 'none'), 10, CANVAS_HEIGHT - 46);
    ctx.fillText('district: ' + (dist ? dist.id : 'none'), 10, CANVAS_HEIGHT - 34);
    ctx.fillText('nearest: ' + (nearestLm ? nearestLm.label + ' (' + Math.round(nearestDist / TILE_SIZE) + ' tiles)' : 'none'), 10, CANVAS_HEIGHT - 22);
    ctx.fillText('tile: ' + tileX + ',' + tileY, 10, CANVAS_HEIGHT - 10);

    // Pack coverage badge (top-right)
    if (game._packInfo) {
        var pi = game._packInfo;
        var badge = 'PACK: ' + pi.id + ' (' + pi.overrides + ' overrides, ' + pi.optMissing + ' missing)';
        ctx.font = '9px monospace';
        var bw = ctx.measureText(badge).width + 10;
        ctx.fillStyle = pi.optMissing > 0 ? 'rgba(180,100,0,0.8)' : 'rgba(0,120,60,0.8)';
        ctx.fillRect(CANVAS_WIDTH - bw - 4, CANVAS_HEIGHT - 60, bw, 14);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(badge, CANVAS_WIDTH - bw, CANVAS_HEIGHT - 50);
    }
}

function drawDebugRect(rect, fill, stroke, lw) {
    const sx = rect.x - game.camera.x;
    const sy = rect.y - game.camera.y;
    if (sx > CANVAS_WIDTH || sx + rect.w < 0 || sy > CANVAS_HEIGHT || sy + rect.h < 0) return;
    ctx.fillStyle = fill;
    ctx.fillRect(sx, sy, rect.w, rect.h);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.strokeRect(sx, sy, rect.w, rect.h);
}

// ============================================
// GAME LOOP — delta time with stall protection
// ============================================

let lastTime = 0;

function gameLoop(now) {
    // First frame: seed lastTime and skip
    if (lastTime === 0) {
        lastTime = now;
        requestAnimationFrame(gameLoop);
        return;
    }
    
    const rawDt = (now - lastTime) / 1000; // seconds
    lastTime = now;
    
    // Stall frame (tab switch, app switch): skip movement, clear all input + pressed CSS
    if (rawDt > 0.2) {
        clearAllInput();
        draw();
        requestAnimationFrame(gameLoop);
        return;
    }
    
    // Clamp dt to 50ms max to prevent large jumps on slow frames
    const dt = Math.min(rawDt, 0.05);
    
    update(dt);
    if (typeof MP !== 'undefined' && MP.isConnected()) MP.updateRender();
    draw();
    requestAnimationFrame(gameLoop);
}

// ============================================
// INPUT — keyboard writes to inputState
// ============================================

const keyToDirection = {
    'ArrowUp': 'up', 'KeyW': 'up',
    'ArrowDown': 'down', 'KeyS': 'down',
    'ArrowLeft': 'left', 'KeyA': 'left',
    'ArrowRight': 'right', 'KeyD': 'right'
};

document.addEventListener('keydown', (e) => {
    // Skip game input when a text field or the login overlay has focus
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var loginOv = document.getElementById('loginOverlay');
    if (loginOv && loginOv.style.display !== 'none') return;

    // Blimp menu intercepts all input while active
    if (game.blimpMenu.active) {
        e.preventDefault();
        var ports = game.blimpMenu.ports;
        if (e.code === 'ArrowUp' || e.code === 'KeyW') {
            game.blimpMenu.selectedIndex = (game.blimpMenu.selectedIndex - 1 + ports.length) % ports.length;
        } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
            game.blimpMenu.selectedIndex = (game.blimpMenu.selectedIndex + 1) % ports.length;
        } else if (e.code === 'Enter' || e.code === 'Space' || e.code === 'KeyE') {
            requestPrimaryAction();
        } else if (e.code === 'Escape' || e.code === 'Backspace' || e.code === 'KeyM') {
            requestBackAction();
        }
        return;
    }

    const dir = keyToDirection[e.code];
    if (dir) {
        e.preventDefault();
        inputState[dir] = true;
        return;
    }

    if (e.code === 'Enter' || e.code === 'Space' || e.code === 'KeyE') {
        e.preventDefault();
        requestPrimaryAction();
        return;
    }

    if (e.code === 'Escape' || e.code === 'Backspace' || e.code === 'KeyM') {
        e.preventDefault();
        requestBackAction();
        return;
    }

    // Turtle selection: 1=Leo, 2=Raph, 3=Donnie, 4=Mikey
    var turtleKeys = { 'Digit1': 'leo', 'Digit2': 'raph', 'Digit3': 'donnie', 'Digit4': 'mikey' };
    if (turtleKeys[e.code]) {
        game.activeTurtle = turtleKeys[e.code];
        return;
    }

    if (e.code === 'KeyT') {
        attemptToggleVanFoot();
        return;
    }

    if (e.code === 'Backquote') {
        game.debugZones = !game.debugZones;
        return;
    }

    // H = toggle high score board
    if (e.code === 'KeyH' && game.mode !== 'LEVEL') {
        game.showScoreBoard = !game.showScoreBoard;
        return;
    }

    // P = cycle sprite pack (dev hot reload)
    if (e.code === 'KeyP' && game.mode !== 'LEVEL') {
        var packs = SPRITE_PACK_LIST;
        var cur = getActiveSpritePackId();
        var idx = packs.indexOf(cur);
        var next = packs[(idx + 1) % packs.length];
        // Update URL param without page reload
        try {
            var url = new URL(window.location.href);
            url.searchParams.set('pack', next);
            window.history.replaceState(null, '', url.toString());
        } catch (_) {}
        game.spritesReady = false;
        loadAllSprites().then(function() {
            game.spritesReady = true;
            console.log('Pack hot-reloaded: ' + next);
        });
        return;
    }
});

document.addEventListener('keyup', (e) => {
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const dir = keyToDirection[e.code];
    if (dir) {
        e.preventDefault();
        inputState[dir] = false;
    }
});

// Secret combo: ↑ ↑ ↓ ↓ ← → ← → to open Dev Admin
var _adminCombo = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight'];
var _adminBuf = [];
document.addEventListener('keydown', function(e) {
    _adminBuf.push(e.key);
    if (_adminBuf.length > _adminCombo.length) _adminBuf.shift();
    if (_adminBuf.length === _adminCombo.length && _adminBuf.every(function(k,i){ return k === _adminCombo[i]; })) {
        _adminBuf = [];
        window.location.href = 'admin.html';
    }
});

// ============================================
// MOBILE CONTROLS — pointer events on D-pad
// ============================================

const dpadMap = {
    'btnUp': 'up',
    'btnDown': 'down',
    'btnLeft': 'left',
    'btnRight': 'right'
};

Object.entries(dpadMap).forEach(([btnId, dir]) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    
    function press(e) {
        e.preventDefault();
        inputState[dir] = true;
        btn.classList.add('pressed');
        btn.setPointerCapture(e.pointerId);
    }
    function release(e) {
        if (e) e.preventDefault();
        inputState[dir] = false;
        btn.classList.remove('pressed');
        try { btn.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
});

const actionBtn = document.getElementById('btnAction');
if (actionBtn) {
    let lastActionTs = 0;
    function actionTrigger(e) {
        e.preventDefault();
        const now = performance.now();
        if (now - lastActionTs < 250) return;
        lastActionTs = now;
        requestPrimaryAction();
    }
    actionBtn.addEventListener('pointerdown', actionTrigger);
    actionBtn.addEventListener('click', actionTrigger);
    actionBtn.addEventListener('pointercancel', (e) => e.preventDefault());
}

const overlayCloseBtn = document.getElementById('overlayCloseBtn');
if (overlayCloseBtn) {
    let lastCloseTs = 0;
    function closeTrigger(e) {
        e.preventDefault();
        const now = performance.now();
        if (now - lastCloseTs < 250) return;
        lastCloseTs = now;
        requestBackAction();
    }
    overlayCloseBtn.addEventListener('pointerdown', closeTrigger);
    overlayCloseBtn.addEventListener('click', closeTrigger);
}

// ============================================
// FOCUS LOSS — clear input on blur/hidden to prevent stuck directions
// ============================================

function clearAllInput() {
    clearInputState();
    document.querySelectorAll('.dpad.pressed').forEach(el => el.classList.remove('pressed'));
}

window.addEventListener('blur', clearAllInput);
document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearAllInput();
});
window.addEventListener('beforeunload', saveGame);

// ============================================
// WORLD / REGION MAP TRANSITIONS
// ============================================

let WORLD_NODES = [];
let WORLD_NODE_BY_ID = {};

function getWorldRegions() {
    return (WORLD_DATA && Array.isArray(WORLD_DATA.regions)) ? WORLD_DATA.regions : [];
}

function getWorldNodes() {
    var nodes = (WORLD_DATA && Array.isArray(WORLD_DATA.regionNodes)) ? WORLD_DATA.regionNodes : [];
    WORLD_NODE_BY_ID = Object.fromEntries(nodes.map(function(n) { return [n.id, n]; }));
    return nodes;
}

// ── Artist world markers + clustering ──────────────────────────
// Projected at boot from artists with lat/lon, clustered into grid cells
var WORLD_MARKERS = [];  // [ { x, y, artists: [id,...], label } ]

function buildWorldMarkers() {
    WORLD_MARKERS = [];
    if (!WORLD_DATA || !WORLD_DATA.world) return;
    var ww = WORLD_DATA.world.widthTiles  || 160;
    var wh = WORLD_DATA.world.heightTiles || 90;
    var ts = WORLD_DATA.world.tileSize    || 32;

    // Cluster cell size in tiles — stable across camera moves (tile-coord based, not screen)
    var cellSize = 3;

    // Bucket artists by grid cell (deterministic: same input → same clusters)
    var buckets = {};
    var ids = Object.keys(ARTISTS);
    for (var i = 0; i < ids.length; i++) {
        var a = ARTISTS[ids[i]];
        if (typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
        var tx = Math.min(ww - 1, Math.max(0, Math.floor(((a.lon + 180) / 360) * ww)));
        var ty = Math.min(wh - 1, Math.max(0, Math.floor(((90 - a.lat) / 180) * wh)));
        var cellKey = Math.floor(tx / cellSize) + ',' + Math.floor(ty / cellSize);
        if (!buckets[cellKey]) buckets[cellKey] = { sumX: 0, sumY: 0, artists: [], regions: {} };
        buckets[cellKey].sumX += tx;
        buckets[cellKey].sumY += ty;
        buckets[cellKey].artists.push({ id: ids[i], tx: tx, ty: ty });
        // Count region votes for majority selection
        var rid = a.regionId || 'na';
        buckets[cellKey].regions[rid] = (buckets[cellKey].regions[rid] || 0) + 1;
    }

    // Build region node lookup for "nearest node" fallback
    var nodes = (WORLD_DATA && Array.isArray(WORLD_DATA.regionNodes)) ? WORLD_DATA.regionNodes : [];

    var keys = Object.keys(buckets);
    for (var k = 0; k < keys.length; k++) {
        var b = buckets[keys[k]];
        var count = b.artists.length;
        var cx = Math.round(b.sumX / count);
        var cy = Math.round(b.sumY / count);

        // Region binding: majority region among cluster members
        var regionId = 'na';
        var maxVotes = 0;
        var regionKeys = Object.keys(b.regions);
        for (var r = 0; r < regionKeys.length; r++) {
            if (b.regions[regionKeys[r]] > maxVotes) {
                maxVotes = b.regions[regionKeys[r]];
                regionId = regionKeys[r];
            }
        }

        // Representative artist: nearest member to cluster center
        var bestDist = Infinity;
        var representative = b.artists[0].id;
        for (var m = 0; m < count; m++) {
            var d = Math.abs(b.artists[m].tx - cx) + Math.abs(b.artists[m].ty - cy);
            if (d < bestDist) { bestDist = d; representative = b.artists[m].id; }
        }

        var label = count === 1
            ? (ARTISTS[b.artists[0].id].name || b.artists[0].id)
            : count + ' ARTISTS';

        WORLD_MARKERS.push({
            x: cx, y: cy,
            worldX: cx * ts + (ts >> 1),
            worldY: cy * ts + (ts >> 1),
            artists: b.artists.map(function(a) { return a.id; }),
            label: label,
            regionId: regionId,
            representative: representative
        });
    }
    console.log('World markers: ' + WORLD_MARKERS.length + ' clusters from ' + ids.length + ' artists');
}

function drawWorldMarkers() {
    if (WORLD_MARKERS.length === 0) return;
    var savedFont = ctx.font;
    var savedAlign = ctx.textAlign;
    ctx.imageSmoothingEnabled = false;

    for (var i = 0; i < WORLD_MARKERS.length; i++) {
        var m = WORLD_MARKERS[i];
        var sx = m.worldX - game.camera.x;
        var sy = m.worldY - game.camera.y;
        if (sx < -TILE_SIZE * 2 || sx > CANVAS_WIDTH + TILE_SIZE * 2 ||
            sy < -TILE_SIZE * 2 || sy > CANVAS_HEIGHT + TILE_SIZE * 2) continue;

        var isCluster = m.artists.length > 1;
        var radius = isCluster ? 6 : 4;

        // Marker dot
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fillStyle = isCluster ? '#ff4040' : '#fc00fc';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Count badge for clusters
        if (isCluster) {
            ctx.font = 'bold 8px monospace';
            ctx.textAlign = 'center';
            ctx.fillStyle = '#fff';
            ctx.fillText(m.artists.length.toString(), sx, sy - radius - 2);
        }
    }

    ctx.font = savedFont;
    ctx.textAlign = savedAlign;
}

function startEnterRegion(regionId) {
    if (game.mapTransition.active) return;
    const regions = getWorldRegions();
    const region = regions.find(function(r) { return r.id === regionId; });
    if (!region) {
        console.error('startEnterRegion: unknown region', regionId);
        return;
    }
    game.mapTransition.active = true;
    game.mapTransition.dir = 'toRegion';
    game.mapTransition.t = 0;
    game.mapTransition.targetRegionId = regionId;
    game.state = 'TRANSITION';
    clearAllInput();
    console.log('Entering region:', regionId);
}

function startReturnToWorld() {
    if (game.mapTransition.active) return;
    if (game.state === 'BUILDING') return;
    game.mapTransition.active = true;
    game.mapTransition.dir = 'toWorld';
    game.mapTransition.t = 0;
    game.mapTransition.targetRegionId = null;
    game.state = 'TRANSITION';
    clearAllInput();
    console.log('Returning to world map');
}

async function completeEnterRegion(regionId) {
    console.log('completeEnterRegion START: regionId=' + regionId);
    const reqId = ++game.mapReqId;
    const regions = getWorldRegions();
    const region = regions.find(function(r) { return r.id === regionId; });
    const mapFile = region ? region.mapFile : ('data/regions/' + regionId + '.json');
    console.log('completeEnterRegion: loading mapFile=' + mapFile);
    var ok = await loadMap(mapFile, reqId);
    if (!ok) {
        console.error('completeEnterRegion: loadMap stale or failed, returning to world');
        safeReturnToOverworld();
        return;
    }
    console.log('completeEnterRegion: map loaded, WORLD_WIDTH=' + WORLD_WIDTH + ' WORLD_HEIGHT=' + WORLD_HEIGHT + ' ROAD_COUNT=' + ROAD_COUNT + ' BUILDINGS=' + BUILDINGS.length + ' TERRAIN_GRID=' + (TERRAIN_GRID ? TERRAIN_GRID.length + ' rows' : 'NULL'));
    resizeCanvas();
    var spawnPos = findSpawnOnRoad();
    game.player.x = spawnPos.x;
    game.player.y = spawnPos.y;
    game.player.pxPerSecond = 300;
    game.player.width = 128;
    game.player.height = 128;
    game.camera.initialized = false;
    game.mode = 'REGION';
    game.currentRegionId = regionId;
    game.state = 'OVERWORLD';
    if (typeof MP !== 'undefined' && MP.sendSpawnPos) {
        var spTileX = Math.round(spawnPos.x / TILE_SIZE);
        var spTileY = Math.round(spawnPos.y / TILE_SIZE);
        MP.sendSpawnPos(spTileX, spTileY);
    }
    game.controllerEntity = 'van';
    game.activeBuildingId = null;
    game.activeNodeId = null;
    updateMobileActionVisibility();
    console.log('Region loaded:', regionId, 'spawn at', spawnPos.x, spawnPos.y);
}

async function completeReturnToWorld() {
    if (!WORLD_DATA || !WORLD_DATA.world) {
        console.error('completeReturnToWorld: no world data');
        game.state = 'OVERWORLD';
        game.mapTransition.active = false;
        return;
    }
    applyWorldMapData();
    resizeCanvas();

    const prevRegion = game.currentRegionId;
    var node = null;
    for (var i = 0; i < WORLD_NODES.length; i++) {
        if (WORLD_NODES[i].regionId === prevRegion) { node = WORLD_NODES[i]; break; }
    }
    if (node) {
        game.player.x = node.x * TILE_SIZE;
        game.player.y = node.y * TILE_SIZE;
    } else {
        game.player.x = (WORLD_WIDTH >> 1) * TILE_SIZE;
        game.player.y = (WORLD_HEIGHT >> 1) * TILE_SIZE;
    }
    game.player.pxPerSecond = 400;
    game.player.width = 96;
    game.player.height = 96;
    game.camera.initialized = false;
    game.mode = 'WORLD';
    game.currentRegionId = null;
    game.state = 'OVERWORLD';
    game.controllerEntity = 'van';
    game.activeBuildingId = null;
    game.activeNodeId = null;
    updateMobileActionVisibility();
    console.log('World map loaded:', WORLD_NODES.length, 'region nodes');
}

function updateMapTransition(dt) {
    if (!game.mapTransition.active) return;
    game.mapTransition.t = Math.min(game.mapTransition.t + dt, game.mapTransition.duration);
    if (game.mapTransition.t < game.mapTransition.duration) return;

    const dir = game.mapTransition.dir;
    const regionId = game.mapTransition.targetRegionId;

    // Full reset before side-effects
    game.mapTransition.active = false;
    game.mapTransition.t = 0;
    game.mapTransition.dir = null;
    game.mapTransition.targetRegionId = null;

    if (dir === 'toRegion') {
        completeEnterRegion(regionId);
    } else {
        completeReturnToWorld();
    }
}

function updateWorldInteraction() {
    if (game.mode !== 'WORLD' || game.state !== 'OVERWORLD') return;

    const p = game.player;
    const px = p.x + p.width / 2;
    const py = p.y + p.height / 2;

    // Hysteresis: if a node is active, keep it until player leaves exit radius
    if (game.activeNodeId) {
        const active = WORLD_NODE_BY_ID[game.activeNodeId];
        if (active) {
            const ax = active.x * TILE_SIZE + (TILE_SIZE >> 1);
            const ay = active.y * TILE_SIZE + (TILE_SIZE >> 1);
            const exitR = (active.exitRadius || 5) * TILE_SIZE;
            if (Math.hypot(px - ax, py - ay) < exitR) return;
        }
        game.activeNodeId = null;
    }

    // No active node — scan for nearest within enter radius
    let nearest = null;
    let nearDist = Infinity;

    for (var i = 0; i < WORLD_NODES.length; i++) {
        var node = WORLD_NODES[i];
        const nx = node.x * TILE_SIZE + (TILE_SIZE >> 1);
        const ny = node.y * TILE_SIZE + (TILE_SIZE >> 1);
        const enterR = (node.enterRadius || 3) * TILE_SIZE;
        const dist = Math.hypot(px - nx, py - ny);
        if (dist < enterR && dist < nearDist) {
            nearest = node;
            nearDist = dist;
        }
    }

    if (nearest) {
        game.activeNodeId = nearest.id;
    }
}

function drawWorldNodes() {
    if (WORLD_NODES.length === 0) return;
    ctx.imageSmoothingEnabled = false;
    const savedFont = ctx.font;
    const savedAlign = ctx.textAlign;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';

    for (const node of WORLD_NODES) {
        const sx = node.x * TILE_SIZE - game.camera.x;
        const sy = node.y * TILE_SIZE - game.camera.y;
        if (sx < -TILE_SIZE * 2 || sx > CANVAS_WIDTH + TILE_SIZE * 2 ||
            sy < -TILE_SIZE * 2 || sy > CANVAS_HEIGHT + TILE_SIZE * 2) continue;

        const isActive = node.id === game.activeNodeId;
        const size = TILE_SIZE * 2;

        ctx.fillStyle = isActive ? '#fcfc00' : '#c0c0c0';
        ctx.fillRect(sx - (size >> 2), sy - (size >> 2), size >> 1, size >> 1);
        ctx.strokeStyle = isActive ? '#fff' : '#808080';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx - (size >> 2), sy - (size >> 2), size >> 1, size >> 1);

        ctx.fillStyle = '#000';
        ctx.fillRect(sx - 40, sy - (size >> 1) - 14, 80, 14);
        ctx.fillStyle = isActive ? '#fcfc00' : '#fff';
        ctx.fillText(node.label, sx, sy - (size >> 1) - 3);

        if (isActive) {
            const pulse = Math.sin(Date.now() / 150) * 0.4 + 0.6;
            ctx.strokeStyle = 'rgba(252, 252, 0, ' + pulse + ')';
            ctx.lineWidth = 3;
            ctx.strokeRect(sx - (size >> 2) - 3, sy - (size >> 2) - 3, (size >> 1) + 6, (size >> 1) + 6);
        }
    }

    ctx.font = savedFont;
    ctx.textAlign = savedAlign;
}

// ============================================
// LEVEL ENGINE (Phase 9.0 MVP)
// ============================================

// ============================================
// LEVEL ROUTES — defined in js/shared/level_schema.js (loaded before game.js).
// Uses the shared LEVEL_ROUTES global.

function getLevelForContext() {
    // 1. Landmark proximity check
    if (LANDMARKS.length > 0) {
        var entity = (game.controllerEntity === 'foot') ? game.turtle : game.player;
        var px = entity.x + entity.width / 2;
        var py = entity.y + entity.height / 2;
        for (var i = 0; i < LANDMARKS.length; i++) {
            var lm = LANDMARKS[i];
            var lx = lm.x * TILE_SIZE + TILE_SIZE / 2;
            var ly = lm.y * TILE_SIZE + TILE_SIZE / 2;
            if (Math.abs(px - lx) < TILE_SIZE * 1.5 && Math.abs(py - ly) < TILE_SIZE * 1.5) {
                var route = LEVEL_ROUTES.landmark[lm.id];
                if (route) return resolveRoute(route, lm.id);
            }
        }
    }
    // 2. Active building type check
    if (game.activeBuildingId) {
        var building = BUILDING_BY_ID[game.activeBuildingId];
        if (building && building.buildingType) {
            var route = LEVEL_ROUTES.buildingType[building.buildingType];
            if (route) return resolveRoute(route, game.activeBuildingId);
        }
    }
    return null;
}

function resolveRoute(route, contextId) {
    if (route.kind === 'static') {
        // Dimension X: block entry unless all 10 items collected
        if (route.levelId === 'level_technodrome') {
            var collected = Object.keys(game.progress.collectedItems).length;
            if (collected < 10) {
                game.technodromeMsg = collected + '/10 ITEMS COLLECTED';
                game.technodromeMsgTimer = 2.0;
                return null;
            }
        }
        return { type: 'static', levelId: route.levelId, contextId: contextId };
    }
    if (route.kind === 'generated') {
        var regionId = game.currentRegionId || 'na';
        var seed = regionId + ':' + contextId;
        var building = BUILDING_BY_ID[contextId];
        var artistId = building ? building.artistId : null;
        return { type: 'generated', theme: route.theme, seed: seed, contextId: contextId, artistId: artistId };
    }
    console.error('Unknown route kind:', route.kind);
    return null;
}

function applyLevelPatch(base, patch) {
    var result = JSON.parse(JSON.stringify(base));
    if (Array.isArray(patch.tileOverrides)) {
        for (var i = 0; i < patch.tileOverrides.length; i++) {
            var to = patch.tileOverrides[i];
            if (result.tilemap[to.y]) result.tilemap[to.y][to.x] = to.tile;
        }
    }
    if (Array.isArray(patch.enemyOverrides)) {
        result.enemies = patch.enemyOverrides;
    }
    if (patch.spawns) {
        if (patch.spawns.player) result.spawns.player = patch.spawns.player;
        if (patch.spawns.exit) result.spawns.exit = patch.spawns.exit;
    }
    if (patch.world) {
        for (var k in patch.world) result.world[k] = patch.world[k];
    }
    return result;
}

function verifyLevelIntegrity(levelData, levelId) {
    var errors = [];
    function fail(msg) { errors.push(msg); console.error('Level integrity [' + levelId + ']: ' + msg); }

    if (!levelData || !levelData.world) { fail('missing world def'); return errors; }
    var w = levelData.world.widthTiles;
    var h = levelData.world.heightTiles;
    var ts = levelData.world.tileSize;
    if (!w || w <= 0 || !h || h <= 0) fail('invalid dimensions: ' + w + 'x' + h);
    if (!ts || ts <= 0) fail('invalid tileSize: ' + ts);

    if (!Array.isArray(levelData.tilemap)) { fail('tilemap is not an array'); return errors; }
    if (levelData.tilemap.length !== h) fail('tilemap rows=' + levelData.tilemap.length + ' expected=' + h);
    for (var r = 0; r < levelData.tilemap.length; r++) {
        if (!Array.isArray(levelData.tilemap[r])) { fail('tilemap row ' + r + ' not array'); continue; }
        if (levelData.tilemap[r].length !== w) fail('tilemap row ' + r + ' cols=' + levelData.tilemap[r].length + ' expected=' + w);
    }

    var tileTypes = levelData.tileTypes || {};
    var knownIds = new Set(Object.keys(tileTypes));
    for (var ty = 0; ty < Math.min(h, levelData.tilemap.length); ty++) {
        for (var tx = 0; tx < Math.min(w, (levelData.tilemap[ty] || []).length); tx++) {
            var tid = String(levelData.tilemap[ty][tx]);
            if (!knownIds.has(tid)) fail('unknown tile ID ' + tid + ' at ' + tx + ',' + ty);
        }
    }

    function isWalkable(x, y) {
        if (x < 0 || x >= w || y < 0 || y >= h) return false;
        if (!levelData.tilemap[y]) return false;
        var t = levelData.tilemap[y][x];
        var tt = tileTypes[String(t)];
        return tt && !tt.solid;
    }

    if (!levelData.spawns) { fail('missing spawns'); return errors; }
    var ps = levelData.spawns.player;
    if (!ps) fail('missing player spawn');
    else {
        if (ps.x < 0 || ps.x >= w || ps.y < 0 || ps.y >= h) fail('player spawn out of bounds: ' + ps.x + ',' + ps.y);
        else if (!isWalkable(ps.x, ps.y)) fail('player spawn on solid tile: ' + ps.x + ',' + ps.y);
    }

    var ex = levelData.spawns.exit;
    if (!ex) fail('missing exit spawn');
    else {
        if (ex.x < 0 || ex.x >= w || ex.y < 0 || ex.y >= h) fail('exit out of bounds: ' + ex.x + ',' + ex.y);
        else if (!isWalkable(ex.x, ex.y)) fail('exit on solid tile: ' + ex.x + ',' + ex.y);
    }

    if (Array.isArray(levelData.enemies)) {
        for (var ei = 0; ei < levelData.enemies.length; ei++) {
            var en = levelData.enemies[ei];
            if (en.x < 0 || en.x >= w || en.y < 0 || en.y >= h) {
                fail('enemy ' + ei + ' out of bounds: ' + en.x + ',' + en.y);
            } else if (!isWalkable(en.x, en.y)) {
                fail('enemy ' + ei + ' on solid tile: ' + en.x + ',' + en.y);
            }
            if (ps && en.x === ps.x && en.y === ps.y) {
                fail('enemy ' + ei + ' overlaps player spawn');
            }
        }
    }

    if (errors.length === 0) console.log('Integrity: level=' + levelId + ' ok');
    return errors;
}

// ── Runtime level generator (browser-side, seeded) ──────────────

var LEVEL_THEMES = {
    sewer:   { name: 'Sewer',        obs: 0.08, corW: 3, rmMin: 4, rmMax: 8 },
    street:  { name: 'Street Fight', obs: 0.04, corW: 5, rmMin: 6, rmMax: 12 },
    dock:    { name: 'Dock',         obs: 0.10, corW: 3, rmMin: 5, rmMax: 9 },
    gallery: { name: 'Gallery',      obs: 0.03, corW: 5, rmMin: 6, rmMax: 10 }
};
var LEVEL_SIZES = { S: { w: 24, h: 12 }, M: { w: 36, h: 15 }, L: { w: 48, h: 18 } };
var BUDGET_BASE = 30;
var BUDGET_DIFF_MOD = { 1: 0, 2: 10, 3: 20, 4: 30, 5: 40 };
var BUDGET_SIZE_MOD = { S: 0, M: 15, L: 30 };
var ENEMY_COST_RT = { foot: 10, foot_ranged: 15, foot_shield: 18, foot_runner: 8 };
var DIFF_HP_RT = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3 };
var RANGED_MIN_DIFF_RT = 3;
var SHIELD_MIN_DIFF_RT = 3;
var RUNNER_MIN_DIFF_RT = 2;

// Hazard tiles: tile type 2 = hazard; effect from theme
var THEME_HAZARD = {
    sewer:   { name: 'sludge',  color: '#3a6030', slowMult: 0.4 },
    street:  { name: 'cone',    color: '#ff8800', kbForce: 80 },
    dock:    { name: 'oil',     color: '#2a2a1a', slipMult: 1.8 },
    gallery: { name: 'paint',   color: '#6644aa', slowMult: 0.6 }
};

function seedHashRT(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return h >>> 0;
}
function mulberry32RT(seed) {
    var s = seed | 0;
    return function() { s = (s + 0x6D2B79F5) | 0; var t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function generateLevelRT(theme, size, seed, difficulty) {
    var T = LEVEL_THEMES[theme] || LEVEL_THEMES.street;
    var S = LEVEL_SIZES[size] || LEVEL_SIZES.M;
    var diff = Math.max(1, Math.min(5, difficulty || 2));
    var budget = BUDGET_BASE + (BUDGET_DIFF_MOD[diff] || 0) + (BUDGET_SIZE_MOD[size] || 0);
    // Gallery levels have lower enemy budget (easier)
    if (theme === 'gallery') budget = Math.floor(budget * 0.6);
    var enemyHp = DIFF_HP_RT[diff] || 1;
    var rng = mulberry32RT(seedHashRT(seed));
    var W = S.w, H = S.h;

    var map = [];
    for (var y = 0; y < H; y++) map[y] = new Array(W).fill(1);

    var rooms = [], numRooms = 3 + Math.floor(rng() * 3);
    for (var att = 0; att < numRooms * 10 && rooms.length < numRooms; att++) {
        var rw = T.rmMin + Math.floor(rng() * (T.rmMax - T.rmMin));
        var rh = T.rmMin + Math.floor(rng() * (T.rmMax - T.rmMin));
        var rx = 2 + Math.floor(rng() * (W - rw - 4));
        var ry = 2 + Math.floor(rng() * (H - rh - 4));
        var ov = false;
        for (var ri = 0; ri < rooms.length; ri++) {
            var r = rooms[ri];
            if (rx - 1 < r.x + r.w && rx + rw + 1 > r.x && ry - 1 < r.y + r.h && ry + rh + 1 > r.y) { ov = true; break; }
        }
        if (ov) continue;
        rooms.push({ x: rx, y: ry, w: rw, h: rh });
        for (var dy = 0; dy < rh; dy++) for (var dx = 0; dx < rw; dx++) map[ry + dy][rx + dx] = 0;
    }
    if (rooms.length < 2) {
        rooms.push({ x: 2, y: Math.floor(H / 2) - 2, w: W - 4, h: 4 });
        for (var dy2 = 0; dy2 < 4; dy2++) for (var dx2 = 2; dx2 < W - 2; dx2++) map[Math.floor(H / 2) - 2 + dy2][dx2] = 0;
    }
    rooms.sort(function(a, b) { return a.x - b.x; });

    for (var ci = 0; ci < rooms.length - 1; ci++) {
        var r1 = rooms[ci], r2 = rooms[ci + 1];
        var cx1 = Math.floor(r1.x + r1.w / 2), cy1 = Math.floor(r1.y + r1.h / 2);
        var cx2 = Math.floor(r2.x + r2.w / 2), cy2 = Math.floor(r2.y + r2.h / 2);
        var hw = Math.floor(T.corW / 2);
        for (var xx = Math.min(cx1, cx2); xx <= Math.max(cx1, cx2); xx++) for (var ddy = -hw; ddy <= hw; ddy++) { var yy = cy1 + ddy; if (yy >= 1 && yy < H - 1 && xx >= 1 && xx < W - 1) map[yy][xx] = 0; }
        for (var yy2 = Math.min(cy1, cy2); yy2 <= Math.max(cy1, cy2); yy2++) for (var ddx = -hw; ddx <= hw; ddx++) { var xx2 = cx2 + ddx; if (yy2 >= 1 && yy2 < H - 1 && xx2 >= 1 && xx2 < W - 1) map[yy2][xx2] = 0; }
    }

    var fr = rooms[0], lr = rooms[rooms.length - 1];
    var spawn = { x: fr.x + 1 + Math.floor(rng() * Math.max(1, fr.w - 2)), y: fr.y + 1 + Math.floor(rng() * Math.max(1, fr.h - 2)) };
    var exit  = { x: lr.x + 1 + Math.floor(rng() * Math.max(1, lr.w - 2)), y: lr.y + 1 + Math.floor(rng() * Math.max(1, lr.h - 2)) };
    map[spawn.y][spawn.x] = 0; map[exit.y][exit.x] = 0;

    var obs = [];
    for (var oy = 2; oy < H - 2; oy++) for (var ox = 2; ox < W - 2; ox++) {
        if (map[oy][ox] !== 0) continue;
        if (ox === spawn.x && oy === spawn.y) continue;
        if (ox === exit.x && oy === exit.y) continue;
        if (rng() < T.obs) { obs.push({ x: ox, y: oy }); map[oy][ox] = 1; }
    }

    function flood() {
        var vis = new Set(); var q = [spawn.y * W + spawn.x]; vis.add(q[0]);
        while (q.length > 0) { var k = q.shift(); var kx = k % W, ky = (k / W) | 0; for (var di = 0; di < 4; di++) { var nx = kx + [1,-1,0,0][di], ny = ky + [0,0,1,-1][di]; if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue; var nk = ny * W + nx; if (!vis.has(nk) && map[ny][nx] === 0) { vis.add(nk); q.push(nk); } } }
        return vis;
    }
    var vis = flood(), eKey = exit.y * W + exit.x;
    if (!vis.has(eKey)) { for (var oi = obs.length - 1; oi >= 0; oi--) { map[obs[oi].y][obs[oi].x] = 0; vis = flood(); if (vis.has(eKey)) break; } }

    // Ensure min 2-tile corridor width on shortest path (M/L)
    if (size === 'M' || size === 'L') {
        var prev = new Map(); var bq = [spawn.y * W + spawn.x]; prev.set(bq[0], -1);
        while (bq.length > 0) { var bk = bq.shift(); if (bk === eKey) break; var bkx = bk % W, bky = (bk / W) | 0; for (var bd = 0; bd < 4; bd++) { var bnx = bkx + [1,-1,0,0][bd], bny = bky + [0,0,1,-1][bd]; if (bnx < 1 || bnx >= W-1 || bny < 1 || bny >= H-1) continue; var bnk = bny * W + bnx; if (prev.has(bnk)) continue; if (map[bny][bnx] !== 0) continue; prev.set(bnk, bk); bq.push(bnk); } }
        if (prev.has(eKey)) {
            var pc = eKey;
            while (pc !== -1) { var pcx = pc % W, pcy = (pc / W) | 0; for (var pd = 0; pd < 4; pd++) { var pnx = pcx + [1,-1,0,0][pd], pny = pcy + [0,0,1,-1][pd]; if (pnx >= 1 && pnx < W-1 && pny >= 1 && pny < H-1 && map[pny][pnx] === 1) map[pny][pnx] = 0; } pc = prev.get(pc); }
        }
        vis = flood();
    }

    var walkable = [];
    for (var k of vis) { var kx = k % W, ky = (k / W) | 0; if (kx === spawn.x && ky === spawn.y) continue; if (kx === exit.x && ky === exit.y) continue; if (Math.abs(kx - spawn.x) + Math.abs(ky - spawn.y) < 4) continue; walkable.push({ x: kx, y: ky }); }
    for (var wi = walkable.length - 1; wi > 0; wi--) { var wj = Math.floor(rng() * (wi + 1)); var tmp = walkable[wi]; walkable[wi] = walkable[wj]; walkable[wj] = tmp; }

    // ── Place hazard tiles (tile type 2) ───────────────────────
    var hazardCount = Math.floor(walkable.length * 0.06);
    var hazardStart = walkable.length - hazardCount;
    for (var hi = hazardStart; hi < walkable.length; hi++) {
        var hp = walkable[hi];
        if (Math.abs(hp.x - spawn.x) + Math.abs(hp.y - spawn.y) < 5) continue;
        if (Math.abs(hp.x - exit.x) + Math.abs(hp.y - exit.y) < 3) continue;
        map[hp.y][hp.x] = 2;
    }

    var enemies = [], spent = 0;
    for (var ei = 0; ei < hazardStart && spent + ENEMY_COST_RT.foot_runner <= budget; ei++) {
        var pos = walkable[ei]; var pL = pos.x, pR = pos.x;
        while (pL > 1 && map[pos.y][pL - 1] !== 1) pL--;
        while (pR < W - 2 && map[pos.y][pR + 1] !== 1) pR++;
        pL = Math.max(pL, pos.x - 6); pR = Math.min(pR, pos.x + 6);
        // Pick enemy type based on difficulty + rng
        var roll = rng();
        var eType = 'foot';
        if (diff >= SHIELD_MIN_DIFF_RT && roll < 0.15 && spent + ENEMY_COST_RT.foot_shield <= budget) {
            eType = 'foot_shield';
        } else if (diff >= RANGED_MIN_DIFF_RT && roll < 0.4 && spent + ENEMY_COST_RT.foot_ranged <= budget) {
            eType = 'foot_ranged';
        } else if (diff >= RUNNER_MIN_DIFF_RT && roll < 0.55 && spent + ENEMY_COST_RT.foot_runner <= budget) {
            eType = 'foot_runner';
        }
        var eHp = enemyHp;
        if (eType === 'foot_shield') eHp = enemyHp + 1;
        if (eType === 'foot_runner') eHp = Math.max(1, enemyHp - 1);
        enemies.push({ type: eType, x: pos.x, y: pos.y, hp: eHp, patrol: { left: pL, right: pR } });
        spent += ENEMY_COST_RT[eType];
    }

    // Art frame positions for gallery theme: tiles adjacent to walls on the floor side
    var artFrames = [];
    if (theme === 'gallery') {
        for (var fy = 1; fy < H - 1; fy++) {
            for (var fx = 1; fx < W - 1; fx++) {
                if (map[fy][fx] !== 0) continue;
                // Check if adjacent to a wall (north side = art frame on wall)
                if (map[fy - 1] && map[fy - 1][fx] === 1 && rng() < 0.35) {
                    artFrames.push({ x: fx, y: fy, side: 'north' });
                }
            }
        }
    }

    // Special item spawn point (single walkable tile far from spawn)
    var itemSpawn = null;
    if (walkable.length > 6) {
        var mid = Math.floor(walkable.length * 0.6 + rng() * walkable.length * 0.3);
        if (mid >= walkable.length) mid = walkable.length - 1;
        itemSpawn = { x: walkable[mid].x, y: walkable[mid].y };
    }

    return {
        id: theme + '_gen_' + seedHashRT(seed),
        name: T.name,
        theme: theme, seed: seed,
        world: { widthTiles: W, heightTiles: H, tileSize: 32 },
        tilemap: map,
        tileTypes: { '0': { name: 'air', solid: false }, '1': { name: 'wall', solid: true }, '2': { name: 'hazard', solid: false } },
        spawns: { player: spawn, exit: exit },
        enemies: enemies,
        triggers: [{ type: 'door', x: exit.x, y: exit.y, target: 'REGION' }],
        artFrames: artFrames,
        itemSpawn: itemSpawn
    };
}

// ── Difficulty from district ────────────────────────────────────
function getDifficultyForEntrance() {
    var dist = getPlayerDistrict ? getPlayerDistrict() : null;
    if (!dist) return 2;
    if (dist === 'west_coast') return 1;
    if (dist === 'mountain') return 2;
    if (dist === 'midwest') return 3;
    if (dist === 'south') return 3;
    if (dist === 'northeast') return 4;
    return 2;
}

async function startEnterLevelFromContext(ctx) {
    if (ctx.type === 'static') {
        await startEnterLevel(ctx.levelId);
    } else if (ctx.type === 'generated') {
        var diff = getDifficultyForEntrance();
        // Gallery levels are easier
        if (ctx.theme === 'gallery') diff = Math.max(1, diff - 1);
        var sizeKey = diff <= 2 ? 'S' : (diff <= 3 ? 'M' : 'L');
        console.log('Generating level: theme=' + ctx.theme + ' seed=' + ctx.seed + ' diff=' + diff + ' size=' + sizeKey);
        var levelData = generateLevelRT(ctx.theme, sizeKey, ctx.seed, diff);
        // Attach artist context for gallery levels
        if (ctx.artistId) {
            levelData.artistId = ctx.artistId;
            var artist = ARTISTS[ctx.artistId];
            if (artist) {
                levelData.artistName = artist.name;
                levelData.name = 'Gallery of ' + artist.name;
            }
        }
        levelData.contextId = ctx.contextId;
        await startEnterLevelWithData(levelData);
    }
}

async function startEnterLevel(levelId) {
    console.log('Entering level: ' + levelId);
    game.levelReturnTile = {
        x: Math.floor(game.player.x / TILE_SIZE),
        y: Math.floor(game.player.y / TILE_SIZE)
    };

    var levelData;
    try {
        levelData = await fetchJSON('data/levels/' + levelId + '.json');
    } catch (e) {
        console.error('Failed to load level: ' + levelId, e);
        return;
    }

    // Try patch overlay
    try {
        var patchData = await fetchJSON('data/levels/' + levelId + '.patch.json');
        if (patchData) {
            levelData = applyLevelPatch(levelData, patchData);
            console.log('Level patch applied: ' + levelId);
        }
    } catch (_) { /* no patch, fine */ }

    await startEnterLevelWithData(levelData);
}

async function startEnterLevelWithData(levelData) {
    if (!game.levelReturnTile) {
        game.levelReturnTile = {
            x: Math.floor(game.player.x / TILE_SIZE),
            y: Math.floor(game.player.y / TILE_SIZE)
        };
    }

    var levelId = levelData.id || 'unknown';

    // Integrity gate
    var integrityErrors = verifyLevelIntegrity(levelData, levelId);
    if (integrityErrors.length > 0) {
        console.error('Level ' + levelId + ' failed integrity (' + integrityErrors.length + ' errors), aborting entry');
        return;
    }

    var lw = levelData.world.widthTiles;
    var lh = levelData.world.heightTiles;
    var lts = levelData.world.tileSize;

    var totalEnemies = levelData.enemies.length;

    // Determine special item for this level
    var specialItem = null;
    if (levelData.itemSpawn) {
        specialItem = getSpecialItemForLevel(levelData.theme, levelData.seed);
    }

    game.level = {
        id: levelId,
        data: levelData,
        seed: levelData.seed || null,
        tileSize: lts,
        width: lw,
        height: lh,
        tilemap: levelData.tilemap,
        tileTypes: levelData.tileTypes,
        player: {
            x: levelData.spawns.player.x * lts,
            y: levelData.spawns.player.y * lts,
            w: lts * 0.75,
            h: lts * 0.75,
            vx: 0, vy: 0,
            hp: game.poiHealReady ? 5 : 3,
            maxHp: game.poiHealReady ? 5 : 3,
            direction: 'right',
            atkPhase: 'IDLE',
            atkTimer: 0,
            atkCooldown: 0,
            atkHitIds: new Set(),
            invTimer: 0,
            kbVx: 0, kbVy: 0,
            kbTimer: 0,
            damageTaken: 0,
            animTimer: 0,
            animFrame: 0,
            moving: false,
            turtleId: game.activeTurtle || 'leo'
        },
        enemies: levelData.enemies.map(function(e, idx) {
            var isRanged = e.type === 'foot_ranged';
            var isShield = e.type === 'foot_shield';
            var isRunner = e.type === 'foot_runner';
            var isBoss = e.type === 'boss_technodrome';
            return {
                id: 'enemy_' + idx,
                type: e.type,
                ranged: isRanged,
                shield: isShield,
                runner: isRunner,
                boss: isBoss,
                x: e.x * lts,
                y: e.y * lts,
                w: isBoss ? lts * 3 : lts * (isRunner ? 0.6 : 0.7),
                h: isBoss ? lts * 3 : lts * (isRunner ? 0.6 : 0.7),
                hp: e.hp || 2,
                maxHp: e.hp || 2,
                alive: true,
                patrolLeft: e.patrol ? e.patrol.left * lts : e.x * lts - lts * 3,
                patrolRight: e.patrol ? e.patrol.right * lts : e.x * lts + lts * 3,
                patrolCx: e.patrol ? (e.patrol.left + e.patrol.right) * lts / 2 : e.x * lts,
                patrolCy: e.y * lts,
                facingDir: 1,
                animTimer: 0,
                state: isBoss ? 'BOSS_PHASE1' : 'PATROL',
                stateTimer: 0,
                stunTimer: 0,
                kbVx: 0, kbVy: 0,
                kbTimer: 0,
                chaseRadius: isRanged ? lts * 7 : isRunner ? lts * 8 : isBoss ? lts * 20 : lts * 5,
                attackRadius: isRanged ? lts * 4.5 : isShield ? lts * 1.0 : isBoss ? lts * 6 : lts * 1.2,
                attackCooldown: 0,
                shieldUp: isShield,
                bossPhase: isBoss ? 1 : 0,
                bossSpawnTimer: isBoss ? 3.0 : 0,
                bossFireTimer: isBoss ? 1.5 : 0,
                weakPointVisible: false,
                weakPointTimer: 0
            };
        }),
        projectiles: [],
        exit: {
            x: levelData.spawns.exit.x * lts,
            y: levelData.spawns.exit.y * lts,
            w: lts, h: lts
        },
        camera: { x: 0, y: 0 },
        fadeIn: 1.0,
        complete: false,
        failed: false,
        screenShake: 0,
        hitSparks: [],
        // Scoring
        score: 0,
        killCount: 0,
        totalEnemies: totalEnemies,
        comboCount: 0,
        comboTimer: 0,
        pointPopups: [],
        startTime: Date.now(),
        // Gallery-specific
        artistId: levelData.artistId || null,
        artistName: levelData.artistName || null,
        artFrames: levelData.artFrames || [],
        gallerySplash: (levelData.theme === 'gallery' && levelData.artistName) ? 2.0 : 0,
        // Special item
        specialItem: specialItem,
        specialItemCollected: false,
        specialItemPos: specialItem && levelData.itemSpawn ? {
            x: levelData.itemSpawn.x * lts,
            y: levelData.itemSpawn.y * lts,
            w: lts * 0.8, h: lts * 0.8
        } : null,
        // Results screen
        showResults: false,
        resultsTimer: 0,
        // Boss tracking
        isBossLevel: levelData.isBossLevel || false,
        bossDefeated: false,
        victoryTimer: 0
    };

    game.mode = 'LEVEL';
    game.levelState = 'PLAYING';
    game.state = 'OVERWORLD';
    game.poiHealReady = false;

    // Track gallery visit for first-time bonus
    if (levelData.theme === 'gallery' && levelData.artistId) {
        if (!game.progress.galleriesVisited[levelData.artistId]) {
            game.progress.galleriesVisited[levelData.artistId] = true;
            addLevelScore(300, 'FIRST VISIT');
        }
    }
}

// ============================================
// SCORING SYSTEM (Phase 2)
// ============================================

var SCORE_KILL = { foot: 100, foot_ranged: 150, foot_shield: 200, foot_runner: 120, boss_technodrome: 10000 };
var SCORE_LEVEL_CLEAR = 500;
var SCORE_SPECIAL_ITEM = 1000;
var SCORE_SPEED_BONUS_PER_SEC = 50;
var SCORE_COMBO_BONUS = 50;
var COMBO_WINDOW = 3.0;
var PAR_TIME_PER_ENEMY = 8;

function addLevelScore(points, label) {
    var L = game.level;
    if (!L) return;
    L.score += points;
    if (label) {
        var p = L.player;
        L.pointPopups.push({
            text: '+' + points + (label ? ' ' + label : ''),
            x: p.x + p.w / 2,
            y: p.y - 10,
            life: 1.2,
            color: '#ffff00'
        });
    }
}

function addKillScore(enemyType, x, y) {
    var L = game.level;
    if (!L) return;
    var pts = SCORE_KILL[enemyType] || 100;
    L.killCount++;

    // Combo system
    if (L.comboTimer > 0) {
        L.comboCount++;
        var comboBonus = SCORE_COMBO_BONUS * L.comboCount;
        pts += comboBonus;
    } else {
        L.comboCount = 1;
    }
    L.comboTimer = COMBO_WINDOW;

    L.score += pts;
    L.pointPopups.push({
        text: '+' + pts + (L.comboCount > 1 ? ' x' + L.comboCount : ''),
        x: x, y: y - 10,
        life: 1.2,
        color: L.comboCount > 3 ? '#ff4444' : L.comboCount > 1 ? '#ffaa00' : '#ffff00'
    });
}

function finalizeLevelScore() {
    var L = game.level;
    if (!L) return;

    // Level clear bonus
    L.score += SCORE_LEVEL_CLEAR;

    // Speed bonus
    var elapsed = (Date.now() - L.startTime) / 1000;
    var parTime = L.totalEnemies * PAR_TIME_PER_ENEMY;
    L.speedBonus = 0;
    if (elapsed < parTime) {
        L.speedBonus = Math.floor((parTime - elapsed) * SCORE_SPEED_BONUS_PER_SEC);
        L.score += L.speedBonus;
    }

    // No-damage bonus
    L.noDamageBonus = false;
    if (L.player.damageTaken === 0 && L.totalEnemies > 0) {
        L.noDamageBonus = true;
        L.score *= 2;
    }

    L.elapsedTime = elapsed;

    // Add to persistent score
    game.progress.score += L.score;
    if (game.progress.score > game.progress.bestScore) {
        game.progress.bestScore = game.progress.score;
    }
}

function recordHighScore() {
    var entry = {
        score: game.progress.score,
        date: new Date().toISOString().slice(0, 10),
        galleriesVisited: Object.keys(game.progress.galleriesVisited).length,
        levelsCleared: Object.keys(game.progress.levelWins).length,
        itemsCollected: Object.keys(game.progress.collectedItems).length
    };
    var hist = game.progress.scoreHistory;
    hist.push(entry);
    hist.sort(function(a, b) { return b.score - a.score; });
    if (hist.length > 10) hist.length = 10;
}

// ============================================
// SPECIAL ITEMS SYSTEM (Phase 4)
// ============================================

var SPECIAL_ITEMS = [
    { id: 'mutagen_canister', name: 'Mutagen Canister',     color: '#00ff88', shape: 'canister',  themes: ['sewer'] },
    { id: 'pizza_box',        name: 'Pizza Box',            color: '#ff8800', shape: 'box',       themes: ['gallery'] },
    { id: 'helmet_shard',     name: "Shredder's Helmet",    color: '#cc44cc', shape: 'shard',     themes: ['street'] },
    { id: 'shell_fragment',   name: 'Turtle Shell Fragment', color: '#44aa44', shape: 'fragment',  themes: ['dock'] },
    { id: 'power_cell',       name: "Krang's Power Cell",   color: '#ff44ff', shape: 'cell',      themes: ['sewer'] },
    { id: 'microphone',       name: "April's Microphone",   color: '#ffdd44', shape: 'mic',       themes: ['gallery'] },
    { id: 'staff_piece',      name: "Splinter's Staff",     color: '#aa8844', shape: 'staff',     themes: ['street'] },
    { id: 'foot_scroll',      name: 'Foot Clan Scroll',     color: '#ff2222', shape: 'scroll',    themes: ['dock'] },
    { id: 'dimension_crystal', name: 'Dimension X Crystal', color: '#8844ff', shape: 'crystal',   themes: ['sewer', 'street', 'dock', 'gallery'] },
    { id: 'technodrome_key',  name: 'Technodrome Key',      color: '#ffffff', shape: 'key',       themes: ['sewer', 'street', 'dock', 'gallery'] }
];

function getSpecialItemForLevel(theme, seed) {
    if (!seed) return null;
    var collected = game.progress.collectedItems;
    var collectedCount = Object.keys(collected).length;

    // Find uncollected items eligible for this theme
    var eligible = [];
    for (var i = 0; i < SPECIAL_ITEMS.length; i++) {
        var item = SPECIAL_ITEMS[i];
        if (collected[item.id]) continue;
        if (item.id === 'technodrome_key' && collectedCount < 7) continue;
        if (item.themes.indexOf(theme) === -1) continue;
        eligible.push(item);
    }
    if (eligible.length === 0) return null;

    // Deterministic spawn chance based on seed (~20%)
    var rng = mulberry32RT(seedHashRT(seed + '_item'));
    if (rng() > 0.20) return null;

    // Pick one from eligible
    var pick = Math.floor(rng() * eligible.length);
    return eligible[pick];
}

function collectSpecialItem() {
    var L = game.level;
    if (!L || !L.specialItem || L.specialItemCollected) return;
    L.specialItemCollected = true;
    game.progress.collectedItems[L.specialItem.id] = true;
    addLevelScore(SCORE_SPECIAL_ITEM, L.specialItem.name.toUpperCase());
    L.screenShake = 5;

    // Check if all 10 collected
    var count = Object.keys(game.progress.collectedItems).length;
    if (count >= 10) {
        game.technodromeMsg = 'THE TECHNODROME AWAITS...';
        game.technodromeMsgTimer = 4.0;
    }
    saveGame();
}

// ============================================
// LEVEL EXIT + RESULTS
// ============================================

function exitLevel() {
    game.mode = 'REGION';
    game.levelState = null;
    if (game.levelReturnTile) {
        var offX = 0, offY = TILE_SIZE;
        if (game.player.direction === 'up') { offX = 0; offY = TILE_SIZE; }
        else if (game.player.direction === 'down') { offX = 0; offY = -TILE_SIZE; }
        else if (game.player.direction === 'left') { offX = TILE_SIZE; offY = 0; }
        else if (game.player.direction === 'right') { offX = -TILE_SIZE; offY = 0; }
        var retX = game.levelReturnTile.x * TILE_SIZE + offX;
        var retY = game.levelReturnTile.y * TILE_SIZE + offY;
        if (game.controllerEntity === 'foot') {
            // On foot: move turtle to level exit, van stays parked
            game.turtle.x = retX;
            game.turtle.y = retY;
        } else {
            game.player.x = retX;
            game.player.y = retY;
        }
    }
    game.level = null;
    game.levelReentryGrace = 0.6;
    console.log('Exited level, back to region.');
}

function showGalleryCompleteOverlay(artistId) {
    var artist = ARTISTS[artistId];
    if (!artist) return;
    var overlay = document.getElementById('buildingOverlay');
    var nameEl = document.getElementById('overlayArtistName');
    var bioEl = document.getElementById('overlayArtistBio');
    var igLink = document.getElementById('overlayIgLink');
    if (!overlay || !nameEl) return;
    nameEl.textContent = artist.name;
    if (bioEl) bioEl.textContent = artist.bio || 'Gallery artist';
    if (igLink && artist.instagram) {
        igLink.href = artist.instagram;
        igLink.style.display = 'inline-block';
    } else if (igLink) {
        igLink.style.display = 'none';
    }
    overlay.classList.remove('hidden');
    // Auto-close after 5s
    setTimeout(function() { overlay.classList.add('hidden'); }, 5000);
}

// Attack phase timings (seconds)
var ATK_WINDUP   = 0.10;
var ATK_ACTIVE   = 0.12;
var ATK_RECOVERY = 0.15;
var ATK_COOLDOWN = 0.30;

// Knockback constants (pixels)
var KB_ENEMY_DIST  = 8;
var KB_PLAYER_DIST = 12;
var KB_DURATION    = 0.15;

// Enemy FSM constants
var ENEMY_CHASE_SPEED_MULT = 1.6;
var ENEMY_PATROL_SPEED_MULT = 1.0;
var ENEMY_ATTACK_WINDUP = 0.25;
var ENEMY_ATTACK_RECOVER = 0.40;
var ENEMY_STUN_DURATION = 0.25;

// Level theme sprite keys (optional — fallback to procedural draw)
var LEVEL_SPRITE_KEYS = {
    sewer:   { floor: 'lvlFloorSewer',  wall: 'lvlWallSewer' },
    street:  { floor: 'lvlFloorStreet', wall: 'lvlWallStreet' },
    dock:    { floor: 'lvlFloorDock',   wall: 'lvlWallDock' },
    gallery: { floor: 'lvlFloorGallery', wall: 'lvlWallGallery' }
};

// Projectile constants
var PROJ_SPEED = 4.0;     // tiles/sec
var PROJ_KB = 6;          // knockback pixels
var PROJ_RADIUS = 3;      // draw radius

function updateLevel(dt) {
    var L = game.level;
    if (!L) return;

    // Results screen: wait for key press
    if (L.showResults) {
        L.resultsTimer += dt;
        return;
    }

    // Victory sequence for boss level
    if (L.bossDefeated) {
        L.victoryTimer += dt;
        if (L.victoryTimer > 5.0) {
            exitLevel();
        }
        return;
    }

    if (L.complete || L.failed) return;

    var lts = L.tileSize;
    var p = L.player;
    var baseSpeed = lts * 5;

    // Fade in
    if (L.fadeIn > 0) {
        L.fadeIn -= dt * 2;
        if (L.fadeIn < 0) L.fadeIn = 0;
    }

    // Gallery splash timer
    if (L.gallerySplash > 0) L.gallerySplash -= dt;

    // Combo timer decay
    if (L.comboTimer > 0) {
        L.comboTimer -= dt;
        if (L.comboTimer <= 0) L.comboCount = 0;
    }

    // Point popup decay
    for (var ppi = L.pointPopups.length - 1; ppi >= 0; ppi--) {
        L.pointPopups[ppi].life -= dt;
        L.pointPopups[ppi].y -= 30 * dt;
        if (L.pointPopups[ppi].life <= 0) L.pointPopups.splice(ppi, 1);
    }

    // Technodrome message timer
    if (game.technodromeMsgTimer > 0) {
        game.technodromeMsgTimer -= dt;
        if (game.technodromeMsgTimer <= 0) game.technodromeMsg = null;
    }

    // Special item collision
    if (L.specialItemPos && !L.specialItemCollected) {
        if (levelRectsOverlap(p.x, p.y, p.w, p.h, L.specialItemPos.x, L.specialItemPos.y, L.specialItemPos.w, L.specialItemPos.h)) {
            collectSpecialItem();
        }
    }

    // ── Player attack state machine ─────────────────────────────
    if (p.atkCooldown > 0) p.atkCooldown -= dt;
    if (p.invTimer > 0) p.invTimer -= dt;

    if (p.atkPhase !== 'IDLE') {
        p.atkTimer -= dt;
        if (p.atkTimer <= 0) {
            if (p.atkPhase === 'WINDUP') {
                p.atkPhase = 'ACTIVE';
                p.atkTimer = ATK_ACTIVE;
                p.atkHitIds = new Set();
            } else if (p.atkPhase === 'ACTIVE') {
                p.atkPhase = 'RECOVERY';
                p.atkTimer = ATK_RECOVERY;
            } else if (p.atkPhase === 'RECOVERY') {
                p.atkPhase = 'IDLE';
                p.atkCooldown = ATK_COOLDOWN;
            }
        }
    }

    // ── Screen shake decay ─────────────────────────────────────
    if (L.screenShake > 0) L.screenShake -= dt * 20;

    // ── Hit spark decay ──────────────────────────────────────────
    for (var si = L.hitSparks.length - 1; si >= 0; si--) {
        L.hitSparks[si].life -= dt;
        if (L.hitSparks[si].life <= 0) L.hitSparks.splice(si, 1);
    }

    // ── Player knockback (with wall-pin cancel) ──────────────────
    if (p.kbTimer > 0) {
        p.kbTimer -= dt;
        var kbPx = p.kbVx * dt;
        var kbPy = p.kbVy * dt;
        var movedX = false, movedY = false;
        if (!levelTileCollision(L, p.x + kbPx, p.y, p.w, p.h)) { p.x += kbPx; movedX = true; }
        if (!levelTileCollision(L, p.x, p.y + kbPy, p.w, p.h)) { p.y += kbPy; movedY = true; }
        if (!movedX && !movedY) {
            if (!p._kbWallCount) p._kbWallCount = 0;
            p._kbWallCount++;
            if (p._kbWallCount >= 2) { p.kbTimer = 0; p._kbWallCount = 0; }
        } else { p._kbWallCount = 0; }
    }

    // ── Hazard tile check (player center tile) ────────────────
    var pCenterTx = Math.floor((p.x + p.w / 2) / lts);
    var pCenterTy = Math.floor((p.y + p.h / 2) / lts);
    var onHazard = false;
    var hazardInfo = null;
    if (pCenterTx >= 0 && pCenterTx < L.width && pCenterTy >= 0 && pCenterTy < L.height) {
        if (L.tilemap[pCenterTy][pCenterTx] === 2) {
            onHazard = true;
            hazardInfo = THEME_HAZARD[L.data.theme] || null;
        }
    }

    // ── Player movement ─────────────────────────────────────────
    var moveSpeed = baseSpeed;
    if (p.atkPhase === 'RECOVERY') moveSpeed *= 0.3;
    if (p.atkPhase === 'WINDUP' || p.atkPhase === 'ACTIVE') moveSpeed *= 0.5;
    if (p.kbTimer > 0) moveSpeed = 0;

    // Hazard: sludge slows, oil makes slippery
    if (onHazard && hazardInfo) {
        if (hazardInfo.slowMult) moveSpeed *= hazardInfo.slowMult;
        if (hazardInfo.slipMult) moveSpeed *= hazardInfo.slipMult;
    }

    var dx = 0, dy = 0;
    if (inputState.left) dx -= 1;
    if (inputState.right) dx += 1;
    if (inputState.up) dy -= 1;
    if (inputState.down) dy += 1;
    var len = Math.hypot(dx, dy);
    if (len > 0) {
        dx /= len; dy /= len;
        if (p.atkPhase === 'IDLE') {
            if (Math.abs(dx) >= Math.abs(dy)) {
                p.direction = dx < 0 ? 'left' : 'right';
            } else {
                p.direction = dy < 0 ? 'up' : 'down';
            }
        }
        p.moving = true;
    } else {
        p.moving = false;
    }

    // Animation timer for walk cycle
    if (p.moving) {
        p.animTimer += dt;
        if (p.animTimer >= 0.15) {
            p.animTimer -= 0.15;
            p.animFrame = (p.animFrame + 1) % 2;
        }
    } else {
        p.animTimer = 0;
        p.animFrame = 0;
    }

    var nx = p.x + dx * moveSpeed * dt;
    var ny = p.y + dy * moveSpeed * dt;
    if (!levelTileCollision(L, nx, p.y, p.w, p.h)) p.x = nx;
    if (!levelTileCollision(L, p.x, ny, p.w, p.h)) p.y = ny;

    // Hazard: cone knockback on entry
    if (onHazard && hazardInfo && hazardInfo.kbForce && p.invTimer <= 0) {
        var coneDir = Math.atan2(dy, dx);
        if (len < 0.1) coneDir = 0;
        p.kbVx = Math.cos(coneDir + Math.PI) * hazardInfo.kbForce;
        p.kbVy = Math.sin(coneDir + Math.PI) * hazardInfo.kbForce;
        p.kbTimer = 0.15;
        p.invTimer = 0.3;
    }

    // ── Enemy FSM loop ──────────────────────────────────────────
    var pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;

    for (var i = 0; i < L.enemies.length; i++) {
        var e = L.enemies[i];
        if (!e.alive) continue;
        e.animTimer += dt;
        e.stateTimer += dt;
        if (e.attackCooldown > 0) e.attackCooldown -= dt;

        var ecx = e.x + e.w / 2, ecy = e.y + e.h / 2;
        var distToPlayer = Math.hypot(pcx - ecx, pcy - ecy);

        // Knockback (with wall-pin cancel)
        if (e.kbTimer > 0) {
            e.kbTimer -= dt;
            var ekx = e.kbVx * dt;
            var eky = e.kbVy * dt;
            var eMx = false, eMy = false;
            if (!levelTileCollision(L, e.x + ekx, e.y, e.w, e.h)) { e.x += ekx; eMx = true; }
            if (!levelTileCollision(L, e.x, e.y + eky, e.w, e.h)) { e.y += eky; eMy = true; }
            if (!eMx && !eMy) {
                if (!e._kbWallCount) e._kbWallCount = 0;
                e._kbWallCount++;
                if (e._kbWallCount >= 2) { e.kbTimer = 0; e._kbWallCount = 0; }
            } else { e._kbWallCount = 0; }
        }

        // Stun overrides all states
        if (e.stunTimer > 0) {
            e.stunTimer -= dt;
            continue;
        }

        // ── Boss AI (3 phases) ──────────────────────────────────
        if (e.boss) {
            var hpPercent = e.hp / e.maxHp;
            // Phase transitions
            if (hpPercent <= 0.25 && e.bossPhase < 3) {
                e.bossPhase = 3;
                e.state = 'BOSS_PHASE3';
                L.screenShake = 8;
            } else if (hpPercent <= 0.50 && e.bossPhase < 2) {
                e.bossPhase = 2;
                e.state = 'BOSS_PHASE2';
                L.screenShake = 5;
            }

            // Weak point visibility cycling
            e.weakPointTimer += dt;
            var wpCycle = e.bossPhase >= 3 ? 2.0 : e.bossPhase >= 2 ? 3.0 : 4.0;
            var wpDuration = e.bossPhase >= 3 ? 1.5 : e.bossPhase >= 2 ? 1.0 : 0.8;
            e.weakPointVisible = (e.weakPointTimer % wpCycle) < wpDuration;

            // Boss movement (phase 2+)
            if (e.bossPhase >= 2) {
                var bmSpeed = lts * (e.bossPhase >= 3 ? 1.2 : 0.6);
                var btDx = pcx - ecx, btDy = pcy - ecy;
                var btLen = Math.hypot(btDx, btDy);
                if (btLen > lts * 3) {
                    btDx /= btLen; btDy /= btLen;
                    var bnx2 = e.x + btDx * bmSpeed * dt;
                    var bny2 = e.y + btDy * bmSpeed * dt;
                    if (!levelTileCollision(L, bnx2, e.y, e.w, e.h)) e.x = bnx2;
                    if (!levelTileCollision(L, e.x, bny2, e.w, e.h)) e.y = bny2;
                }
            }

            // Boss projectile firing
            e.bossFireTimer -= dt;
            if (e.bossFireTimer <= 0) {
                var fireRate = e.bossPhase >= 3 ? 0.5 : e.bossPhase >= 2 ? 0.8 : 1.2;
                e.bossFireTimer = fireRate;
                // Fire projectile patterns
                var numProj = e.bossPhase >= 3 ? 5 : e.bossPhase >= 2 ? 3 : 2;
                var baseAngle = Math.atan2(pcy - ecy, pcx - ecx);
                var spread = e.bossPhase >= 3 ? 0.8 : 0.4;
                for (var bp = 0; bp < numProj; bp++) {
                    var pAngle2 = baseAngle + (bp - (numProj - 1) / 2) * (spread / Math.max(1, numProj - 1));
                    L.projectiles.push({
                        x: ecx, y: ecy,
                        vx: Math.cos(pAngle2) * PROJ_SPEED * lts * 0.8,
                        vy: Math.sin(pAngle2) * PROJ_SPEED * lts * 0.8,
                        life: 4.0
                    });
                }
            }

            // Boss spawning minions
            e.bossSpawnTimer -= dt;
            if (e.bossSpawnTimer <= 0) {
                var spawnRate = e.bossPhase >= 3 ? 4.0 : e.bossPhase >= 2 ? 6.0 : 8.0;
                e.bossSpawnTimer = spawnRate;
                // Spawn a minion near the boss
                var spawnType = e.bossPhase >= 2 ? (Math.random() < 0.4 ? 'foot_shield' : 'foot') : 'foot';
                if (e.bossPhase >= 3 && Math.random() < 0.3) spawnType = 'foot_ranged';
                var minionX = e.x + (Math.random() - 0.5) * lts * 4;
                var minionY = e.y + e.h + lts;
                if (!levelTileCollision(L, minionX, minionY, lts * 0.7, lts * 0.7)) {
                    L.enemies.push({
                        id: 'minion_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                        type: spawnType,
                        ranged: spawnType === 'foot_ranged',
                        shield: spawnType === 'foot_shield',
                        runner: spawnType === 'foot_runner',
                        boss: false,
                        x: minionX, y: minionY,
                        w: lts * 0.7, h: lts * 0.7,
                        hp: 1, maxHp: 1,
                        alive: true,
                        patrolLeft: minionX - lts * 4,
                        patrolRight: minionX + lts * 4,
                        patrolCx: minionX, patrolCy: minionY,
                        facingDir: pcx > minionX ? 1 : -1,
                        animTimer: 0,
                        state: 'CHASE',
                        stateTimer: 0, stunTimer: 0,
                        kbVx: 0, kbVy: 0, kbTimer: 0,
                        chaseRadius: lts * 10,
                        attackRadius: lts * 1.2,
                        attackCooldown: 0,
                        shieldUp: spawnType === 'foot_shield',
                        bossPhase: 0, bossSpawnTimer: 0, bossFireTimer: 0,
                        weakPointVisible: false, weakPointTimer: 0
                    });
                }
            }

            // Boss only takes damage when weak point is visible (handled in hit detection)
            continue;
        }

        // State transitions
        if (e.state === 'PATROL') {
            var patrolMult = e.runner ? ENEMY_PATROL_SPEED_MULT * 1.6 : ENEMY_PATROL_SPEED_MULT;
            var eSpeed = lts * patrolMult;
            e.x += e.facingDir * eSpeed * dt;
            if (e.x <= e.patrolLeft) { e.x = e.patrolLeft; e.facingDir = 1; }
            if (e.x >= e.patrolRight) { e.x = e.patrolRight; e.facingDir = -1; }
            if (distToPlayer < e.chaseRadius) {
                e.state = 'CHASE';
                e.stateTimer = 0;
            }
        } else if (e.state === 'CHASE') {
            var chaseMult = e.runner ? ENEMY_CHASE_SPEED_MULT * 1.5 : ENEMY_CHASE_SPEED_MULT;
            var chaseSpeed = lts * chaseMult;
            var toDx = pcx - ecx, toDy = pcy - ecy;
            var toLen = Math.hypot(toDx, toDy);
            if (toLen > 1) {
                toDx /= toLen; toDy /= toLen;
                var cnx = e.x + toDx * chaseSpeed * dt;
                var cny = e.y + toDy * chaseSpeed * dt;
                if (!levelTileCollision(L, cnx, e.y, e.w, e.h)) e.x = cnx;
                if (!levelTileCollision(L, e.x, cny, e.w, e.h)) e.y = cny;
                e.facingDir = toDx > 0 ? 1 : -1;
            }
            if (distToPlayer < e.attackRadius && e.attackCooldown <= 0) {
                e.state = 'ATTACK';
                e.stateTimer = 0;
            } else if (distToPlayer > e.chaseRadius * 1.5) {
                e.state = 'PATROL';
                e.stateTimer = 0;
            }
        } else if (e.state === 'ATTACK') {
            if (e.stateTimer >= ENEMY_ATTACK_WINDUP) {
                if (e.ranged) {
                    // Fire projectile towards player
                    var fDir = Math.atan2(pcy - ecy, pcx - ecx);
                    L.projectiles.push({
                        x: ecx, y: ecy,
                        vx: Math.cos(fDir) * PROJ_SPEED * lts,
                        vy: Math.sin(fDir) * PROJ_SPEED * lts,
                        life: 3.0
                    });
                } else {
                    // Melee damage
                    if (p.invTimer <= 0 && levelRectsOverlap(p.x, p.y, p.w, p.h, e.x - lts * 0.3, e.y - lts * 0.3, e.w + lts * 0.6, e.h + lts * 0.6)) {
                        p.hp -= 1;
                        p.damageTaken++;
                        p.invTimer = 0.7;
                        var kDir = Math.atan2(pcy - ecy, pcx - ecx);
                        p.kbVx = Math.cos(kDir) * KB_PLAYER_DIST / KB_DURATION;
                        p.kbVy = Math.sin(kDir) * KB_PLAYER_DIST / KB_DURATION;
                        p.kbTimer = KB_DURATION;
                        if (p.hp <= 0) {
                            L.failed = true;
                            game.levelState = 'FAIL';
                            setTimeout(exitLevel, 1500);
                            return;
                        }
                    }
                }
                e.state = 'RECOVER';
                e.stateTimer = 0;
            }
        } else if (e.state === 'RECOVER') {
            if (e.stateTimer >= ENEMY_ATTACK_RECOVER) {
                e.attackCooldown = e.ranged ? 0.8 : 0.5;
                e.state = distToPlayer < e.chaseRadius ? 'CHASE' : 'PATROL';
                e.stateTimer = 0;
            }
        }

        // ── Player ACTIVE hit detection against this enemy ──────
        if (p.atkPhase === 'ACTIVE' && !p.atkHitIds.has(e.id)) {
            var atkRange = e.boss ? lts * 2.0 : lts * 1.2;
            var aDx = (p.direction === 'right') ? atkRange : (p.direction === 'left') ? -atkRange : 0;
            var aDy = (p.direction === 'up') ? -atkRange : (p.direction === 'down') ? atkRange : 0;
            var ax = p.x + p.w / 2 + aDx;
            var ay = p.y + p.h / 2 + aDy;
            var hitRange = e.boss ? lts * 2 : lts;
            if (Math.abs(ax - ecx) < hitRange && Math.abs(ay - ecy) < hitRange) {
                // Boss weak point check: can only damage when weak point visible
                var blocked = false;
                if (e.boss && !e.weakPointVisible) {
                    blocked = true;
                    p.atkHitIds.add(e.id);
                    L.screenShake = 1;
                    L.hitSparks.push({ x: (ax + ecx) / 2, y: (ay + ecy) / 2, life: 0.06 });
                }
                // Shield check: shield blocks if player attacks from the front
                if (!blocked && e.shield && e.shieldUp && e.state !== 'RECOVER') {
                    var attackFromRight = (pcx > ecx && e.facingDir === 1) || (pcx < ecx && e.facingDir === -1);
                    if (attackFromRight || Math.abs(pcx - ecx) < lts * 0.3) {
                        blocked = true;
                        p.atkHitIds.add(e.id);
                        L.screenShake = 1;
                        L.hitSparks.push({ x: (ax + ecx) / 2, y: (ay + ecy) / 2, life: 0.08 });
                    }
                }
                if (!blocked) {
                e.hp -= 1;
                p.atkHitIds.add(e.id);
                // Hit confirm: screen shake + spark
                L.screenShake = 3;
                L.hitSparks.push({ x: (ax + ecx) / 2, y: (ay + ecy) / 2, life: 0.12 });
                // Enemy knockback: away from player (boss has minimal KB)
                var hitDir = Math.atan2(ecy - pcy, ecx - pcx);
                var kbMult = e.boss ? 0.2 : 1.0;
                e.kbVx = Math.cos(hitDir) * KB_ENEMY_DIST * kbMult / KB_DURATION;
                e.kbVy = Math.sin(hitDir) * KB_ENEMY_DIST * kbMult / KB_DURATION;
                e.kbTimer = KB_DURATION;
                e.stunTimer = e.boss ? 0.05 : e.runner ? ENEMY_STUN_DURATION * 0.6 : ENEMY_STUN_DURATION;
                if (e.hp <= 0) {
                    e.alive = false;
                    addKillScore(e.type, ecx, ecy);
                    // Boss defeat check
                    if (e.boss) {
                        L.bossDefeated = true;
                        L.victoryTimer = 0;
                        game.progress.technodromeClear = true;
                        game.progress.score += 10000;
                        saveGame();
                    }
                }
                } // end !blocked
            }
        }

        // ── Passive collision: enemy body damages player ────────
        var isContactState = e.state === 'CHASE' || (e.boss && (e.state === 'BOSS_PHASE1' || e.state === 'BOSS_PHASE2' || e.state === 'BOSS_PHASE3'));
        if (isContactState && p.invTimer <= 0 && levelRectsOverlap(p.x, p.y, p.w, p.h, e.x, e.y, e.w, e.h)) {
            p.hp -= 1;
            p.damageTaken++;
            p.invTimer = 0.7;
            var cDir = Math.atan2(pcy - ecy, pcx - ecx);
            p.kbVx = Math.cos(cDir) * KB_PLAYER_DIST / KB_DURATION;
            p.kbVy = Math.sin(cDir) * KB_PLAYER_DIST / KB_DURATION;
            p.kbTimer = KB_DURATION;
            if (p.hp <= 0) {
                L.failed = true;
                game.levelState = 'FAIL';
                setTimeout(exitLevel, 1500);
                return;
            }
        }
    }

    // ── Projectile update ───────────────────────────────────────
    for (var pi = L.projectiles.length - 1; pi >= 0; pi--) {
        var proj = L.projectiles[pi];
        proj.life -= dt;
        if (proj.life <= 0) { L.projectiles.splice(pi, 1); continue; }
        proj.x += proj.vx * dt;
        proj.y += proj.vy * dt;
        // Wall collision
        var ptx = Math.floor(proj.x / lts), pty = Math.floor(proj.y / lts);
        if (ptx < 0 || ptx >= L.width || pty < 0 || pty >= L.height ||
            (L.tileTypes[String(L.tilemap[pty][ptx])] && L.tileTypes[String(L.tilemap[pty][ptx])].solid)) {
            L.projectiles.splice(pi, 1); continue;
        }
        // Player collision
        if (p.invTimer <= 0 && Math.abs(proj.x - (p.x + p.w / 2)) < p.w * 0.6 && Math.abs(proj.y - (p.y + p.h / 2)) < p.h * 0.6) {
            p.hp -= 1;
            p.damageTaken++;
            p.invTimer = 0.7;
            var pAngle = Math.atan2(proj.vy, proj.vx);
            p.kbVx = Math.cos(pAngle) * PROJ_KB / KB_DURATION;
            p.kbVy = Math.sin(pAngle) * PROJ_KB / KB_DURATION;
            p.kbTimer = KB_DURATION;
            L.screenShake = 2;
            L.projectiles.splice(pi, 1);
            if (p.hp <= 0) {
                L.failed = true;
                game.levelState = 'FAIL';
                setTimeout(exitLevel, 1500);
                return;
            }
            continue;
        }
    }

    // ── Exit trigger ────────────────────────────────────────────
    if (levelRectsOverlap(p.x, p.y, p.w, p.h, L.exit.x, L.exit.y, L.exit.w, L.exit.h)) {
        L.complete = true;
        game.levelState = 'COMPLETE';
        game.progress.levelWins[L.id] = true;
        if (L.seed) game.progress.levelWins[L.seed] = true;
        finalizeLevelScore();
        recordHighScore();
        saveGame();
        console.log('Level complete: ' + L.id + ' score=' + L.score);
        // Show results screen instead of immediately exiting
        L.showResults = true;
        L.resultsTimer = 0;
        return;
    }

    // ── Camera ──────────────────────────────────────────────────
    var cw = CANVAS_WIDTH, ch = CANVAS_HEIGHT;
    var maxCx = L.width * lts - cw;
    var maxCy = L.height * lts - ch;
    L.camera.x = Math.max(0, Math.min(maxCx, p.x - cw / 2));
    L.camera.y = Math.max(0, Math.min(maxCy, p.y - ch / 2));
}

function levelTileCollision(L, x, y, w, h) {
    var ts = L.tileSize;
    var x0 = Math.floor(x / ts);
    var y0 = Math.floor(y / ts);
    var x1 = Math.floor((x + w - 1) / ts);
    var y1 = Math.floor((y + h - 1) / ts);
    for (var ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= L.height) return true;
        for (var tx = x0; tx <= x1; tx++) {
            if (tx < 0 || tx >= L.width) return true;
            var tileId = L.tilemap[ty][tx];
            var ttype = L.tileTypes[String(tileId)];
            if (ttype && ttype.solid) return true;
        }
    }
    return false;
}

function levelRectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function drawLevel() {
    var L = game.level;
    if (!L) return;

    var ts = L.tileSize;
    var shakeOx = 0, shakeOy = 0;
    if (L.screenShake > 0) {
        shakeOx = (Math.random() - 0.5) * L.screenShake * 2;
        shakeOy = (Math.random() - 0.5) * L.screenShake * 2;
    }
    var cx = L.camera.x + shakeOx, cy = L.camera.y + shakeOy;

    ctx.fillStyle = NES.PAL.K;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Tilemap
    var sx0 = Math.floor(cx / ts);
    var sy0 = Math.floor(cy / ts);
    var sx1 = sx0 + Math.ceil(CANVAS_WIDTH / ts) + 2;
    var sy1 = sy0 + Math.ceil(CANVAS_HEIGHT / ts) + 2;

    for (var ty = sy0; ty < sy1; ty++) {
        if (ty < 0 || ty >= L.height) continue;
        for (var tx = sx0; tx < sx1; tx++) {
            if (tx < 0 || tx >= L.width) continue;
            var px = tx * ts - cx;
            var py = ty * ts - cy;
            var tileId = L.tilemap[ty][tx];

            var themeKeys = LEVEL_SPRITE_KEYS[L.data.theme] || null;
            var isGalleryTheme = L.data.theme === 'gallery';
            var nesLevelWall = L.data.theme === 'sewer' ? 'sewerWall' :
                               L.data.theme === 'street' ? 'streetWall' :
                               L.data.theme === 'dock' ? 'dockWall' :
                               L.data.theme === 'gallery' ? 'galleryWall' : 'sewerWall';
            var nesLevelFloor = L.data.theme === 'sewer' ? 'sewerFloor' :
                                L.data.theme === 'street' ? 'streetFloor' :
                                L.data.theme === 'dock' ? 'dockFloor' :
                                L.data.theme === 'gallery' ? 'galleryFloor' : 'sewerFloor';
            if (tileId === 1) {
                var wallSprite = themeKeys ? game.sprites[themeKeys.wall] : null;
                if (wallSprite) {
                    ctx.drawImage(wallSprite, px, py, ts, ts);
                } else {
                    NES.drawTileStretched(ctx, px, py, ts, ts, nesLevelWall);
                }
            } else if (tileId === 2) {
                var hFloorSprite = themeKeys ? game.sprites[themeKeys.floor] : null;
                if (hFloorSprite) ctx.drawImage(hFloorSprite, px, py, ts, ts);
                else NES.drawTileStretched(ctx, px, py, ts, ts, nesLevelFloor);
                var hzInfo = THEME_HAZARD[L.data.theme];
                var hzSpriteKey = hzInfo ? ('hazard' + hzInfo.name.charAt(0).toUpperCase() + hzInfo.name.slice(1)) : null;
                var hzSprite = hzSpriteKey ? game.sprites[hzSpriteKey] : null;
                if (hzSprite) {
                    ctx.drawImage(hzSprite, px, py, ts, ts);
                } else if (hzInfo) {
                    var hzPulse = 0.4 + Math.sin(Date.now() / 300) * 0.15;
                    var hzNesColor = L.data.theme === 'sewer' ? NES.PAL.C :
                                     L.data.theme === 'dock' ? NES.PAL.N :
                                     L.data.theme === 'gallery' ? NES.PAL.P : NES.PAL.T;
                    ctx.globalAlpha = hzPulse;
                    ctx.fillStyle = hzNesColor;
                    ctx.fillRect(px + 2, py + 2, ts - 4, ts - 4);
                    ctx.globalAlpha = 1.0;
                    ctx.fillStyle = NES.PAL.T;
                    ctx.font = 'bold ' + (ts * 0.35) + 'px "Press Start 2P", monospace';
                    ctx.textAlign = 'center';
                    ctx.fillText('!', px + ts / 2, py + ts * 0.65);
                    ctx.textAlign = 'left';
                }
            } else {
                var floorSprite = themeKeys ? game.sprites[themeKeys.floor] : null;
                if (floorSprite) {
                    ctx.drawImage(floorSprite, px, py, ts, ts);
                } else {
                    NES.drawTileStretched(ctx, px, py, ts, ts, nesLevelFloor);
                }
            }
        }
    }

    var ex = L.exit.x - cx, ey = L.exit.y - cy;
    var exitPulse = 0.4 + Math.sin(Date.now() / 300) * 0.2;
    ctx.fillStyle = 'rgba(60,188,252,' + exitPulse.toFixed(2) + ')';
    ctx.fillRect(ex, ey, ts, ts);
    ctx.fillStyle = NES.PAL.W;
    ctx.font = 'bold 10px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('EXIT', ex + ts / 2, ey + ts / 2 + 4);
    ctx.textAlign = 'left';

    // Enemies
    for (var i = 0; i < L.enemies.length; i++) {
        var e = L.enemies[i];
        if (!e.alive) continue;
        var esx = e.x - cx, esy = e.y - cy;

        // Stun flash
        if (e.stunTimer > 0 && Math.floor(e.stunTimer * 10) % 2 === 0) continue;

        if (e.boss) {
            var bossGlow = Math.sin(Date.now() / 150) * 0.2 + 0.6;
            ctx.fillStyle = NES.PAL.G;
            ctx.beginPath();
            ctx.arc(esx + e.w / 2, esy + e.h / 2, e.w * 0.45, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = NES.PAL.N;
            ctx.beginPath();
            ctx.arc(esx + e.w / 2, esy + e.h / 2, e.w * 0.38, 0, Math.PI * 2);
            ctx.fill();
            var phaseColor = e.bossPhase >= 3 ? NES.PAL.R : e.bossPhase >= 2 ? NES.PAL.P : NES.PAL.N;
            ctx.strokeStyle = phaseColor;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(esx + e.w / 2, esy + e.h / 2, e.w * 0.42, 0, Math.PI * 2);
            ctx.stroke();
            if (e.weakPointVisible) {
                ctx.fillStyle = NES.PAL.T;
                ctx.globalAlpha = bossGlow;
                ctx.beginPath();
                ctx.arc(esx + e.w / 2, esy + e.h * 0.35, e.w * 0.12, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1.0;
                ctx.fillStyle = NES.PAL.R;
                ctx.beginPath();
                ctx.arc(esx + e.w / 2, esy + e.h * 0.35, e.w * 0.06, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.fillStyle = NES.PAL.R;
            ctx.beginPath();
            ctx.arc(esx + e.w / 2, esy + e.h / 2, e.w * 0.08, 0, Math.PI * 2);
            ctx.fill();
            var bossHpW = e.w * 1.2;
            ctx.fillStyle = NES.PAL.K;
            ctx.fillRect(esx + e.w / 2 - bossHpW / 2, esy - 12, bossHpW, 6);
            ctx.fillStyle = e.bossPhase >= 3 ? NES.PAL.R : e.bossPhase >= 2 ? NES.PAL.P : NES.PAL.C;
            ctx.fillRect(esx + e.w / 2 - bossHpW / 2, esy - 12, bossHpW * (e.hp / e.maxHp), 6);
            ctx.fillStyle = NES.PAL.W;
            ctx.font = 'bold 8px "Press Start 2P", monospace';
            ctx.textAlign = 'center';
            ctx.fillText('TECHNODROME', esx + e.w / 2, esy - 16);
            if (e.weakPointVisible) {
                ctx.fillStyle = NES.PAL.T;
                ctx.font = 'bold 7px "Press Start 2P", monospace';
                ctx.fillText('WEAK POINT!', esx + e.w / 2, esy - 24);
            }
            ctx.textAlign = 'left';
        } else {
        var bodyColor = e.ranged ? NES.PAL.N : e.shield ? NES.PAL.G : e.runner ? NES.PAL.C : NES.PAL.R;
        if (e.state === 'ATTACK') bodyColor = e.ranged ? NES.PAL.B : e.shield ? NES.PAL.L : e.runner ? NES.PAL.C : NES.PAL.P;

        var enemySpriteKey = e.ranged ? 'enemyRanged' : e.shield ? 'enemyShield' : e.runner ? 'enemyRunner' : 'enemyFoot';
        var enemySprite = game.sprites[enemySpriteKey];
        if (enemySprite) {
            ctx.save();
            if (e.facingDir < 0) {
                ctx.translate(esx + e.w, esy);
                ctx.scale(-1, 1);
                ctx.drawImage(enemySprite, 0, 0, e.w, e.h);
            } else {
                ctx.drawImage(enemySprite, esx, esy, e.w, e.h);
            }
            ctx.restore();
        } else {
            ctx.fillStyle = bodyColor;
            ctx.fillRect(esx + 2, esy + 2, e.w - 4, e.h - 4);
            ctx.strokeStyle = NES.PAL.K;
            ctx.lineWidth = 2;
            ctx.strokeRect(esx + 2, esy + 2, e.w - 4, e.h - 4);
            ctx.fillStyle = NES.PAL.W;
            var eyeOff = e.facingDir > 0 ? 0.55 : 0.15;
            ctx.fillRect(esx + e.w * eyeOff, esy + e.h * 0.2, 4, 4);
            ctx.fillRect(esx + e.w * (eyeOff + 0.15), esy + e.h * 0.2, 4, 4);
            ctx.fillStyle = NES.PAL.K;
            ctx.fillRect(esx + e.w * eyeOff + 2, esy + e.h * 0.2 + 2, 2, 2);
            ctx.fillRect(esx + e.w * (eyeOff + 0.15) + 2, esy + e.h * 0.2 + 2, 2, 2);
            ctx.fillStyle = NES.PAL.R;
            ctx.fillRect(esx + 4, esy + e.h * 0.15, e.w - 8, 3);
            if (e.shield && e.shieldUp) {
                ctx.fillStyle = NES.PAL.L;
                var shX = e.facingDir > 0 ? esx + e.w - 6 : esx;
                ctx.fillRect(shX, esy + 4, 5, e.h - 8);
                ctx.fillStyle = NES.PAL.W;
                ctx.fillRect(shX + 1, esy + 6, 3, e.h - 12);
            }
            if (e.runner && e.state === 'CHASE') {
                ctx.fillStyle = NES.PAL.C;
                for (var sl = 0; sl < 3; sl++) {
                    var slx = esx - e.facingDir * (8 + sl * 5);
                    ctx.fillRect(slx, esy + 4 + sl * 8, 4, 2);
                }
            }
        }
        if (e.state === 'ATTACK') {
            var flashAlpha = 0.3 + Math.sin(e.stateTimer * 30) * 0.3;
            ctx.fillStyle = 'rgba(252, 116, 96, ' + flashAlpha.toFixed(2) + ')';
            ctx.fillRect(esx - 4, esy - 4, e.w + 8, e.h + 8);
        }
        ctx.fillStyle = NES.PAL.K;
        ctx.fillRect(esx, esy - 6, e.w, 3);
        ctx.fillStyle = NES.PAL.R;
        ctx.fillRect(esx, esy - 6, e.w * (e.hp / (e.maxHp || 2)), 3);
        } // end non-boss enemy rendering
        // State label (debug only)
        if (game.debugZones) {
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.font = '5px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(e.state, esx + e.w / 2, esy - 8);
            ctx.textAlign = 'left';
        }
    }

    // Projectiles (white dots with trailing fade)
    for (var pi = 0; pi < L.projectiles.length; pi++) {
        var proj = L.projectiles[pi];
        var prx = proj.x - cx, pry = proj.y - cy;
        // Trail (3 fading dots behind)
        var speed = Math.hypot(proj.vx, proj.vy);
        if (speed > 0) {
            var ndx = -proj.vx / speed, ndy = -proj.vy / speed;
            for (var ti = 1; ti <= 3; ti++) {
                var trailAlpha = 0.3 - ti * 0.08;
                ctx.fillStyle = 'rgba(255,255,255,' + trailAlpha + ')';
                ctx.beginPath();
                ctx.arc(prx + ndx * ti * 4, pry + ndy * ti * 4, PROJ_RADIUS - 1, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        // Core dot
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(prx, pry, PROJ_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        // Glow
        ctx.fillStyle = 'rgba(200,200,255,0.3)';
        ctx.beginPath();
        ctx.arc(prx, pry, PROJ_RADIUS * 2, 0, Math.PI * 2);
        ctx.fill();
    }

    // Player
    var p = L.player;
    var psx = p.x - cx, psy = p.y - cy;
    var blink = (p.invTimer > 0 && Math.floor(p.invTimer * 10) % 2 === 0);
    if (!blink) {
        var turtleScale = p.w / 16;
        var turtleId = p.turtleId || 'leo';
        if (p.atkPhase === 'ACTIVE') {
            // Flash white during attack
            ctx.globalAlpha = 0.7;
            NES.drawTurtleSprite(ctx, psx, psy, p.direction, p.animFrame, turtleId, turtleScale);
            ctx.globalAlpha = 0.4;
            ctx.fillStyle = NES.PAL.W;
            ctx.fillRect(psx, psy, p.w, p.h);
            ctx.globalAlpha = 1;
        } else {
            NES.drawTurtleSprite(ctx, psx, psy, p.direction, p.animFrame, turtleId, turtleScale);
        }
    }

    // Attack effect: windup shows charge, active shows slash or whiff trail
    if (p.atkPhase === 'WINDUP') {
        var chargeAlpha = 0.2 + p.atkTimer / ATK_WINDUP * 0.3;
        ctx.fillStyle = 'rgba(255, 255, 100, ' + chargeAlpha + ')';
        ctx.beginPath();
        ctx.arc(psx + p.w / 2, psy + p.h / 2, p.w * 0.6, 0, Math.PI * 2);
        ctx.fill();
    } else if (p.atkPhase === 'ACTIVE') {
        var slashOx = p.direction === 'right' ? p.w : (p.direction === 'left' ? -ts * 0.7 : 0);
        var slashOy = p.direction === 'down' ? p.h : (p.direction === 'up' ? -ts * 0.7 : 0);
        var slashW = (p.direction === 'left' || p.direction === 'right') ? ts * 0.7 : p.w;
        var slashH = (p.direction === 'up' || p.direction === 'down') ? ts * 0.7 : p.h * 0.6;
        var hasHit = p.atkHitIds && p.atkHitIds.size > 0;
        if (hasHit) {
            // Hit: bright yellow slash
            var slashAlpha = 0.5 + (1 - p.atkTimer / ATK_ACTIVE) * 0.4;
            ctx.fillStyle = 'rgba(255, 255, 0, ' + slashAlpha + ')';
            ctx.fillRect(psx + slashOx, psy + slashOy + p.h * 0.1, slashW, slashH);
        } else {
            // Whiff: faint arc trail
            ctx.strokeStyle = 'rgba(200, 200, 255, ' + (0.2 + p.atkTimer / ATK_ACTIVE * 0.3) + ')';
            ctx.lineWidth = 2;
            ctx.beginPath();
            var trailCx = psx + p.w / 2 + (slashOx > 0 ? slashOx * 0.5 : slashOx * 0.5);
            var trailCy = psy + p.h / 2 + (slashOy > 0 ? slashOy * 0.5 : slashOy * 0.5);
            var arcR = ts * 0.5;
            var startAngle = p.direction === 'right' ? -0.8 : p.direction === 'left' ? 2.3 : p.direction === 'up' ? 3.6 : 0.8;
            ctx.arc(trailCx, trailCy, arcR, startAngle, startAngle + 1.6);
            ctx.stroke();
        }
    }

    // Hit sparks
    var sparkSprite = game.sprites.hitSpark;
    for (var hi = 0; hi < L.hitSparks.length; hi++) {
        var spark = L.hitSparks[hi];
        var sparkSx = spark.x - cx, sparkSy = spark.y - cy;
        var sparkAlpha = spark.life / 0.12;
        var sparkSize = 6 + (1 - sparkAlpha) * 8;
        if (sparkSprite) {
            ctx.save();
            ctx.globalAlpha = sparkAlpha;
            ctx.drawImage(sparkSprite, sparkSx - sparkSize, sparkSy - sparkSize, sparkSize * 2, sparkSize * 2);
            ctx.restore();
        } else {
            ctx.fillStyle = 'rgba(255, 255, 200, ' + sparkAlpha + ')';
            ctx.fillRect(sparkSx - sparkSize / 2, sparkSy - sparkSize / 2, sparkSize, sparkSize);
            ctx.fillStyle = 'rgba(255, 200, 50, ' + (sparkAlpha * 0.7) + ')';
            ctx.fillRect(sparkSx - sparkSize / 4, sparkSy - sparkSize / 4, sparkSize / 2, sparkSize / 2);
        }
    }

    // ── Art frames for gallery levels ──────────────────────────
    if (L.artFrames && L.artFrames.length > 0) {
        for (var afi = 0; afi < L.artFrames.length; afi++) {
            var af = L.artFrames[afi];
            var afx = af.x * ts - cx;
            var afy = af.y * ts - cy;
            if (afx < -ts || afx > CANVAS_WIDTH + ts || afy < -ts || afy > CANVAS_HEIGHT + ts) continue;
            // Frame border
            ctx.fillStyle = '#c8a050';
            ctx.fillRect(afx + 4, afy + 2, ts - 8, ts * 0.6);
            // Inner colored rectangle (procedural art from artist hash)
            var artSeed = seedHashRT((L.artistId || 'art') + '_' + afi);
            var artRng = mulberry32RT(artSeed);
            var r = Math.floor(artRng() * 128 + 80);
            var g = Math.floor(artRng() * 128 + 80);
            var b = Math.floor(artRng() * 128 + 80);
            ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
            ctx.fillRect(afx + 6, afy + 4, ts - 12, ts * 0.6 - 4);
            // Small geometric detail
            ctx.fillStyle = 'rgb(' + (255 - r) + ',' + (255 - g) + ',' + (255 - b) + ')';
            var patternType = Math.floor(artRng() * 3);
            if (patternType === 0) {
                ctx.beginPath();
                ctx.arc(afx + ts / 2, afy + ts * 0.3, ts * 0.12, 0, Math.PI * 2);
                ctx.fill();
            } else if (patternType === 1) {
                ctx.fillRect(afx + ts * 0.3, afy + ts * 0.15, ts * 0.4, ts * 0.3);
            } else {
                ctx.beginPath();
                ctx.moveTo(afx + ts / 2, afy + 6);
                ctx.lineTo(afx + ts * 0.7, afy + ts * 0.5);
                ctx.lineTo(afx + ts * 0.3, afy + ts * 0.5);
                ctx.closePath();
                ctx.fill();
            }
        }
    }

    // ── Special item pickup ─────────────────────────────────────
    if (L.specialItemPos && !L.specialItemCollected) {
        var sip = L.specialItemPos;
        var sipx = sip.x - cx, sipy = sip.y - cy;
        var pulse = Math.sin(Date.now() / 200) * 0.3 + 0.7;
        var itemDef = L.specialItem;
        // Glow
        ctx.fillStyle = 'rgba(' + parseInt(itemDef.color.slice(1, 3), 16) + ',' + parseInt(itemDef.color.slice(3, 5), 16) + ',' + parseInt(itemDef.color.slice(5, 7), 16) + ',' + (pulse * 0.4) + ')';
        ctx.beginPath();
        ctx.arc(sipx + sip.w / 2, sipy + sip.h / 2, ts * 0.8, 0, Math.PI * 2);
        ctx.fill();
        // Item body
        ctx.fillStyle = itemDef.color;
        ctx.beginPath();
        ctx.arc(sipx + sip.w / 2, sipy + sip.h / 2, ts * 0.35 * pulse, 0, Math.PI * 2);
        ctx.fill();
        // Inner highlight
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(sipx + sip.w / 2 - 2, sipy + sip.h / 2 - 2, ts * 0.12, 0, Math.PI * 2);
        ctx.fill();
        // Label
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 7px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('★', sipx + sip.w / 2, sipy - 4);
        ctx.textAlign = 'left';
    }

    // HUD: Turtle portrait + HP
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(8, 8, 150, 28);
    NES.drawTurtleSprite(ctx, 10, 9, 'down', 0, p.turtleId || 'leo', 1.6);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px monospace';
    ctx.fillText('HP:', 38, 24);
    for (var h = 0; h < p.maxHp; h++) {
        ctx.fillStyle = h < p.hp ? '#22bb44' : '#333333';
        ctx.fillRect(62 + h * 18, 14, 15, 12);
    }

    // HUD: Score (top-right)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(CANVAS_WIDTH - 130, 8, 122, 24);
    ctx.fillStyle = '#fcfc00';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('SCORE: ' + L.score, CANVAS_WIDTH - 14, 24);
    ctx.textAlign = 'left';

    // HUD: Combo counter
    if (L.comboCount > 1 && L.comboTimer > 0) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(CANVAS_WIDTH - 130, 36, 122, 16);
        ctx.fillStyle = L.comboCount > 3 ? '#ff4444' : '#ffaa00';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'right';
        ctx.fillText('COMBO x' + L.comboCount, CANVAS_WIDTH - 14, 49);
        ctx.textAlign = 'left';
    }

    // HUD: Item tracker (10 slots)
    var itemY = 36;
    if (L.comboCount > 1 && L.comboTimer > 0) itemY = 56;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(8, itemY, 112, 14);
    ctx.font = '7px monospace';
    for (var iti = 0; iti < 10; iti++) {
        var itemId = SPECIAL_ITEMS[iti].id;
        var hasIt = game.progress.collectedItems[itemId];
        ctx.fillStyle = hasIt ? SPECIAL_ITEMS[iti].color : '#333333';
        ctx.fillRect(12 + iti * 11, itemY + 3, 8, 8);
    }

    // Point popups
    for (var popi = 0; popi < L.pointPopups.length; popi++) {
        var pop = L.pointPopups[popi];
        var popx = pop.x - L.camera.x, popy = pop.y - L.camera.y;
        var popAlpha = Math.min(1.0, pop.life);
        ctx.fillStyle = pop.color.replace(')', ',' + popAlpha + ')').replace('rgb', 'rgba');
        if (pop.color[0] === '#') {
            var pr2 = parseInt(pop.color.slice(1, 3), 16);
            var pg2 = parseInt(pop.color.slice(3, 5), 16);
            var pb2 = parseInt(pop.color.slice(5, 7), 16);
            ctx.fillStyle = 'rgba(' + pr2 + ',' + pg2 + ',' + pb2 + ',' + popAlpha + ')';
        }
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(pop.text, popx, popy);
        ctx.textAlign = 'left';
    }

    // Level name banner (branded)
    var levelName = L.data.name || L.id;
    var bannerText = BRAND.levelPrefix + ': ' + levelName.toUpperCase();
    if (L.data.theme === 'gallery' && L.artistName) {
        bannerText = 'GALLERY OF ' + L.artistName.toUpperCase();
    }
    var bannerW = Math.max(160, bannerText.length * 7 + 20);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(CANVAS_WIDTH / 2 - bannerW / 2, 4, bannerW, 18);
    ctx.fillStyle = L.data.theme === 'gallery' ? '#ff88ff' : '#00ff00';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(bannerText, CANVAS_WIDTH / 2, 16);
    ctx.textAlign = 'left';

    // Gallery splash overlay
    if (L.gallerySplash > 0) {
        var splashAlpha = Math.min(1.0, L.gallerySplash);
        ctx.fillStyle = 'rgba(0, 0, 0, ' + (splashAlpha * 0.8) + ')';
        ctx.fillRect(0, CANVAS_HEIGHT / 2 - 40, CANVAS_WIDTH, 80);
        ctx.fillStyle = 'rgba(255, 136, 255, ' + splashAlpha + ')';
        ctx.font = 'bold 16px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('GALLERY OF', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 12);
        ctx.fillStyle = 'rgba(252, 252, 0, ' + splashAlpha + ')';
        ctx.font = 'bold 20px monospace';
        ctx.fillText(L.artistName ? L.artistName.toUpperCase() : 'UNKNOWN', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 18);
        ctx.textAlign = 'left';
    }

    // Fade in overlay
    if (L.fadeIn > 0) {
        ctx.fillStyle = 'rgba(0, 0, 0, ' + L.fadeIn + ')';
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        // Level title card during fade
        if (L.fadeIn > 0.3) {
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 14px monospace';
            ctx.textAlign = 'center';
            var titleCard = L.data.theme === 'gallery' ? 'GALLERY OF ' + (L.artistName || '').toUpperCase() :
                           L.data.theme === 'street' ? 'STREET FIGHT' :
                           L.data.theme === 'sewer' ? 'SEWER' :
                           L.data.theme === 'dock' ? 'DOCK' : L.data.name || '';
            ctx.fillText(titleCard, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
            ctx.textAlign = 'left';
        }
    }

    // Results screen (Phase 2)
    if (L.showResults) {
        drawResultsScreen(L);
        return;
    }

    // Boss victory screen
    if (L.bossDefeated) {
        drawVictoryScreen(L);
        return;
    }

    // Fail banner
    if (L.failed) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(0, CANVAS_HEIGHT / 2 - 28, CANVAS_WIDTH, 56);
        ctx.fillStyle = '#ff4444';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(BRAND.title, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 8);
        ctx.fillStyle = '#ff6666';
        ctx.font = 'bold 18px monospace';
        ctx.fillText('DEFEATED', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 16);
        ctx.textAlign = 'left';
    }
}

// ── Results Screen (Phase 2) ────────────────────────────────────
function drawResultsScreen(L) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    var cx2 = CANVAS_WIDTH / 2;
    var y = 30;

    ctx.fillStyle = '#00ff00';
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(BRAND.title, cx2, y);
    y += 24;

    ctx.fillStyle = '#fcfc00';
    ctx.font = 'bold 18px monospace';
    ctx.fillText('LEVEL COMPLETE!', cx2, y);
    y += 30;

    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    var lx = cx2 - 100;

    ctx.fillStyle = '#ffffff';
    ctx.fillText('Enemies defeated:', lx, y);
    ctx.textAlign = 'right';
    ctx.fillText(L.killCount + ' / ' + L.totalEnemies, cx2 + 100, y);
    y += 18;

    ctx.textAlign = 'left';
    ctx.fillText('Time:', lx, y);
    ctx.textAlign = 'right';
    var mins = Math.floor((L.elapsedTime || 0) / 60);
    var secs = Math.floor((L.elapsedTime || 0) % 60);
    ctx.fillText((mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs, cx2 + 100, y);
    y += 18;

    if (L.speedBonus > 0) {
        ctx.textAlign = 'left';
        ctx.fillStyle = '#44ff44';
        ctx.fillText('Speed bonus:', lx, y);
        ctx.textAlign = 'right';
        ctx.fillText('+' + L.speedBonus, cx2 + 100, y);
        y += 18;
    }

    if (L.noDamageBonus) {
        ctx.textAlign = 'left';
        ctx.fillStyle = '#ff44ff';
        ctx.fillText('No-damage bonus:', lx, y);
        ctx.textAlign = 'right';
        ctx.fillText('x2', cx2 + 100, y);
        y += 18;
    }

    if (L.specialItemCollected && L.specialItem) {
        ctx.textAlign = 'left';
        ctx.fillStyle = L.specialItem.color;
        ctx.fillText('Special item:', lx, y);
        ctx.textAlign = 'right';
        ctx.fillText(L.specialItem.name, cx2 + 100, y);
        y += 18;
    }

    y += 8;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fcfc00';
    ctx.font = 'bold 12px monospace';
    ctx.fillText('Level total:', lx, y);
    ctx.textAlign = 'right';
    ctx.fillText(L.score.toLocaleString(), cx2 + 100, y);
    y += 20;

    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Running total:', lx, y);
    ctx.textAlign = 'right';
    ctx.fillText(game.progress.score.toLocaleString(), cx2 + 100, y);
    y += 30;

    if (L.resultsTimer > 0.5) {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#888888';
        ctx.font = '9px monospace';
        var blink2 = Math.floor(Date.now() / 500) % 2;
        if (blink2) ctx.fillText('PRESS ACTION TO CONTINUE', cx2, y);
    }
    ctx.textAlign = 'left';
}

// ── Score Board (Phase 3) ───────────────────────────────────────
function drawScoreBoard() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.92)';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    var cx2 = CANVAS_WIDTH / 2;
    var bw2 = 280, bh2 = 260;
    var bx2 = cx2 - bw2 / 2, by2 = 30;

    // NES-style border
    ctx.strokeStyle = '#fcfc00';
    ctx.lineWidth = 3;
    ctx.strokeRect(bx2, by2, bw2, bh2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.95)';
    ctx.fillRect(bx2 + 2, by2 + 2, bw2 - 4, bh2 - 4);

    ctx.fillStyle = '#fcfc00';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('HIGH SCORES', cx2, by2 + 22);

    ctx.font = '9px monospace';
    var hist = game.progress.scoreHistory;
    if (hist.length === 0) {
        ctx.fillStyle = '#666666';
        ctx.fillText('NO SCORES YET', cx2, by2 + 60);
    } else {
        for (var si4 = 0; si4 < Math.min(hist.length, 10); si4++) {
            var entry = hist[si4];
            var ey = by2 + 44 + si4 * 20;
            ctx.textAlign = 'left';
            ctx.fillStyle = si4 === 0 ? '#fcfc00' : '#ffffff';
            var rank = (si4 + 1) + '.';
            if (si4 + 1 < 10) rank = ' ' + rank;
            ctx.fillText(rank, bx2 + 14, ey);
            ctx.textAlign = 'right';
            ctx.fillText(entry.score.toLocaleString(), cx2 + 40, ey);
            ctx.fillStyle = '#888888';
            ctx.fillText(entry.date || '', bx2 + bw2 - 14, ey);
        }
    }

    // Current session score
    ctx.textAlign = 'center';
    ctx.fillStyle = '#44ff44';
    ctx.font = '9px monospace';
    ctx.fillText('Current: ' + game.progress.score.toLocaleString(), cx2, by2 + bh2 - 30);
    ctx.fillStyle = '#888888';
    ctx.font = '8px monospace';
    ctx.fillText('Items: ' + Object.keys(game.progress.collectedItems).length + '/10  Galleries: ' + Object.keys(game.progress.galleriesVisited).length, cx2, by2 + bh2 - 14);

    ctx.fillStyle = '#555555';
    ctx.font = '8px monospace';
    var blink4 = Math.floor(Date.now() / 500) % 2;
    if (blink4) ctx.fillText('PRESS H OR ACTION TO CLOSE', cx2, by2 + bh2 + 16);
    ctx.textAlign = 'left';
}

// ── Victory Screen (Phase 5) ────────────────────────────────────
function drawVictoryScreen(L) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.95)';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    var cx2 = CANVAS_WIDTH / 2;
    var y = 40;

    // Scrolling star field effect
    var t = L.victoryTimer;
    for (var si2 = 0; si2 < 30; si2++) {
        var sx3 = (seedHashRT('star' + si2) % CANVAS_WIDTH);
        var sy3 = ((seedHashRT('star' + si2 + 'y') % CANVAS_HEIGHT) + t * 20) % CANVAS_HEIGHT;
        ctx.fillStyle = 'rgba(255,255,255,' + (0.3 + Math.sin(t * 2 + si2) * 0.3) + ')';
        ctx.fillRect(sx3, sy3, 2, 2);
    }

    ctx.fillStyle = '#ff4444';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('TECHNODROME DESTROYED!', cx2, y);
    y += 30;

    ctx.fillStyle = '#fcfc00';
    ctx.font = 'bold 14px monospace';
    ctx.fillText('CONGRATULATIONS!', cx2, y);
    y += 24;

    ctx.fillStyle = '#ffffff';
    ctx.font = '10px monospace';
    ctx.fillText('Final Score: ' + game.progress.score.toLocaleString(), cx2, y);
    y += 20;
    ctx.fillText('Galleries Visited: ' + Object.keys(game.progress.galleriesVisited).length, cx2, y);
    y += 16;
    ctx.fillText('Items Collected: ' + Object.keys(game.progress.collectedItems).length + '/10', cx2, y);
    y += 24;

    ctx.fillStyle = '#44ff44';
    ctx.font = 'bold 12px monospace';
    ctx.fillText('THANK YOU FOR PLAYING!', cx2, y);
    y += 20;

    // Artist credits scroll
    if (t > 2.0) {
        ctx.fillStyle = '#888888';
        ctx.font = '8px monospace';
        var artistKeys = Object.keys(ARTISTS);
        var scrollY = y + (t - 2.0) * 15;
        for (var ai2 = 0; ai2 < Math.min(artistKeys.length, 20); ai2++) {
            var aY = y + ai2 * 12 - ((t - 2.0) * 10) % (artistKeys.length * 12);
            if (aY > y - 12 && aY < CANVAS_HEIGHT) {
                ctx.fillStyle = '#aaaaaa';
                ctx.fillText(ARTISTS[artistKeys[ai2]].name, cx2, aY);
            }
        }
    }

    if (t > 2.0) {
        ctx.fillStyle = '#888888';
        ctx.font = '9px monospace';
        var blink3 = Math.floor(Date.now() / 500) % 2;
        if (blink3) ctx.fillText('PRESS ACTION TO CONTINUE', cx2, CANVAS_HEIGHT - 20);
    }
    ctx.textAlign = 'left';
}

// ============================================
// START
// ============================================

function cleanStaleRegionCache() {
    var prefix = 'adminSync_region_';
    var regionIds = ['na', 'sa', 'eu', 'asia', 'oce'];
    for (var i = 0; i < regionIds.length; i++) {
        var key = prefix + regionIds[i];
        var stored = localStorage.getItem(key);
        if (!stored) continue;
        try {
            var parsed = JSON.parse(stored);
            if (!parsed || !parsed.world || !Array.isArray(parsed.terrainGrid) || parsed.terrainGrid.length < 10) {
                console.warn('Clearing stale region cache: ' + key);
                localStorage.removeItem(key);
            }
        } catch (e) {
            console.warn('Clearing invalid region cache: ' + key);
            localStorage.removeItem(key);
        }
    }
}

async function init() {
    cleanStaleRegionCache();
    loadSave();
    await loadBootData();
    await loadMap('data/regions/na.json');
    resizeCanvas();
    var spawnPos = findSpawnOnRoad();
    game.player.x = spawnPos.x;
    game.player.y = spawnPos.y;
    game.mode = 'REGION';
    game.currentRegionId = 'na';
    if (typeof MP !== 'undefined' && MP.sendSpawnPos) {
        var spTileX = Math.round(spawnPos.x / TILE_SIZE);
        var spTileY = Math.round(spawnPos.y / TILE_SIZE);
        MP.sendSpawnPos(spTileX, spTileY);
    }
    updateMobileActionVisibility();
    requestAnimationFrame(gameLoop);
    console.log(BRAND.title + ' v' + BRAND.version + ' — COWABUNGA! World ready, loading sprites...');

    loadPackRegistry().then(function() { return loadAllSprites(); }).then(function() {
        game.spritesReady = true;
        console.log('Sprites loaded.');
    });
}

if (!window.__ADMIN_MODE) init();
