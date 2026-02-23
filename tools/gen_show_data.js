// tools/gen_show_data.js
// Generates data/artists.json, data/buildings.json, data/map.json
// Usage: node tools/gen_show_data.js

const fs = require('fs');
const path = require('path');

const HANDLES = `
21.daze
2ndtimearoundtoysandcomics
3dsorcery
9to5warriors
al.tres.de
ale_jediknigth
andy_makes_stuff
andrare_official
attempts_were_made1
artebotetano
arthurgreem
aurelio_mazzara
bad_chad
bastardsofthemultiverse
black.omen.design
blood.empire
blueleederdesigns
bootlegtoyco
bygabozeta
captaincozmic84
castle_clayskull
charliescustomtoyshop
cronest_customs
dafoot_toys
dano_brown
digitalhorseplay
dresease
dungeon_sweeper
duzmachines84
eddieanaya_
elcustomweno
emberswist
epoxy_crusader
erinfist
fanguygrams
flellotoys
frans_labyrinth85
gabrieleduardoart
goingturtlecrazy83
gorehoundztoys
hobotoyz
ikin_619
inmortal.studio
invisiblemike89
james_overstreet_imagery
jimmyfolklore
joshuahfx
kevycoldcuts
kriptorrata
lamatitamuscaria
lazyrobots
left_hand_freak
lrh_bootlegs
mannycartoonstudio
markocomix
morehorrific
nick_nightmare_studios
ninjatoitles
nuke.tan
nxtsndyad
oneiromancytoyworks
plastic_flashback
polyboxcg
powderghg
poy_son
rbl3d
recyclegalaxy
remy1353
rultron
rusty_bucket_ink
sanfordarts_bad_chad
sebastiangomeztoys
shellshockedstudio
sickemil
sincitycustomcreations
sir.one.collectibles
slimecitytoys
snztoys
stilarts
tarcacreations
the.retro.saint
theadultnerd
theoriginalcashbrand
thetmntcollector
tndtoybox
tmnt_tcg
tomski_figures
vileconsumption
whackonaut
`.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);

function makeId(handle) {
  return handle.toLowerCase().replaceAll('.', '_');
}

function makeDisplayName(handle) {
  return handle
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

// --- Region assignment ---
// Default all to 'na'. Override specific artists by handle below.
// Sources: Instagram bios, personal websites, Etsy shops, interviews, event listings.
// Key: na=North America, sa=South/Central America+Mexico, eu=Europe, asia=Asia, oce=Oceania
const REGION_OVERRIDES = {
  // ── South America / Latin America / Mexico ──
  'al.tres.de':            'sa',    // Latin America (Spanish-language handle/content)
  'ale_jediknigth':        'sa',    // Latin America (Spanish name + content context)
  'artebotetano':          'sa',    // South America
  'bygabozeta':            'sa',    // South America
  'elcustomweno':          'sa',    // Latin America (Spanish handle)
  'gabrieleduardoart':     'sa',    // South America
  'inmortal.studio':       'sa',    // Latin America (Spanish handle)
  'kriptorrata':           'sa',    // Latin America (Spanish handle)
  'lamatitamuscaria':      'sa',    // South America
  'rultron':               'sa',    // South America
  'sebastiangomeztoys':    'sa',    // South America (Spanish name)
  'tarcacreations':        'sa',    // South America
  'sickemil':              'sa',    // Emilio Subirá — Mexico City, Mexico

  // ── Europe ──
  'aurelio_mazzara':       'eu',    // Italian name — Europe
  'cronest_customs':       'eu',    // Europe
  'markocomix':            'eu',    // Europe
  'stilarts':              'eu',    // Europe
  'flellotoys':            'eu',    // Southport, England, UK
  'the.retro.saint':       'eu',    // UK (prices in GBP, .co.uk domain)
  'digitalhorseplay':      'eu',    // Josh Williams — England, UK
  'lazyrobots':            'eu',    // Austria
  // 'frans_labyrinth85':   'eu',    // (unconfirmed — needs manual check)

  // ── Asia ──
  'nuke.tan':              'asia',  // Asia

  // ── Oceania ──
  // (none confirmed yet — use regionIdOverride in artists.json for manual fixes)

  // ── North America (confirmed, not just default) ──
  // bootlegtoyco:         Covington, Kentucky (stays na by default)
  // sir.one.collectibles: Boston, Massachusetts (stays na by default)
  // dano_brown:           Chicago, Illinois (stays na by default)
  // slimecitytoys:        Quebec, Canada (stays na by default)
  // oneiromancytoyworks:  Chicago, Illinois (stays na by default)
  // joshuahfx:            Halifax, Canada (stays na by default)
  // ikin_619:             San Diego area (619 area code) (stays na by default)
  // sincitycustomcreations: Las Vegas (stays na by default)
};

const VALID_REGIONS = new Set(['na', 'sa', 'eu', 'asia', 'oce']);

// --- Load artist locations (lat/lon from data/artist_locations.json) ---
const locationsPath = path.join(__dirname, '..', 'data', 'artist_locations.json');
let LOCATION_BY_HANDLE = {};
if (fs.existsSync(locationsPath)) {
  try {
    const locData = JSON.parse(fs.readFileSync(locationsPath, 'utf8'));
    if (Array.isArray(locData.locations)) {
      for (const loc of locData.locations) {
        if (loc.handle) LOCATION_BY_HANDLE[loc.handle] = loc;
      }
    }
    console.log(`Loaded ${Object.keys(LOCATION_BY_HANDLE).length} artist locations`);
  } catch (err) {
    console.warn('Could not load artist_locations.json:', err.message);
  }
} else {
  console.warn('No artist_locations.json found — artists will have null lat/lon');
}

// --- artists.json ---
const artists = HANDLES.map(h => {
  const generatedRegion = REGION_OVERRIDES[h] || 'na';
  if (!VALID_REGIONS.has(generatedRegion)) throw new Error(`Invalid region '${generatedRegion}' for handle '${h}'`);
  const loc = LOCATION_BY_HANDLE[h] || {};
  const lat = (typeof loc.lat === 'number') ? loc.lat : null;
  const lon = (typeof loc.lon === 'number') ? loc.lon : null;
  return {
    id: makeId(h),
    name: makeDisplayName(h),
    bio: "",
    instagram: `https://www.instagram.com/${h}/`,
    images: [],
    regionId: generatedRegion,
    regionIdOverride: null,
    lat: lat,
    lon: lon,
    city: loc.city || null,
    country: loc.country || null
  };
});

// --- buildings.json (no placement, just definitions) ---
const buildings = artists.map(a => ({
  id: `b_${a.id}`,
  artistId: a.id,
  buildingType: 'gallery',
  priority: 0
}));

// NOTE: Road/river/landmark generation for NA region has moved to tools/gen_region_na.js.
// This file now only generates artists.json, buildings.json, and stub region maps.

const dataDir    = path.join(__dirname, '..', 'data');
const regionsDir = path.join(dataDir, 'regions');
if (!fs.existsSync(regionsDir)) fs.mkdirSync(regionsDir, { recursive: true });

// --- artists.json ---
const artistsJson = { artists };

// --- buildings.json ---
const buildingsJson = {
  buildings,
  defaults: {
    collisionRect: { ox: -32, oy: -64, w: 128, h: 128 },
    enterRect:     { ox: -56, oy: -88, w: 176, h: 176 },
    exitRect:      { ox: -88, oy: -120, w: 240, h: 240 }
  }
};

// NOTE: world.json is generated by tools/gen_world_map.js (Natural Earth real geography).
// NOTE: na.json and map.json are generated by tools/gen_region_na.js (v3 real-geography pipeline).
// Do NOT regenerate those here. Run:
//   node tools/gen_world_map.js
//   node tools/gen_region_na.js

// Count artists per region
const regionCounts = {};
for (const a of artists) {
  const effectiveRegion = a.regionIdOverride || a.regionId;
  regionCounts[effectiveRegion] = (regionCounts[effectiveRegion] || 0) + 1;
}

// Stub region maps for regions with no artists yet
const STUB_REGION_W = 30;
const STUB_REGION_H = 20;
function makeStubRegion(regionId) {
  return {
    world: { widthTiles: STUB_REGION_W, heightTiles: STUB_REGION_H, tileSize: 64 },
    buildingPlacements: [],
    districts: [{ id: 'default', y0: 0, y1: STUB_REGION_H - 1 }],
    landmarks: [{ id: 'lm_start', x: 1, y: 1, label: 'START', sprite: null }],
    roads: [],
    river: []
  };
}

// Write data files (artists + buildings only; region maps are separate generators)
fs.writeFileSync(path.join(dataDir, 'artists.json'), JSON.stringify(artistsJson, null, 2) + '\n');
fs.writeFileSync(path.join(dataDir, 'buildings.json'), JSON.stringify(buildingsJson, null, 2) + '\n');
// Stub region maps for non-NA regions
fs.writeFileSync(path.join(regionsDir, 'sa.json'), JSON.stringify(makeStubRegion('sa'), null, 2) + '\n');
fs.writeFileSync(path.join(regionsDir, 'eu.json'), JSON.stringify(makeStubRegion('eu'), null, 2) + '\n');
fs.writeFileSync(path.join(regionsDir, 'asia.json'), JSON.stringify(makeStubRegion('asia'), null, 2) + '\n');
fs.writeFileSync(path.join(regionsDir, 'oce.json'), JSON.stringify(makeStubRegion('oce'), null, 2) + '\n');

// Location stats
const locatedCount = artists.filter(a => a.lat !== null).length;
console.log(`Written: ${artists.length} artists (${locatedCount} with lat/lon), ${buildings.length} buildings`);
console.log(`  Region distribution: ${Object.entries(regionCounts).map(([k,v]) => k + ':' + v).join(', ')}`);
console.log(`  Files: artists.json, buildings.json, regions/{sa,eu,asia,oce}.json`);
console.log(`  NOTE: na.json/map.json generated by: node tools/gen_region_na.js`);
