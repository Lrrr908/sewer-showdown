// Spawn placement rules per zone type.
// All returned coords are clamped to bounds.

const fs = require('fs');
const path = require('path');
const { parseZoneId } = require('./zone_id');

const DATA_DIR    = path.join(__dirname, '..', '..', '..', 'data');
const REGIONS_DIR = path.join(DATA_DIR, 'regions');
const LEVELS_DIR  = path.join(DATA_DIR, 'levels');

const townCache  = new Map();
const levelCache = new Map();

function getSpawn(zoneId, boundsW, boundsH) {
  const centerX = Math.floor(boundsW / 2);
  const centerY = Math.floor(boundsH / 2);
  const parsed = parseZoneId(zoneId);
  if (!parsed) return clamp(centerX, centerY, boundsW, boundsH);

  if (parsed.type === 'world') {
    return clamp(centerX, centerY, boundsW, boundsH);
  }

  if (parsed.type === 'region') {
    const town = findTown(parsed.regionKey, parsed.instanceId);
    if (town && Number.isInteger(town.x) && Number.isInteger(town.y)) {
      return clamp(town.x, town.y, boundsW, boundsH);
    }
    return clamp(centerX, centerY, boundsW, boundsH);
  }

  if (parsed.type === 'level') {
    const sp = findLevelSpawn(parsed.levelId);
    if (sp && Number.isInteger(sp.x) && Number.isInteger(sp.y)) {
      return clamp(sp.x, sp.y, boundsW, boundsH);
    }
    return clamp(centerX, centerY, boundsW, boundsH);
  }

  return clamp(centerX, centerY, boundsW, boundsH);
}

function findTown(regionKey, instanceId) {
  let towns = townCache.get(regionKey);
  if (towns === undefined) {
    towns = loadTowns(regionKey);
    townCache.set(regionKey, towns);
  }
  if (!towns) return null;
  return towns.get(instanceId) || null;
}

function loadTowns(regionKey) {
  const filePath = path.join(REGIONS_DIR, regionKey + '.json');
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(data.towns)) return null;
    const map = new Map();
    for (const t of data.towns) {
      if (t.id && typeof t.id === 'string') {
        map.set(t.id, { x: t.x, y: t.y });
      }
    }
    return map;
  } catch {
    return null;
  }
}

function findLevelSpawn(levelId) {
  let sp = levelCache.get(levelId);
  if (sp !== undefined) return sp;
  sp = loadLevelSpawn(levelId);
  levelCache.set(levelId, sp);
  return sp;
}

function loadLevelSpawn(levelId) {
  const filePath = path.join(LEVELS_DIR, levelId + '.json');
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data.spawns && data.spawns.player) {
      return { x: data.spawns.player.x, y: data.spawns.player.y };
    }
    return null;
  } catch {
    return null;
  }
}

function clamp(x, y, w, h) {
  return {
    x: Math.max(0, Math.min(w - 1, x)),
    y: Math.max(0, Math.min(h - 1, y)),
  };
}

module.exports = { getSpawn };
