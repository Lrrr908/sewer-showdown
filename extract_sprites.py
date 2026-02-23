#!/usr/bin/env python3
"""
TMNT Sprite Extractor
Extracts individual sprites from NES sprite sheets
"""

from PIL import Image
import os

# Create output directory
OUTPUT_DIR = "sprites/extracted"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def remove_magenta_background(img):
    """Convert magenta (255,0,255) to transparent"""
    img = img.convert("RGBA")
    data = img.getdata()
    new_data = []
    for item in data:
        # Magenta background -> transparent
        if item[0] > 240 and item[1] < 20 and item[2] > 240:
            new_data.append((0, 0, 0, 0))
        else:
            new_data.append(item)
    img.putdata(new_data)
    return img

def extract_sprite(source_path, x, y, w, h, output_name, scale=1, remove_bg=True):
    """Extract a sprite from a sprite sheet"""
    img = Image.open(source_path)
    sprite = img.crop((x, y, x + w, y + h))
    
    if remove_bg:
        sprite = remove_magenta_background(sprite)
    
    if scale != 1:
        sprite = sprite.resize((w * scale, h * scale), Image.NEAREST)
    
    output_path = f"{OUTPUT_DIR}/{output_name}.png"
    sprite.save(output_path)
    print(f"Saved: {output_path} ({w}x{h})")
    return output_path

print("=" * 50)
print("EXTRACTING TMNT SPRITES")
print("=" * 50)

# ============================================
# EXTRACT FROM TURTLES.PNG
# ============================================
print("\n--- From turtles.png ---")
turtles = "sprites/turtles.png"

# Party Wagon - at the bottom of the sheet
extract_sprite(turtles, 848, 194, 48, 24, "party_wagon_right", scale=2)
extract_sprite(turtles, 896, 194, 48, 24, "party_wagon_left", scale=2)
extract_sprite(turtles, 944, 186, 32, 32, "party_wagon_front", scale=2)

# Turtle faces/portraits (bottom left area)
extract_sprite(turtles, 0, 406, 32, 32, "leonardo_face", scale=2)
extract_sprite(turtles, 32, 406, 32, 32, "raphael_face", scale=2)
extract_sprite(turtles, 64, 406, 32, 32, "michelangelo_face", scale=2)
extract_sprite(turtles, 96, 406, 32, 32, "donatello_face", scale=2)

# Standing turtles
extract_sprite(turtles, 0, 0, 16, 32, "turtle_stand_1", scale=2)

# ============================================
# EXTRACT FROM AREA1.PNG (OVERWORLD)
# ============================================
print("\n--- From area1.png ---")
area1 = "sprites/area1.png"

# Buildings with windows
extract_sprite(area1, 96, 48, 32, 32, "building_1", scale=1, remove_bg=False)
extract_sprite(area1, 128, 48, 32, 32, "building_2", scale=1, remove_bg=False)
extract_sprite(area1, 160, 48, 32, 32, "building_3", scale=1, remove_bg=False)
extract_sprite(area1, 192, 48, 32, 32, "building_4", scale=1, remove_bg=False)

# Road tiles
extract_sprite(area1, 64, 176, 16, 16, "road_1", scale=2, remove_bg=False)
extract_sprite(area1, 80, 176, 16, 16, "road_2", scale=2, remove_bg=False)
extract_sprite(area1, 96, 176, 16, 16, "road_3", scale=2, remove_bg=False)

# Water tiles
extract_sprite(area1, 0, 0, 32, 32, "water_1", scale=1, remove_bg=False)
extract_sprite(area1, 0, 96, 32, 32, "water_2", scale=1, remove_bg=False)

# Sewer/manhole
extract_sprite(area1, 208, 128, 16, 16, "sewer", scale=2, remove_bg=False)

# ============================================
# EXTRACT FROM ITEMS.PNG
# ============================================
print("\n--- From items.png ---")
items = "sprites/items.png"

# Pizza!
extract_sprite(items, 0, 0, 16, 16, "pizza", scale=2)

# Weapons
extract_sprite(items, 16, 0, 16, 16, "weapon_1", scale=2)
extract_sprite(items, 32, 0, 16, 16, "weapon_2", scale=2)

# ============================================
# EXTRACT FROM ENEMIES.PNG
# ============================================
print("\n--- From enemies.png ---")
enemies = "sprites/enemies.png"

# Foot soldiers (first row after header)
extract_sprite(enemies, 0, 64, 24, 32, "foot_soldier_1", scale=2)
extract_sprite(enemies, 24, 64, 24, 32, "foot_soldier_2", scale=2)

# ============================================
# EXTRACT FROM TITLE.PNG
# ============================================
print("\n--- From title.png ---")
title = "sprites/title.png"

# TMNT Logo (US version)
extract_sprite(title, 260, 40, 200, 48, "tmnt_logo", scale=1, remove_bg=False)

# ============================================
# EXTRACT FROM SHREDDER.PNG
# ============================================
print("\n--- From shredder.png ---")
shredder = "sprites/shredder.png"

# Shredder on TV - first frame
extract_sprite(shredder, 0, 0, 128, 160, "shredder_tv_1", scale=1, remove_bg=False)

print("\n" + "=" * 50)
print(f"DONE! Sprites saved to: {OUTPUT_DIR}/")
print("=" * 50)

# List extracted files
print("\nExtracted sprites:")
for f in sorted(os.listdir(OUTPUT_DIR)):
    img = Image.open(f"{OUTPUT_DIR}/{f}")
    print(f"  {f}: {img.size[0]}x{img.size[1]}")
