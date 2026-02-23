#!/usr/bin/env python3
"""
Urban Planning Generator v2 for na.json.

Fixes over v1:
  A) Bridges: highways/arterials can cross narrow water on straight spans.
  B) No broad mountain flattening — limited grading only within block interiors.
  C) Minimum block size enforced (small fragments become parks).
  D) Lot generation: sidewalk strip + rectangular parcels + buildings in lots.
  E) Road-class-sensitive zoning (industrial near highway, commercial at
     arterial corners, residential on local streets).

Road topology pipeline:
  - Build 1-tile centerline graph with conn_mask bitmask.
  - Expand to 2-tile surface with CONSISTENT widening direction.
  - Vertical segments widen EAST, horizontal widen SOUTH.
  - Corners/T/4-way fill 2×2 core.
  - Output roadGraph (centerlines) + roadTiles (surface) separately.

Run:  python3 scripts/urban_plan.py
"""

import json, math, heapq, os, random
from collections import deque, defaultdict

SEED = 42
random.seed(SEED)

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION — all magic constants centralized here
# ═══════════════════════════════════════════════════════════════════════════════

# Terrain
OCEAN, COAST, LAND, MOUNTAIN, RIVER = 0, 1, 2, 3, 4
WATER = {OCEAN, RIVER}
NO_BUILD = {OCEAN, COAST, RIVER}  # tiles where buildings must not be placed

# A* costs
COST_LAND     = 1
COST_MOUNTAIN = 3
COST_BRIDGE   = 12      # crossing bridgeable water
MAX_BRIDGE_SPAN = 6     # max tiles of straight water crossing

ROAD_TURN_PENALTY = 12  # A* penalty for changing direction — keeps roads straight

# Road widths (centerline is always 1; surface expansion handled separately)
# These control A* path widening for the centerline itself
HIGHWAY_CENTER_W  = 1   # centerlines are always 1-tile; surface expansion does 2-tile

# Urban area radius = town.radius * multiplier
URBAN_MULT = {'A': 3.5, 'B': 2.5, 'C': 2.0}

# Local street grid spacing (tiles between parallel streets)
PROFILE_SPACING = {
    'downtown': 10, 'metro': 10,
    'arts_district': 12, 'tourist': 12,
    'suburb': 16, 'industrial': 14,
}
DEFAULT_SPACING = 12

# Ring road: only for downtown/metro profiles
RING_ROAD_PROFILES = {'downtown', 'metro'}
RING_ROAD_FRACTION = 0.8  # at 80% of urban radius

# Block sizing
MIN_BLOCK_AREA = 16     # blocks smaller than this become park/open space

# Lot geometry
SIDEWALK_DEPTH = 1      # tiles of sidewalk between road and lot
LOT_DEPTH      = 3      # tiles deep from sidewalk edge into block interior
BLDG_GAP       = 1      # base gap between visual edges of buildings

# Per-kind footprint in tiles (w, h). Must match js/shared/building_fp.js KIND_FP.
# Anchor: SW — (x,y) is bottom-left of the footprint rectangle.
# Footprint rect occupies tiles [x..x+w-1, y-h+1..y].
KIND_FP = {
    'mall':        (4, 2),
    'warehouse':   (4, 2),
    'gas_station': (4, 2),
    'apt_tall':    (2, 2),
    'apt_med':     (2, 2),
    'apt_small':   (1, 1),
    'shop':        (2, 2),
    'fastfood':    (2, 2),
    'pizza':       (2, 2),
}
DEFAULT_FP = (1, 1)

# Zoning thresholds
ZONE_HWY_DIST    = 4    # tiles from highway/arterial → industrial
ZONE_WATER_DIST  = 4    # tiles from water → industrial
ZONE_CENTER_FRAC = 0.35 # inner fraction → commercial
ZONE_MID_FRAC    = 0.70 # middle fraction → residential; rest → sparse

# Building pools per zone
ZONE_BUILDINGS = {
    'commercial':  [('mall', 2), ('shop', 5), ('fastfood', 2), ('pizza', 2), ('apt_tall', 2)],
    'industrial':  [('warehouse', 5), ('gas_station', 3), ('shop', 1)],
    'residential': [('apt_med', 5), ('apt_small', 6), ('shop', 1)],
    'sparse':      [('apt_small', 3), ('gas_station', 1)],
}
FILL_RATIO = {'commercial': 0.45, 'industrial': 0.30, 'residential': 0.30, 'sparse': 0.12}

# Floor ranges per zone (min, max). Actual value interpolated by distance-to-center.
ZONE_FLOOR_RANGE = {
    'commercial':  (1, 8),
    'industrial':  (1, 2),
    'residential': (1, 5),
    'sparse':      (1, 1),
}
# Downtown bonus: buildings in the inner 25% of the urban area get extra floors
DOWNTOWN_BONUS_FRAC = 0.25
DOWNTOWN_MAX_FLOORS = 40

# Corner upgrade types
CORNER_TYPES = ['mall', 'shop', 'gas_station']

# Rotation: non-square footprints can be rotated (swaps w/h) for variety
NON_SQUARE_KINDS = {k for k, (w, h) in KIND_FP.items() if w != h}
ROTATE_CHANCE = 0.45

# Conn mask bits
N, E, S, W_BIT = 1, 2, 4, 8

# ═══════════════════════════════════════════════════════════════════════════════
# PATHS
# ═══════════════════════════════════════════════════════════════════════════════

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_PATH  = os.path.join(SCRIPT_DIR, '..', 'data', 'regions', 'na.json')
BUILDINGS_JSON = os.path.join(SCRIPT_DIR, '..', 'data', 'buildings.json')

# ═══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

DIRS4 = [(0,-1),(1,0),(0,1),(-1,0)]  # N E S W
DIR_BITS = [N, E, S, W_BIT]

def in_bounds(x, y, W, H):
    return 0 <= x < W and 0 <= y < H

def dist(ax, ay, bx, by):
    return math.sqrt((ax - bx)**2 + (ay - by)**2)

def manhattan(ax, ay, bx, by):
    return abs(ax - bx) + abs(ay - by)

def pick_weighted(pool, rng):
    total = sum(w for _, w in pool)
    r = rng.random() * total
    for item, w in pool:
        r -= w
        if r <= 0:
            return item
    return pool[-1][0]

def astar(sx, sy, ex, ey, W, H, cost_fn, turn_penalty=0):
    start, goal = (sx, sy), (ex, ey)
    if turn_penalty <= 0:
        g = {start: 0}
        heap = [(manhattan(sx, sy, ex, ey), start)]
        came = {}
        while heap:
            _, cur = heapq.heappop(heap)
            if cur == goal:
                path = []
                while cur in came:
                    path.append(cur)
                    cur = came[cur]
                path.append(start)
                path.reverse()
                return path
            cx, cy = cur
            for dx, dy in DIRS4:
                nx, ny = cx + dx, cy + dy
                if not in_bounds(nx, ny, W, H):
                    continue
                c = cost_fn(nx, ny)
                if c is None:
                    continue
                ng = g[cur] + c
                npos = (nx, ny)
                if npos not in g or ng < g[npos]:
                    g[npos] = ng
                    came[npos] = cur
                    heapq.heappush(heap, (ng + manhattan(nx, ny, ex, ey), npos))
        return None
    # Direction-aware A* — penalise turns to produce straight roads
    init = (sx, sy, -1)
    g = {init: 0}
    heap = [(manhattan(sx, sy, ex, ey), init)]
    came = {}
    while heap:
        _, cur = heapq.heappop(heap)
        cx, cy, cd = cur
        if (cx, cy) == goal:
            path = []
            while cur in came:
                path.append((cur[0], cur[1]))
                cur = came[cur]
            path.append(start)
            path.reverse()
            return path
        for di, (dx, dy) in enumerate(DIRS4):
            nx, ny = cx + dx, cy + dy
            if not in_bounds(nx, ny, W, H):
                continue
            c = cost_fn(nx, ny)
            if c is None:
                continue
            penalty = turn_penalty if (cd >= 0 and di != cd) else 0
            ng = g[cur] + c + penalty
            nstate = (nx, ny, di)
            if nstate not in g or ng < g[nstate]:
                g[nstate] = ng
                came[nstate] = cur
                heapq.heappush(heap, (ng + manhattan(nx, ny, ex, ey), nstate))
    return None

def prim_mst(nodes, edge_cost_fn):
    if len(nodes) < 2:
        return []
    edges = []
    in_tree = {0}
    heap = []
    for j in range(1, len(nodes)):
        heapq.heappush(heap, (edge_cost_fn(nodes[0], nodes[j]), 0, j))
    while heap and len(in_tree) < len(nodes):
        cost, i, j = heapq.heappop(heap)
        if j in in_tree:
            continue
        in_tree.add(j)
        edges.append((i, j))
        for k in range(len(nodes)):
            if k not in in_tree:
                heapq.heappush(heap, (edge_cost_fn(nodes[j], nodes[k]), j, k))
    return edges

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 1: LOAD
# ═══════════════════════════════════════════════════════════════════════════════

def load():
    with open(DATA_PATH) as f:
        data = json.load(f)
    terrain = data['terrainGrid']
    H, W = len(terrain), len(terrain[0])
    return data, terrain, W, H

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 2: WATER MASK + BRIDGE CANDIDATE DETECTION
# ═══════════════════════════════════════════════════════════════════════════════

def build_water_and_bridges(terrain, W, H):
    water = set()
    for y in range(H):
        for x in range(W):
            if terrain[y][x] in WATER:
                water.add((x, y))

    bridgeable = set()
    for wy in range(H):
        for wx in range(W):
            if (wx, wy) not in water:
                continue
            # Horizontal crossing: scan east from first water tile in a gap
            if wx == 0 or (wx - 1, wy) not in water:
                span = []
                nx = wx
                while nx < W and (nx, wy) in water:
                    span.append((nx, wy))
                    nx += 1
                if nx < W and 1 <= len(span) <= MAX_BRIDGE_SPAN:
                    if wx > 0:
                        for t in span:
                            bridgeable.add(t)
            # Vertical crossing: scan south from first water tile in a gap
            if wy == 0 or (wx, wy - 1) not in water:
                span = []
                ny = wy
                while ny < H and (wx, ny) in water:
                    span.append((wx, ny))
                    ny += 1
                if ny < H and 1 <= len(span) <= MAX_BRIDGE_SPAN:
                    if wy > 0:
                        for t in span:
                            bridgeable.add(t)

    print(f"  water: {len(water)}, bridgeable water: {len(bridgeable)}")
    return water, bridgeable

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 3: HIGHWAY SPINE
# ═══════════════════════════════════════════════════════════════════════════════

def make_cost_fn(terrain, water, bridgeable, allow_bridges):
    def cost(x, y):
        if (x, y) in water:
            if allow_bridges and (x, y) in bridgeable:
                return COST_BRIDGE
            return None
        t = terrain[y][x]
        if t in (LAND, COAST):
            return COST_LAND
        if t == MOUNTAIN:
            return COST_MOUNTAIN
        return None
    return cost

def generate_highways(terrain, towns, water, bridgeable, W, H):
    centerlines = set()
    tier_a = [t for t in towns if t.get('tier') == 'A']
    if len(tier_a) < 2:
        tier_a = sorted(towns, key=lambda t: -t.get('density', 0))[:5]

    cost_fn = make_cost_fn(terrain, water, bridgeable, True)
    sorted_x = sorted(tier_a, key=lambda t: t['x'])
    sorted_y = sorted(tier_a, key=lambda t: t['y'])

    def connect_chain(chain):
        for i in range(len(chain) - 1):
            a, b = chain[i], chain[i + 1]
            path = astar(a['x'], a['y'], b['x'], b['y'], W, H, cost_fn, ROAD_TURN_PENALTY)
            if path:
                centerlines.update(path)

    # East-West corridor
    if len(sorted_x) >= 2:
        connect_chain(sorted_x)
    # North-South corridor
    if len(sorted_y) >= 2:
        connect_chain(sorted_y)

    print(f"  highway centerlines: {len(centerlines)}")
    return centerlines

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 4: ARTERIAL MST + CROSS-LINKS
# ═══════════════════════════════════════════════════════════════════════════════

def generate_arterials(terrain, towns, highway_cl, water, bridgeable, W, H):
    centerlines = set()

    def cost(x, y):
        if (x, y) in highway_cl:
            return 0.5
        if (x, y) in water:
            if (x, y) in bridgeable:
                return COST_BRIDGE
            return None
        t = terrain[y][x]
        if t in (LAND, COAST):
            return COST_LAND
        if t == MOUNTAIN:
            return COST_MOUNTAIN + 1
        return None

    def edge_cost(a, b):
        return dist(a['x'], a['y'], b['x'], b['y'])

    edges = prim_mst(towns, edge_cost)

    # 20% extra cross-links for loops
    mst_set = {(min(i, j), max(i, j)) for i, j in edges}
    extra = max(1, len(edges) // 5)
    pairs = []
    for i in range(len(towns)):
        for j in range(i + 1, len(towns)):
            if (i, j) not in mst_set and edge_cost(towns[i], towns[j]) < 40:
                pairs.append((edge_cost(towns[i], towns[j]), i, j))
    pairs.sort()
    added = 0
    for _, i, j in pairs:
        if added >= extra:
            break
        edges.append((i, j))
        mst_set.add((min(i, j), max(i, j)))
        added += 1

    for i, j in edges:
        a, b = towns[i], towns[j]
        path = astar(a['x'], a['y'], b['x'], b['y'], W, H, cost, ROAD_TURN_PENALTY)
        if path:
            centerlines.update(path)

    centerlines -= highway_cl  # deduplicate
    print(f"  arterial centerlines: {len(centerlines)} ({len(edges)} edges)")
    return centerlines

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 5: LOCAL STREET GRIDS (profile-aware, no universal ring roads)
# ═══════════════════════════════════════════════════════════════════════════════

def generate_local_streets(terrain, towns, major_cl, water, W, H):
    centerlines = set()

    for t in towns:
        tier = t.get('tier', 'C')
        mult = URBAN_MULT.get(tier, 2.0)
        r = t.get('radius', 3) * mult
        profile = t.get('profile', 'suburb')
        spacing = PROFILE_SPACING.get(profile, DEFAULT_SPACING)
        cx, cy = t['x'], t['y']
        r2 = r * r

        x0, x1 = max(0, int(cx - r)), min(W - 1, int(cx + r))
        y0, y1 = max(0, int(cy - r)), min(H - 1, int(cy + r))

        # Grid anchor: snap to nearest major road or town center
        ax, ay = cx, cy
        for rx, ry in major_cl:
            if abs(rx - cx) <= 2 and abs(ry - cy) <= 2:
                ax, ay = rx, ry
                break

        # Horizontal streets
        y = ay - ((ay - y0) // spacing) * spacing
        while y <= y1:
            if y >= y0:
                for x in range(x0, x1 + 1):
                    if (x - cx)**2 + (y - cy)**2 <= r2:
                        if (x, y) not in water and terrain[y][x] != OCEAN:
                            centerlines.add((x, y))
            y += spacing

        # Vertical streets
        x = ax - ((ax - x0) // spacing) * spacing
        while x <= x1:
            if x >= x0:
                for y in range(y0, y1 + 1):
                    if (x - cx)**2 + (y - cy)**2 <= r2:
                        if (x, y) not in water and terrain[y][x] != OCEAN:
                            centerlines.add((x, y))
            x += spacing

        # Ring road only for downtown/metro
        if profile in RING_ROAD_PROFILES:
            rr = r * RING_ROAD_FRACTION
            rr2_lo, rr2_hi = (rr - 1)**2, (rr + 1)**2
            for y in range(y0, y1 + 1):
                for x in range(x0, x1 + 1):
                    d2 = (x - cx)**2 + (y - cy)**2
                    if rr2_lo <= d2 <= rr2_hi:
                        if (x, y) not in water and terrain[y][x] != OCEAN:
                            centerlines.add((x, y))

    centerlines -= major_cl  # no overlap with highways/arterials
    print(f"  local centerlines: {len(centerlines)}")
    return centerlines

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 6: CENTERLINE GRAPH → conn_mask
# ═══════════════════════════════════════════════════════════════════════════════

def build_centerline_graph(highway_cl, arterial_cl, local_cl, W, H):
    """Compute conn_mask for each centerline tile and classify."""
    all_cl = highway_cl | arterial_cl | local_cl
    graph = {}
    for x, y in all_cl:
        mask = 0
        for i, (dx, dy) in enumerate(DIRS4):
            if (x + dx, y + dy) in all_cl:
                mask |= DIR_BITS[i]
        cls = 'highway' if (x, y) in highway_cl else 'arterial' if (x, y) in arterial_cl else 'local'
        graph[(x, y)] = {'class': cls, 'mask': mask}
    print(f"  centerline graph: {len(graph)} tiles")
    return graph

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 7: 2-TILE SURFACE EXPANSION (consistent widening)
# ═══════════════════════════════════════════════════════════════════════════════

def expand_surface(graph, W, H):
    """Expand centerlines to 2-tile surface.
    Vertical (only N/S bits) → widen EAST.
    Horizontal (only E/W bits) → widen SOUTH.
    Mixed (corner/T/4-way) → fill 2×2 core."""
    surface = {}  # (x,y) -> class

    for (cx, cy), info in graph.items():
        mask = info['mask']
        cls = info['class']
        has_ns = bool(mask & (N | S))
        has_ew = bool(mask & (E | W_BIT))

        tiles = [(cx, cy)]
        if has_ns and has_ew:
            tiles = [(cx, cy), (cx + 1, cy), (cx, cy + 1), (cx + 1, cy + 1)]
        elif has_ns:
            tiles = [(cx, cy), (cx + 1, cy)]
        elif has_ew:
            tiles = [(cx, cy), (cx, cy + 1)]
        else:
            tiles = [(cx, cy), (cx + 1, cy)]

        for tx, ty in tiles:
            if in_bounds(tx, ty, W, H):
                existing = surface.get((tx, ty))
                if existing is None or _class_priority(cls) > _class_priority(existing):
                    surface[(tx, ty)] = cls

    print(f"  surface tiles: {len(surface)}")
    return surface

def _class_priority(cls):
    return {'highway': 3, 'arterial': 2, 'local': 1}.get(cls, 0)

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 8: LIMITED TERRAIN GRADING
# ═══════════════════════════════════════════════════════════════════════════════

def limited_grading(terrain, block_tiles_all, surface, W, H):
    """Flatten mountains ONLY within block interiors and road surface."""
    graded = 0
    for x, y in block_tiles_all:
        if terrain[y][x] == MOUNTAIN:
            terrain[y][x] = LAND
            graded += 1
    for (x, y) in surface:
        if in_bounds(x, y, W, H) and terrain[y][x] == MOUNTAIN:
            terrain[y][x] = LAND
            graded += 1
    print(f"  graded {graded} mountain tiles → LAND")
    return terrain

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 9: BLOCK IDENTIFICATION + MIN SIZE
# ═══════════════════════════════════════════════════════════════════════════════

def identify_blocks(surface, terrain, water, W, H, towns):
    road_set = set(surface.keys())

    # Urban mask
    urban = set()
    for t in towns:
        tier = t.get('tier', 'C')
        r = t.get('radius', 3) * URBAN_MULT.get(tier, 2.0)
        cx, cy = t['x'], t['y']
        r2 = r * r
        for dy in range(int(-r) - 1, int(r) + 2):
            for dx in range(int(-r) - 1, int(r) + 2):
                nx, ny = cx + dx, cy + dy
                if in_bounds(nx, ny, W, H) and dx * dx + dy * dy <= r2:
                    urban.add((nx, ny))

    visited = set()
    blocks, parks = [], []

    for sy in range(H):
        for sx in range(W):
            pos = (sx, sy)
            if pos in visited or pos in road_set or pos in water or pos not in urban:
                continue
            if terrain[sy][sx] in NO_BUILD:
                continue
            block = []
            q = deque([pos])
            visited.add(pos)
            while q:
                cx, cy = q.popleft()
                block.append((cx, cy))
                for dx, dy in DIRS4:
                    np = (cx + dx, cy + dy)
                    if np in visited or np in road_set or np in water or np not in urban:
                        continue
                    if not in_bounds(np[0], np[1], W, H) or terrain[np[1]][np[0]] in NO_BUILD:
                        continue
                    visited.add(np)
                    q.append(np)

            if len(block) >= MIN_BLOCK_AREA:
                blocks.append(block)
            elif len(block) >= 3:
                parks.append(block)

    total_block = sum(len(b) for b in blocks)
    print(f"  blocks: {len(blocks)} ({total_block} tiles, avg {total_block // max(len(blocks), 1)})")
    print(f"  parks/fragments: {len(parks)} ({sum(len(p) for p in parks)} tiles)")
    return blocks, parks

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 10: CLASSIFY BLOCKS (road-class-sensitive zoning)
# ═══════════════════════════════════════════════════════════════════════════════

def classify_blocks(blocks, towns, surface, water, W, H):
    highway_set = {(x, y) for (x, y), c in surface.items() if c == 'highway'}
    arterial_set = {(x, y) for (x, y), c in surface.items() if c == 'arterial'}
    road_set = set(surface.keys())

    classified = []
    for block in blocks:
        cx = sum(x for x, y in block) / len(block)
        cy = sum(y for x, y in block) / len(block)

        nearest_town, nearest_dist = None, float('inf')
        for t in towns:
            d = dist(cx, cy, t['x'], t['y'])
            if d < nearest_dist:
                nearest_dist = d
                nearest_town = t
        if not nearest_town:
            classified.append(('sparse', block, None))
            continue

        # Separate highway vs arterial distance for road-class-sensitive zoning
        min_hwy = min((manhattan(bx, by, hx, hy)
                        for bx, by in block for hx, hy in highway_set), default=999)
        min_art = min((manhattan(bx, by, ax, ay)
                        for bx, by in block for ax, ay in arterial_set), default=999)

        min_water = 999
        for bx, by in block:
            for ddx, ddy in DIRS4:
                for step in range(1, ZONE_WATER_DIST + 2):
                    nx, ny = bx + ddx * step, by + ddy * step
                    if (nx, ny) in water:
                        min_water = min(min_water, step)
                        break

        tier = nearest_town.get('tier', 'C')
        urban_r = nearest_town.get('radius', 3) * URBAN_MULT.get(tier, 2.0)
        rel_dist = nearest_dist / max(urban_r, 1)

        # Road-class-sensitive zoning:
        #   Industrial: highway-adjacent AND waterfront (port/warehouse)
        #   Commercial: arterial-adjacent or inner-town
        #   Residential: local-street blocks in middle ring
        #   Sparse: outer ring
        if min_hwy <= 2 and min_water <= ZONE_WATER_DIST:
            zone_type = 'industrial'
        elif min_art <= 3 or rel_dist <= ZONE_CENTER_FRAC:
            zone_type = 'commercial'
        elif rel_dist <= ZONE_MID_FRAC:
            zone_type = 'residential'
        else:
            zone_type = 'sparse'

        # Corner upgrade: arterial-corner blocks → commercial
        if zone_type not in ('industrial', 'commercial'):
            for bx, by in block:
                adj_dirs = set()
                for i, (dx, dy) in enumerate(DIRS4):
                    np = (bx + dx, by + dy)
                    if np in arterial_set or np in highway_set:
                        adj_dirs.add(i % 2)
                if len(adj_dirs) >= 2:
                    zone_type = 'commercial'
                    break

        classified.append((zone_type, block, nearest_town))

    counts = defaultdict(int)
    for z, _, _ in classified:
        counts[z] += 1
    print(f"  zoning: {dict(counts)}")
    return classified

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 11: LOT GENERATION + BUILDING PLACEMENT
# ═══════════════════════════════════════════════════════════════════════════════

def effective_fp(kind, rotated=False):
    """Return (w, h) for a building kind, swapping dimensions if rotated."""
    fw, fh = KIND_FP.get(kind, DEFAULT_FP)
    if rotated and kind in NON_SQUARE_KINDS:
        return (fh, fw)
    return (fw, fh)

def fp_rect(x, y, kind, rotated=False):
    """Return the set of tiles occupied by footprint (SW anchor)."""
    fw, fh = effective_fp(kind, rotated)
    tiles = set()
    for dy in range(fh):
        for dx in range(fw):
            tiles.add((x + dx, y - dy))
    return tiles

def fp_expanded(x, y, kind, gap, rotated=False):
    """Return footprint expanded by `gap` tiles on all sides (for spacing check)."""
    fw, fh = effective_fp(kind, rotated)
    tiles = set()
    for dy in range(-gap, fh + gap):
        for dx in range(-gap, fw + gap):
            tiles.add((x + dx, y - dy))
    return tiles

def can_place(x, y, kind, terrain, road_set, water, occupied, W, H, rotated=False):
    """Check if a building can be placed at (x,y) with SW anchor."""
    fw, fh = effective_fp(kind, rotated)
    for dy in range(fh):
        for dx in range(fw):
            tx, ty = x + dx, y - dy
            if not in_bounds(tx, ty, W, H):
                return False
            if (tx, ty) in road_set or (tx, ty) in water:
                return False
            if terrain[ty][tx] in NO_BUILD:
                return False
            if (tx, ty) in occupied:
                return False
    # Check gap: expanded footprint must not overlap any occupied tile
    for dy in range(-BLDG_GAP, fh + BLDG_GAP):
        for dx in range(-BLDG_GAP, fw + BLDG_GAP):
            if 0 <= dx < fw and 0 <= dy < fh:
                continue  # skip the footprint itself
            tx, ty = x + dx, y - dy
            if (tx, ty) in occupied:
                return False
    return True

def assign_floors(zone_type, bx, by, nearest_town, rng):
    """Assign a floor count based on zone and proximity to town center."""
    fmin, fmax = ZONE_FLOOR_RANGE.get(zone_type, (1, 1))
    if not nearest_town:
        return rng.randint(fmin, fmax)

    tx, ty = nearest_town['x'], nearest_town['y']
    tier = nearest_town.get('tier', 'C')
    urban_r = nearest_town.get('radius', 3) * URBAN_MULT.get(tier, 2.0)
    d = math.sqrt((bx - tx) ** 2 + (by - ty) ** 2)
    rel = d / max(urban_r, 1)

    if rel < DOWNTOWN_BONUS_FRAC and tier in ('A', 'B'):
        closeness = 1.0 - (rel / DOWNTOWN_BONUS_FRAC)
        floor_max = int(fmax + closeness * (DOWNTOWN_MAX_FLOORS - fmax))
        return rng.randint(max(fmin, floor_max // 2), floor_max)

    closeness = max(0.0, 1.0 - rel)
    floors = fmin + int(closeness * (fmax - fmin))
    return max(fmin, rng.randint(fmin, max(fmin, floors)))

def generate_lots_and_buildings(classified, surface, terrain, water, W, H, rng, artist_occupied=None):
    road_set = set(surface.keys())
    buildings = []
    occupied = set(artist_occupied) if artist_occupied else set()

    for zone_type, block, nearest_town in classified:
        if not block or zone_type not in ZONE_BUILDINGS:
            continue

        block_set = set(block)

        # Compute distance-to-road for each tile
        dist_to_road = {}
        for bx, by in block:
            min_d = 999
            for dx, dy in DIRS4:
                if (bx + dx, by + dy) in road_set:
                    min_d = 1
                    break
            if min_d > 1:
                for bx2, by2 in block:
                    for dx, dy in DIRS4:
                        if (bx2 + dx, by2 + dy) in road_set:
                            d = manhattan(bx, by, bx2, by2)
                            min_d = min(min_d, d + 1)
            dist_to_road[(bx, by)] = min_d

        # Partition: sidewalk / lot / interior
        sidewalk = set()
        lot_tiles = []
        interior = []
        for bx, by in block:
            d = dist_to_road[(bx, by)]
            if d <= SIDEWALK_DEPTH:
                sidewalk.add((bx, by))
            elif d <= SIDEWALK_DEPTH + LOT_DEPTH:
                lot_tiles.append((bx, by))
            else:
                interior.append((bx, by))

        # Determine facing for each lot tile (toward nearest road)
        lot_facing = {}
        for bx, by in lot_tiles:
            for i, (dx, dy) in enumerate(DIRS4):
                # Walk outward until we hit road
                step = 1
                while step <= SIDEWALK_DEPTH + 2:
                    nx, ny = bx + dx * step, by + dy * step
                    if (nx, ny) in road_set:
                        lot_facing[(bx, by)] = ['n', 'e', 's', 'w'][i]
                        break
                    step += 1
                if (bx, by) in lot_facing:
                    break

        # Place buildings in lots using footprint-aware gap checking
        pool = ZONE_BUILDINGS[zone_type]
        fill = FILL_RATIO.get(zone_type, 0.2)
        max_bld = max(1, int(len(lot_tiles) * fill))
        count = 0

        candidates = sorted(lot_tiles, key=lambda p: dist_to_road[p])
        for bx, by in candidates:
            if count >= max_bld:
                break
            if (bx, by) in occupied:
                continue

            kind = pick_weighted(pool, rng)
            rotated = kind in NON_SQUARE_KINDS and rng.random() < ROTATE_CHANCE
            if not can_place(bx, by, kind, terrain, road_set, water, occupied, W, H, rotated):
                continue

            rect = fp_rect(bx, by, kind, rotated)
            occupied |= rect
            facing = lot_facing.get((bx, by), 's')
            entry = {
                'x': bx, 'y': by,
                'kind': kind,
                'colorVariant': rng.randint(0, 5),
                'zone': zone_type,
                'facing': facing,
                'floors': assign_floors(zone_type, bx, by, nearest_town, rng),
            }
            if rotated:
                entry['rotated'] = True
            buildings.append(entry)
            count += 1

        # Sparse interior fill
        if interior and zone_type == 'sparse':
            for bx, by in interior[:max(1, len(interior) // 10)]:
                if (bx, by) in occupied:
                    continue
                kind = pick_weighted(pool, rng)
                rotated = kind in NON_SQUARE_KINDS and rng.random() < ROTATE_CHANCE
                if not can_place(bx, by, kind, terrain, road_set, water, occupied, W, H, rotated):
                    continue
                rect = fp_rect(bx, by, kind, rotated)
                occupied |= rect
                entry = {
                    'x': bx, 'y': by,
                    'kind': kind,
                    'colorVariant': rng.randint(0, 5),
                    'zone': zone_type,
                    'facing': 's',
                    'floors': assign_floors(zone_type, bx, by, nearest_town, rng),
                }
                if rotated:
                    entry['rotated'] = True
                buildings.append(entry)

    # Corner upgrades: buildings at road intersections get commercial types,
    # but only if the new footprint fits without overlapping.
    upgraded = 0
    for b in buildings:
        bx, by = b['x'], b['y']
        was_rotated = b.get('rotated', False)
        adj_dirs = set()
        for i, (dx, dy) in enumerate(DIRS4):
            for step in range(1, SIDEWALK_DEPTH + 2):
                nx, ny = bx + dx * step, by + dy * step
                if (nx, ny) in road_set:
                    adj_dirs.add(i % 2)
                    break
        if len(adj_dirs) >= 2 and b['zone'] != 'industrial':
            if b['kind'] not in CORNER_TYPES:
                new_kind = rng.choice(CORNER_TYPES)
                new_rotated = new_kind in NON_SQUARE_KINDS and rng.random() < ROTATE_CHANCE
                old_rect = fp_rect(bx, by, b['kind'], was_rotated)
                test_occupied = occupied - old_rect
                if can_place(bx, by, new_kind, terrain, road_set, water, test_occupied, W, H, new_rotated):
                    occupied -= old_rect
                    b['kind'] = new_kind
                    if new_rotated:
                        b['rotated'] = True
                    elif 'rotated' in b:
                        del b['rotated']
                    new_rect = fp_rect(bx, by, new_kind, new_rotated)
                    occupied |= new_rect
                    upgraded += 1

    print(f"  buildings: {len(buildings)}, corner upgrades: {upgraded}")
    return buildings

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 10.5: ARTIST BUILDING PLACEMENT
# ═══════════════════════════════════════════════════════════════════════════════

ARTIST_FP_KIND = 'shop'
ARTIST_MIN_SPACING = 3

def place_artist_buildings(data, classified, surface, terrain, water, W, H, towns, rng):
    """Place artist buildings on valid lot tiles using the urban planning grid.

    Reads artist-to-town assignments from na.json towns[].artists and
    building IDs from data/buildings.json. Places each artist building on a
    lot tile near its assigned town, using the same can_place / fp_rect
    checks as bgBuildings.

    Returns (placements_list, occupied_tiles_set).
    """
    road_set = set(surface.keys())

    # Load building definitions to map artist ID -> building ID
    artist_to_bid = {}
    try:
        with open(BUILDINGS_JSON) as f:
            bdata = json.load(f)
        for bdef in bdata.get('buildings', []):
            aid = bdef.get('artistId')
            if aid:
                artist_to_bid[aid] = bdef['id']
    except Exception as e:
        print(f"  WARNING: could not load {BUILDINGS_JSON}: {e}")
        return [], set()

    # Gather artist-to-town mapping from towns[].artists
    town_artists = {}  # town_index -> [buildingId, ...]
    unassigned = []
    for ti, t in enumerate(towns):
        arts = t.get('artists', [])
        bids = []
        for a_handle in arts:
            # Artist handles in towns use dots; building IDs use underscores
            normalized = a_handle.replace('.', '_')
            bid = artist_to_bid.get(a_handle) or artist_to_bid.get(normalized)
            if bid:
                bids.append(bid)
            else:
                unassigned.append(a_handle)
        if bids:
            town_artists[ti] = bids

    if unassigned:
        print(f"  {len(unassigned)} artist handles without building defs (skipped)")

    # Find artists in buildings.json not assigned to any town — spread them across towns
    all_assigned_bids = set()
    for bids in town_artists.values():
        all_assigned_bids.update(bids)
    leftover_bids = [bid for bid in artist_to_bid.values() if bid not in all_assigned_bids]
    if leftover_bids:
        rng.shuffle(leftover_bids)
        town_indices = sorted(town_artists.keys()) or list(range(len(towns)))
        if not town_indices:
            town_indices = list(range(min(len(towns), 10)))
        for i, bid in enumerate(leftover_bids):
            ti = town_indices[i % len(town_indices)]
            if ti not in town_artists:
                town_artists[ti] = []
            town_artists[ti].append(bid)
        print(f"  {len(leftover_bids)} unassigned artists distributed across {len(town_indices)} towns")

    # Build block lookup: for each classified block, know its tiles and nearest town
    town_blocks = defaultdict(list)  # town_index -> [(zone, block_tiles)]
    for zone_type, block, nearest_town in classified:
        if not nearest_town:
            continue
        for ti, t in enumerate(towns):
            if t['x'] == nearest_town['x'] and t['y'] == nearest_town['y']:
                town_blocks[ti].append((zone_type, block))
                break

    # Compute distance-to-road for candidate scoring
    def tile_road_dist(tx, ty):
        for step in range(1, 6):
            for ddx, ddy in DIRS4:
                if (tx + ddx * step, ty + ddy * step) in road_set:
                    return step
        return 99

    placements = []
    occupied = set()
    placed_bids = set()

    for ti, bids in town_artists.items():
        t = towns[ti]
        cx, cy = t['x'], t['y']

        # Collect candidate tiles from this town's blocks (prefer commercial)
        candidates = []
        for zone_type, block in town_blocks.get(ti, []):
            zone_prio = {'commercial': 3, 'residential': 2, 'industrial': 1, 'sparse': 0}.get(zone_type, 0)
            for bx, by in block:
                if (bx, by) in road_set or (bx, by) in water:
                    continue
                if terrain[by][bx] in NO_BUILD:
                    continue
                rd = tile_road_dist(bx, by)
                if rd > 4:
                    continue
                d_center = abs(bx - cx) + abs(by - cy)
                score = zone_prio * 100 + (10 - min(rd, 10)) * 10 - d_center
                candidates.append((score, bx, by))

        candidates.sort(key=lambda c: -c[0])

        for bid in bids:
            if bid in placed_bids:
                continue
            placed = False
            for _, bx, by in candidates:
                if (bx, by) in occupied:
                    continue
                # Check spacing from other placed artist buildings
                too_close = False
                for px, py, _ in placements:
                    if abs(bx - px) + abs(by - py) < ARTIST_MIN_SPACING:
                        too_close = True
                        break
                if too_close:
                    continue
                if not can_place(bx, by, ARTIST_FP_KIND, terrain, road_set, water, occupied, W, H):
                    continue

                rect = fp_rect(bx, by, ARTIST_FP_KIND)
                occupied |= rect
                placements.append((bx, by, bid))
                placed_bids.add(bid)
                placed = True
                break

            if not placed:
                # Fallback: try placing near town center on any valid land tile
                for radius in range(2, 20):
                    if placed:
                        break
                    for ddx in range(-radius, radius + 1):
                        if placed:
                            break
                        for ddy in range(-radius, radius + 1):
                            if abs(ddx) != radius and abs(ddy) != radius:
                                continue
                            fx, fy = cx + ddx, cy + ddy
                            if not in_bounds(fx, fy, W, H):
                                continue
                            if (fx, fy) in road_set or (fx, fy) in water or (fx, fy) in occupied:
                                continue
                            if terrain[fy][fx] in NO_BUILD:
                                continue
                            too_close = False
                            for px, py, _ in placements:
                                if abs(fx - px) + abs(fy - py) < ARTIST_MIN_SPACING:
                                    too_close = True
                                    break
                            if too_close:
                                continue
                            if can_place(fx, fy, ARTIST_FP_KIND, terrain, road_set, water, occupied, W, H):
                                rect = fp_rect(fx, fy, ARTIST_FP_KIND)
                                occupied |= rect
                                placements.append((fx, fy, bid))
                                placed_bids.add(bid)
                                placed = True
                                break

            if not placed:
                print(f"  WARNING: could not place {bid} near town {t.get('id','?')}")

    result = [{'buildingId': bid, 'x': x, 'y': y} for x, y, bid in placements]
    return result, occupied


# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 10.7: NEIGHBORHOOD FILL AROUND ARTIST BUILDINGS
# ═══════════════════════════════════════════════════════════════════════════════

NEIGHBORHOOD_RADIUS = 6
NEIGHBORHOOD_FILL = 0.35
NEIGHBORHOOD_POOL = [('shop', 4), ('apt_small', 5), ('apt_med', 2), ('fastfood', 1), ('pizza', 1)]

def fill_artist_neighborhoods(artist_placements, artist_occupied, surface, terrain, water, W, H, towns, rng):
    """Generate bgBuildings around artist building clusters so they have city context."""
    road_set = set(surface.keys())
    occupied = set(artist_occupied)
    buildings = []

    # Find nearest town for floor assignment
    def nearest_town_for(x, y):
        best, best_d = None, float('inf')
        for t in towns:
            d = abs(x - t['x']) + abs(y - t['y'])
            if d < best_d:
                best_d = d
                best = t
        return best

    # Collect all artist positions
    art_positions = [(p['x'], p['y']) for p in artist_placements]
    if not art_positions:
        return buildings, occupied

    for ax, ay in art_positions:
        # Scan neighborhood tiles
        candidates = []
        for dy in range(-NEIGHBORHOOD_RADIUS, NEIGHBORHOOD_RADIUS + 1):
            for dx in range(-NEIGHBORHOOD_RADIUS, NEIGHBORHOOD_RADIUS + 1):
                nx, ny = ax + dx, ay + dy
                if not in_bounds(nx, ny, W, H):
                    continue
                if (nx, ny) in road_set or (nx, ny) in water or (nx, ny) in occupied:
                    continue
                if terrain[ny][nx] in NO_BUILD:
                    continue
                d = abs(dx) + abs(dy)
                if d < 2:
                    continue
                # Score: prefer tiles near roads and close to artist building
                road_adj = any((nx+ddx, ny+ddy) in road_set for ddx, ddy in DIRS4)
                score = (10 if road_adj else 0) - d
                candidates.append((score, nx, ny))

        candidates.sort(key=lambda c: -c[0])
        target = max(1, int(len(candidates) * NEIGHBORHOOD_FILL))

        placed = 0
        for _, nx, ny in candidates:
            if placed >= target:
                break
            if (nx, ny) in occupied:
                continue
            kind = pick_weighted(NEIGHBORHOOD_POOL, rng)
            rotated = kind in NON_SQUARE_KINDS and rng.random() < ROTATE_CHANCE
            if not can_place(nx, ny, kind, terrain, road_set, water, occupied, W, H, rotated):
                continue
            rect = fp_rect(nx, ny, kind, rotated)
            occupied |= rect
            nt = nearest_town_for(nx, ny)
            entry = {
                'x': nx, 'y': ny,
                'kind': kind,
                'colorVariant': rng.randint(0, 5),
                'zone': 'commercial',
                'facing': 's',
                'floors': assign_floors('commercial', nx, ny, nt, rng),
            }
            if rotated:
                entry['rotated'] = True
            buildings.append(entry)
            placed += 1

    return buildings, occupied


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    print("═══ Urban Planning Generator v2 ═══\n")

    print("[1] Loading...")
    data, terrain, W, H = load()
    towns = data['towns']
    print(f"  map: {W}x{H}, towns: {len(towns)}")

    print("[2] Water mask + bridge detection...")
    water, bridgeable = build_water_and_bridges(terrain, W, H)

    print("[3] Highway spine (with bridges)...")
    highway_cl = generate_highways(terrain, towns, water, bridgeable, W, H)

    print("[4] Arterial MST + cross-links (with bridges)...")
    arterial_cl = generate_arterials(terrain, towns, highway_cl, water, bridgeable, W, H)

    print("[5] Local street grids (profile-aware)...")
    major_cl = highway_cl | arterial_cl
    local_cl = generate_local_streets(terrain, towns, major_cl, water, W, H)

    print("[6] Centerline graph + conn_mask...")
    graph = build_centerline_graph(highway_cl, arterial_cl, local_cl, W, H)

    print("[7] 2-tile surface expansion...")
    surface = expand_surface(graph, W, H)

    print("[9] Block identification...")
    blocks, parks = identify_blocks(surface, terrain, water, W, H, towns)

    all_block_tiles = set()
    for b in blocks:
        all_block_tiles.update(b)
    for p in parks:
        all_block_tiles.update(p)

    print("[8] Limited terrain grading (blocks + roads only)...")
    terrain = limited_grading(terrain, all_block_tiles, surface, W, H)

    print("[10] Block classification (road-class zoning)...")
    classified = classify_blocks(blocks, towns, surface, water, W, H)

    # ── Phase 10.5: Place artist buildings on valid lot tiles ──
    print("[10.5] Artist building placement...")
    rng_art = random.Random(SEED + 7)
    artist_placements, artist_occupied = place_artist_buildings(
        data, classified, surface, terrain, water, W, H, towns, rng_art
    )
    data['buildingPlacements'] = artist_placements
    print(f"  placed {len(artist_placements)} artist buildings ({len(artist_occupied)} tiles reserved)")

    # ── Phase 10.7: Neighborhood fill around artist buildings ──
    # Ensure artist buildings have surrounding city context
    print("[10.7] Artist neighborhood fill...")
    rng_fill = random.Random(SEED + 13)
    neighborhood_bldgs, artist_occupied = fill_artist_neighborhoods(
        artist_placements, artist_occupied, surface, terrain, water, W, H, towns, rng_fill
    )
    print(f"  generated {len(neighborhood_bldgs)} neighborhood buildings around artist clusters")

    print("[11] Lot generation + building placement...")
    rng = random.Random(SEED)
    bld_list = generate_lots_and_buildings(classified, surface, terrain, water, W, H, rng, artist_occupied)
    bld_list.extend(neighborhood_bldgs)

    # ── Build output arrays ──
    road_graph = []
    for (x, y), info in sorted(graph.items(), key=lambda p: (p[0][1], p[0][0])):
        road_graph.append({'x': x, 'y': y, 'class': info['class'], 'mask': info['mask']})

    road_tiles = []
    bridge_count = 0
    for (x, y), cls in sorted(surface.items(), key=lambda p: (p[0][1], p[0][0])):
        entry = {'x': x, 'y': y, 'class': cls}
        if (x, y) in water:
            entry['bridge'] = True
            bridge_count += 1
        road_tiles.append(entry)

    # ── Write ──
    print("\n[12] Writing na.json...")
    data['terrainGrid'] = terrain
    data['roadGraph'] = road_graph
    data['roadTiles'] = road_tiles
    data['bgBuildings'] = bld_list

    with open(DATA_PATH, 'w') as f:
        json.dump(data, f, separators=(',', ':'))

    fsize = os.path.getsize(DATA_PATH)
    print(f"  file: {fsize / 1024:.0f} KB")

    # ── Summary ──
    cls_count = defaultdict(int)
    for _, c in surface.items():
        cls_count[c] += 1
    zone_count = defaultdict(int)
    for b in bld_list:
        zone_count[b.get('zone', '?')] += 1
    kind_count = defaultdict(int)
    for b in bld_list:
        kind_count[b.get('kind', '?')] += 1
    rotated_count = sum(1 for b in bld_list if b.get('rotated'))

    print(f"\n═══ Summary ═══")
    print(f"  centerlines: {len(graph)} (hwy:{len(highway_cl)} art:{len(arterial_cl)} loc:{len(local_cl)})")
    print(f"  surface tiles: {len(surface)} ({dict(cls_count)})")
    print(f"  bridges: {bridge_count}")
    print(f"  blocks: {len(blocks)} (avg {sum(len(b) for b in blocks) // max(len(blocks),1)} tiles)")
    print(f"  buildings: {len(bld_list)} by zone: {dict(zone_count)}")
    print(f"  building kinds: {dict(kind_count)}")
    print(f"  rotated buildings: {rotated_count}")
    print(f"  grading: mountains flattened only in block/road areas")
    print()


if __name__ == '__main__':
    main()
