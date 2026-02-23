// js/shared/building_fp.js — Building footprints (single source of truth)
// Consumed by: server collision, client collision, client render, generator.
// Anchor convention: SW (x,y is bottom-left of footprint).

var KIND_FP = Object.freeze({
  mall:        Object.freeze({ w: 4, h: 2 }),
  warehouse:   Object.freeze({ w: 4, h: 2 }),
  gas_station: Object.freeze({ w: 4, h: 2 }),
  apt_tall:    Object.freeze({ w: 2, h: 2 }),
  apt_med:     Object.freeze({ w: 2, h: 2 }),
  apt_small:   Object.freeze({ w: 1, h: 1 }),
  shop:        Object.freeze({ w: 2, h: 2 }),
  fastfood:    Object.freeze({ w: 2, h: 2 }),
  pizza:       Object.freeze({ w: 2, h: 2 })
});

var DEFAULT_FP = Object.freeze({ w: 1, h: 1 });

/**
 * Resolve footprint for a building entry.
 * Payload fp field wins, then KIND_FP lookup, then DEFAULT_FP.
 * If b.rotated is truthy and the footprint is non-square, swap w and h.
 */
function resolveFP(b) {
  if (b.fp && typeof b.fp.w === 'number' && typeof b.fp.h === 'number') return b.fp;
  var fp = KIND_FP[b.kind] || DEFAULT_FP;
  if (b.rotated && fp.w !== fp.h) return { w: fp.h, h: fp.w };
  return fp;
}

/**
 * Get the tile rectangle occupied by a building (SW anchor).
 * Returns { x0, y0, w, h } where (x0,y0) is top-left corner.
 */
function getFootprintRect(b) {
  var fp = resolveFP(b);
  return {
    x0: b.x,
    y0: b.y - (fp.h - 1),
    w:  fp.w,
    h:  fp.h
  };
}

if (typeof module !== 'undefined') module.exports = {
  KIND_FP: KIND_FP, DEFAULT_FP: DEFAULT_FP,
  resolveFP: resolveFP, getFootprintRect: getFootprintRect
};
