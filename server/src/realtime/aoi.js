// AOI grid for spatial partitioning.
// Positions are tile-integer coordinates. Cell size is AOI_CELL_SIZE_TILES.

const config = require('../config');

const CELL = config.AOI_CELL_SIZE_TILES;

function cellKey(cx, cy) { return cx + ',' + cy; }

// Tile-integer position -> AOI cell.
// tileSize param kept for compatibility (always 1 in tile-int mode).
function posToCell(tileX, tileY, tileSize) {
  const tx = tileSize === 1 ? tileX : Math.floor(tileX / tileSize);
  const ty = tileSize === 1 ? tileY : Math.floor(tileY / tileSize);
  return { cx: Math.floor(tx / CELL), cy: Math.floor(ty / CELL) };
}

function neighborCells(cx, cy) {
  const cells = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      cells.push(cellKey(cx + dx, cy + dy));
    }
  }
  return cells;
}

class AOIGrid {
  constructor() {
    this.cells = new Map();
    this.playerCells = new Map();
  }

  addPlayer(playerId, cx, cy) {
    const key = cellKey(cx, cy);
    this.playerCells.set(playerId, key);
    if (!this.cells.has(key)) this.cells.set(key, new Set());
    this.cells.get(key).add(playerId);
  }

  removePlayer(playerId) {
    const key = this.playerCells.get(playerId);
    if (key && this.cells.has(key)) {
      this.cells.get(key).delete(playerId);
      if (this.cells.get(key).size === 0) this.cells.delete(key);
    }
    this.playerCells.delete(playerId);
  }

  movePlayer(playerId, cx, cy) {
    const newKey = cellKey(cx, cy);
    const oldKey = this.playerCells.get(playerId);
    if (oldKey === newKey) return null;
    const [oldCx, oldCy] = oldKey ? oldKey.split(',').map(Number) : [cx, cy];
    this.removePlayer(playerId);
    this.addPlayer(playerId, cx, cy);
    return { oldCx, oldCy, newCx: cx, newCy: cy };
  }

  getNeighborPlayers(cx, cy, excludeId) {
    const players = [];
    const keys = neighborCells(cx, cy);
    for (const k of keys) {
      const set = this.cells.get(k);
      if (!set) continue;
      for (const pid of set) {
        if (pid !== excludeId) players.push(pid);
      }
    }
    return players;
  }

  getVisiblePlayers(playerId) {
    const key = this.playerCells.get(playerId);
    if (!key) return [];
    const [cx, cy] = key.split(',').map(Number);
    return this.getNeighborPlayers(cx, cy, playerId);
  }
}

module.exports = { AOIGrid, posToCell, cellKey, neighborCells, CELL };
