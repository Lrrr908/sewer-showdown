#!/usr/bin/env python3
"""
osm_to_region.py - Generate asia.json from OpenStreetMap data via Overpass API.

Queries real building footprints, road networks, and landmarks for Asian cities,
then converts them into the game's NES tile format.
"""

import json, math, os, sys, time, urllib.request, urllib.parse

BASE = os.path.dirname(os.path.abspath(__file__))
OVERPASS_MIRRORS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
OVERPASS_URL = OVERPASS_MIRRORS[0]

# ── Region grid settings ──────────────────────────────────────────
REGION_W = 140
REGION_H = 110
TILE_SIZE = 64

# ── City definitions with real-world bounding boxes ───────────────
# Each city: id, label, tile position in region grid, lat/lon bbox, tier
CITIES = [
    {"id": "tokyo",     "label": "TOKYO",     "x": 118, "y": 55, "tier": "A", "radius": 8,
     "bbox": [35.62, 139.65, 35.75, 139.82], "landmarks_query": "Tokyo Tower|Senso-ji|Meiji Shrine|Tokyo Skytree"},
    {"id": "beijing",   "label": "BEIJING",   "x": 88,  "y": 38, "tier": "A", "radius": 8,
     "bbox": [39.85, 116.30, 39.98, 116.48], "landmarks_query": "Forbidden City|Temple of Heaven|Tiananmen"},
    {"id": "shanghai",  "label": "SHANGHAI",  "x": 95,  "y": 50, "tier": "A", "radius": 8,
     "bbox": [31.18, 121.42, 31.28, 121.52], "landmarks_query": "Oriental Pearl|Jin Mao Tower|The Bund"},
    {"id": "mumbai",    "label": "MUMBAI",    "x": 35,  "y": 68, "tier": "A", "radius": 8,
     "bbox": [18.90, 72.80, 19.05, 72.92], "landmarks_query": "Gateway of India|Taj Mahal Palace"},
    {"id": "delhi",     "label": "DELHI",     "x": 42,  "y": 55, "tier": "A", "radius": 8,
     "bbox": [28.55, 77.15, 28.68, 77.28], "landmarks_query": "Red Fort|India Gate|Qutub Minar"},
    {"id": "bangkok",   "label": "BANGKOK",   "x": 75,  "y": 72, "tier": "B", "radius": 6,
     "bbox": [13.70, 100.48, 13.78, 100.56], "landmarks_query": "Grand Palace|Wat Arun|Wat Pho"},
    {"id": "singapore", "label": "SINGAPORE", "x": 82,  "y": 85, "tier": "B", "radius": 6,
     "bbox": [1.27, 103.82, 1.32, 103.87], "landmarks_query": "Marina Bay Sands|Merlion"},
    {"id": "seoul",     "label": "SEOUL",     "x": 100, "y": 42, "tier": "A", "radius": 8,
     "bbox": [37.53, 126.92, 37.59, 127.02], "landmarks_query": "Gyeongbokgung|N Seoul Tower|Changdeokgung"},
    {"id": "dubai",     "label": "DUBAI",     "x": 25,  "y": 60, "tier": "B", "radius": 6,
     "bbox": [25.15, 55.22, 25.25, 55.32], "landmarks_query": "Burj Khalifa|Burj Al Arab"},
    {"id": "hongkong",  "label": "HONG KONG", "x": 92,  "y": 60, "tier": "A", "radius": 8,
     "bbox": [22.27, 114.13, 22.33, 114.20], "landmarks_query": "Victoria Peak|Star Ferry"},
    {"id": "taipei",    "label": "TAIPEI",    "x": 100, "y": 58, "tier": "B", "radius": 6,
     "bbox": [25.02, 121.50, 25.08, 121.58], "landmarks_query": "Taipei 101|Longshan Temple"},
    {"id": "manila",    "label": "MANILA",    "x": 105, "y": 75, "tier": "C", "radius": 4,
     "bbox": [14.55, 120.97, 14.61, 121.03], "landmarks_query": "Intramuros|Rizal Park"},
    {"id": "jakarta",   "label": "JAKARTA",   "x": 88,  "y": 92, "tier": "B", "radius": 6,
     "bbox": [-6.22, 106.80, -6.14, 106.88], "landmarks_query": "National Monument|Istiqlal Mosque"},
    {"id": "osaka",     "label": "OSAKA",     "x": 115, "y": 58, "tier": "B", "radius": 6,
     "bbox": [34.64, 135.46, 34.70, 135.54], "landmarks_query": "Osaka Castle|Dotonbori"},
]


def overpass_query(query_str):
    """Send a query to the Overpass API and return JSON."""
    data = urllib.parse.urlencode({"data": query_str}).encode("utf-8")
    req = urllib.request.Request(OVERPASS_URL, data=data)
    req.add_header("User-Agent", "TMNT-ArtShow-MapGen/1.0")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  Overpass query failed: {e}")
        return None


def query_city_data(city):
    """Query OSM data for a single city."""
    s, w, n, e = city["bbox"]
    bbox = f"{s},{w},{n},{e}"
    
    query = f"""
[out:json][timeout:30];
(
  way["building"]({bbox});
  way["highway"]({bbox});
  way["natural"="water"]({bbox});
  node["tourism"="attraction"]({bbox});
  node["amenity"="place_of_worship"]({bbox});
  way["building"="temple"]({bbox});
  way["building"="shrine"]({bbox});
  way["building"="mosque"]({bbox});
  way["building"="church"]({bbox});
);
out center tags;
"""
    return overpass_query(query)


def latlon_to_tile(lat, lon, city, city_radius):
    """Convert lat/lon to tile coordinates relative to the city center."""
    s, w, n, e = city["bbox"]
    center_lat = (s + n) / 2
    center_lon = (w + e) / 2
    
    lat_range = n - s
    lon_range = e - w
    
    # Map to tile grid: city area spans 2*radius tiles
    span = city_radius * 2
    dx = ((lon - center_lon) / lon_range) * span
    dy = -((lat - center_lat) / lat_range) * span  # flip Y
    
    tx = city["x"] + int(round(dx))
    ty = city["y"] + int(round(dy))
    return tx, ty


def classify_building(tags):
    """Classify an OSM building into a bg building kind."""
    building_type = tags.get("building", "yes")
    levels_str = tags.get("building:levels", "")
    height_str = tags.get("height", "")
    
    levels = 0
    if levels_str:
        try:
            levels = int(float(levels_str))
        except ValueError:
            pass
    
    height = 0
    if height_str:
        try:
            height = float(height_str.replace("m", "").strip())
        except ValueError:
            pass
    
    # Landmark building types
    if building_type in ("temple", "shrine"):
        return "temple"
    if building_type == "mosque":
        return "mosque"
    if building_type in ("church", "cathedral"):
        return "temple"
    
    # By height/levels
    if levels >= 10 or height >= 30:
        return "apt_tall"
    if levels >= 5 or height >= 15:
        return "office"
    if levels >= 3 or height >= 9:
        return "apt_small"
    
    # By type
    if building_type in ("commercial", "retail"):
        return "shopfront"
    if building_type in ("industrial", "warehouse"):
        return "warehouse_bg"
    if building_type in ("residential", "apartments"):
        return "apt_small"
    if building_type == "house":
        return "house"
    
    # Default heuristic: use a random-ish assignment based on position
    return "apt_small"


def classify_road(tags):
    """Classify an OSM highway into a game road type (1=street, 2=highway)."""
    highway = tags.get("highway", "")
    if highway in ("motorway", "motorway_link", "trunk", "trunk_link", "primary"):
        return 2
    if highway in ("secondary", "tertiary", "residential", "unclassified", "service", "living_street"):
        return 1
    if highway in ("primary_link", "secondary_link", "tertiary_link"):
        return 1
    return 0  # skip pedestrian, footway, cycleway, etc.


def process_city(city, osm_data):
    """Process OSM data for one city using tile-density approach."""
    if not osm_data or "elements" not in osm_data:
        print(f"  No data for {city['label']}")
        return [], [], []
    
    radius = city["radius"]
    
    # Accumulate per-tile: road counts, building counts/heights, landmarks
    tile_roads = {}      # (tx,ty) -> max road_type
    tile_buildings = {}   # (tx,ty) -> list of building kinds
    tile_bldg_heights = {} # (tx,ty) -> max height
    landmarks = []
    seen_landmarks = set()
    
    for elem in osm_data["elements"]:
        tags = elem.get("tags", {})
        lat = elem.get("lat") or (elem.get("center", {}) or {}).get("lat")
        lon = elem.get("lon") or (elem.get("center", {}) or {}).get("lon")
        if lat is None or lon is None:
            continue
        
        tx, ty = latlon_to_tile(lat, lon, city, radius)
        if tx < 0 or tx >= REGION_W or ty < 0 or ty >= REGION_H:
            continue
        
        tile_key = (tx, ty)
        
        # Roads: track highest road type per tile
        if "highway" in tags:
            road_type = classify_road(tags)
            if road_type > 0:
                tile_roads[tile_key] = max(tile_roads.get(tile_key, 0), road_type)
            continue
        
        # Notable landmarks (limit to a few per city)
        name = tags.get("name:en") or tags.get("name", "")
        is_landmark = (
            tags.get("tourism") == "attraction" or
            (tags.get("amenity") == "place_of_worship" and name) or
            tags.get("building") in ("temple", "shrine", "mosque")
        )
        if is_landmark and name and tile_key not in seen_landmarks and len(landmarks) < 8:
            lm_type = "temple"
            nl = name.lower()
            if "mosque" in nl or tags.get("building") == "mosque":
                lm_type = "mosque"
            elif "tower" in nl or "skytree" in nl or "101" in nl:
                lm_type = "tower"
            elif "palace" in nl or "castle" in nl or "forbidden" in nl:
                lm_type = "palace"
            elif "gate" in nl or "torii" in nl:
                lm_type = "gate"
            elif "monument" in nl or "memorial" in nl:
                lm_type = "monument"
            
            landmarks.append({
                "id": f"lm_osm_{city['id']}_{len(landmarks)}",
                "x": tx, "y": ty,
                "label": name[:20].upper(),
                "sprite": lm_type
            })
            seen_landmarks.add(tile_key)
            continue
        
        # Buildings: accumulate per tile
        if "building" in tags:
            kind = classify_building(tags)
            tile_buildings.setdefault(tile_key, []).append(kind)
            # Track max height for density classification
            h = 0
            try:
                h = float(tags.get("height", "0").replace("m", "").strip())
            except ValueError:
                pass
            try:
                lvl = int(float(tags.get("building:levels", "0")))
                h = max(h, lvl * 3)
            except ValueError:
                pass
            tile_bldg_heights[tile_key] = max(tile_bldg_heights.get(tile_key, 0), h)
    
    # Only keep major roads (highways, primary) from OSM as explicit roadTiles.
    # The game's town expansion (Phase 4) auto-generates internal city streets.
    roads = []
    for (tx, ty), rtype in tile_roads.items():
        if rtype >= 2:  # Only highways/major roads
            roads.append({"x": tx, "y": ty, "type": rtype})
    
    road_tiles = set(tile_roads.keys())
    
    # Build a height/density map for the city area from OSM data.
    # This tells us what building type to place on each tile.
    height_map = {}  # (tx,ty) -> estimated building height in meters
    density_map = {} # (tx,ty) -> number of OSM buildings on this tile
    type_map = {}    # (tx,ty) -> special building type if any
    
    for (tx, ty), kinds in tile_buildings.items():
        density_map[(tx, ty)] = len(kinds)
        height_map[(tx, ty)] = tile_bldg_heights.get((tx, ty), 0)
        for k in kinds:
            if k in ("temple", "mosque"):
                type_map[(tx, ty)] = k
                break
        if (tx, ty) not in type_map:
            for k in kinds:
                if k == "shopfront":
                    type_map[(tx, ty)] = k
                    break
    
    # Compute city-wide stats for fallback estimation
    all_heights = list(tile_bldg_heights.values())
    avg_height = sum(all_heights) / max(1, len(all_heights)) if all_heights else 6
    max_height_city = max(all_heights) if all_heights else 15
    
    # Generate buildings for ALL non-road tiles within expanded city area.
    # The game generates road grids inside towns, so we use a block-size
    # pattern to skip tiles that will become streets.
    buildings = []
    cx, cy = city["x"], city["y"]
    r = radius
    block_size = 5  # matches game's town expansion blockSize
    
    for dx in range(-r - 2, r + 3):
        for dy in range(-r - 2, r + 3):
            tx, ty = cx + dx, cy + dy
            if tx < 0 or tx >= REGION_W or ty < 0 or ty >= REGION_H:
                continue
            
            # Skip tiles that will become streets from town expansion
            # The game creates 2-wide streets at intervals of blockSize
            local_x = dx + r
            local_y = dy + r
            is_street = False
            street_pos = [-r]
            sp = -r + block_size
            while sp < r:
                street_pos.append(sp)
                sp += block_size
            street_pos.append(r)
            for spos in street_pos:
                if dx == spos or dx == spos + 1 or dy == spos or dy == spos + 1:
                    is_street = True
                    break
            if is_street:
                continue
            
            tile_key = (tx, ty)
            if tile_key in seen_landmarks:
                continue
            
            # Determine building kind from OSM data
            dist = math.sqrt(dx * dx + dy * dy)
            if dist > r + 2:
                continue
            
            if tile_key in density_map:
                # Have real OSM data
                h = height_map.get(tile_key, 0)
                count = density_map[tile_key]
                special = type_map.get(tile_key)
                
                if special in ("temple", "mosque"):
                    kind = special
                elif h >= 50:
                    kind = "apt_tall"
                elif h >= 25 or count >= 15:
                    kind = "apt_tall"
                elif h >= 12 or count >= 8:
                    kind = "office"
                elif special == "shopfront":
                    kind = "shopfront"
                elif count >= 3:
                    kind = "apt_small"
                else:
                    kind = "house"
            else:
                # Infer from distance to center and city stats
                if dist <= r * 0.25:
                    kind = "apt_tall"
                elif dist <= r * 0.5:
                    kind = "office" if max_height_city > 20 else "apt_small"
                elif dist <= r * 0.75:
                    kind = "apt_small"
                else:
                    kind = "house" if (abs(dx) + abs(dy)) % 3 != 0 else "shopfront"
            
            buildings.append({"x": tx, "y": ty, "kind": kind})
    
    return roads, buildings, landmarks


def generate_terrain_grid(existing_json):
    """Keep the existing terrain grid (coastlines, water, land, mountains)."""
    return existing_json.get("terrainGrid", [])


def main():
    # Load existing asia.json for terrain grid baseline
    asia_path = os.path.join(BASE, "data", "regions", "asia.json")
    with open(asia_path) as f:
        existing = json.load(f)
    
    terrain_grid = generate_terrain_grid(existing)
    
    # Keep existing infrastructure
    existing_river = existing.get("river", [])
    existing_districts = existing.get("districts", [])
    
    all_roads = []
    all_bg_buildings = []
    all_landmarks = []
    road_set = set()
    building_set = set()
    
    # Keep existing highway road tiles (type 2 intercity connections)
    for r in existing.get("roadTiles", []):
        if r.get("type", 1) == 2:
            key = (r["x"], r["y"])
            if key not in road_set:
                all_roads.append(r)
                road_set.add(key)
    
    print(f"Starting with {len(all_roads)} existing highway tiles")
    
    # Keep existing landmarks (blimp ports etc.)
    for lm in existing.get("landmarks", []):
        if lm["id"].startswith("lm_blimp_") or lm["id"] == "lm_start":
            all_landmarks.append(lm)
    
    # Query each city
    for i, city in enumerate(CITIES):
        print(f"\n[{i+1}/{len(CITIES)}] Querying {city['label']}...")
        
        osm_data = query_city_data(city)
        
        if osm_data:
            n_elements = len(osm_data.get("elements", []))
            print(f"  Got {n_elements} OSM elements")
        
        roads, buildings, landmarks = process_city(city, osm_data)
        
        # Add roads (dedup by tile)
        for r in roads:
            key = (r["x"], r["y"])
            if key not in road_set:
                all_roads.append(r)
                road_set.add(key)
        
        # Add buildings (dedup by tile)
        for b in buildings:
            key = (b["x"], b["y"])
            if key not in building_set and key not in road_set:
                all_bg_buildings.append(b)
                building_set.add(key)
        
        # Add landmarks
        all_landmarks.extend(landmarks)
        
        print(f"  Added: {len(roads)} roads, {len(buildings)} buildings, {len(landmarks)} landmarks")
        
        # Rate limit: Overpass API asks for 1 request per second
        if i < len(CITIES) - 1:
            print("  Waiting for rate limit...")
            time.sleep(2)
    
    # Keep existing building placements (artist galleries)
    existing_placements = existing.get("buildingPlacements", [])
    
    # Rebuild towns list with updated radii
    towns = []
    for city in CITIES:
        towns.append({
            "id": city["id"],
            "x": city["x"],
            "y": city["y"],
            "label": city["label"],
            "pattern": "grid3",
            "radius": city["radius"],
            "tier": city["tier"],
            "artists": [],
            "mainStreetAxis": "h",
            "profile": "metro",
            "density": 5 if city["tier"] == "A" else (4 if city["tier"] == "B" else 3)
        })
    
    # Build the output
    output = {
        "world": {
            "widthTiles": REGION_W,
            "heightTiles": REGION_H,
            "tileSize": TILE_SIZE
        },
        "terrainGrid": terrain_grid,
        "towns": towns,
        "buildingPlacements": existing_placements,
        "river": existing_river,
        "districts": existing_districts,
        "landmarks": all_landmarks,
        "roadTiles": all_roads,
        "bgBuildings": all_bg_buildings
    }
    
    # Write compact JSON
    with open(asia_path, "w") as f:
        json.dump(output, f, separators=(",", ":"))
    
    file_size = os.path.getsize(asia_path)
    print(f"\n{'='*60}")
    print(f"Asia region generated:")
    print(f"  Roads:      {len(all_roads)}")
    print(f"  Buildings:  {len(all_bg_buildings)}")
    print(f"  Landmarks:  {len(all_landmarks)}")
    print(f"  Towns:      {len(towns)}")
    print(f"  File size:  {file_size:,} bytes")
    print(f"  Output:     {asia_path}")


if __name__ == "__main__":
    main()
