#!/usr/bin/env python3
"""Convert building PNG assets to JS pixel data arrays.

Quantizes each image to its core NES colors, then outputs
palette-indexed pixel data as a compact hex string.
"""

import os, sys, math
from PIL import Image

SRC_DIR = os.path.expanduser("~/Downloads/building assets")
ASSETS = [
    "roof.png", "bigroof.png", "rooflong.png",
    "Wall.png", "bigwall.png",
    "vent1.png", "vent2.png",
    "opendoor.png", "closedddoors.png",
    "doornostairs.png", "doornostairsclosed.png", "doorstairsclosed.png",
    "manhole.png",
    "waterside1.png", "waterside2.png", "waterside3.png", "watersidefront.png",
]

def color_dist(a, b):
    return math.sqrt(sum((a[i]-b[i])**2 for i in range(3)))

def quantize_palette(img, threshold=30):
    """Find core colors by clustering near-duplicates.
    Increases threshold until palette fits in 16 colors (single hex char)."""
    raw_colors = {}
    for y in range(img.height):
        for x in range(img.width):
            c = img.getpixel((x, y))
            rgb = c[:3]
            a = c[3] if len(c) > 3 else 255
            raw_colors[rgb] = raw_colors.get(rgb, 0) + (1 if a > 128 else 0)

    sorted_colors = sorted(raw_colors.items(), key=lambda x: -x[1])

    t = threshold
    while t < 200:
        palette = []
        for rgb, count in sorted_colors:
            merged = False
            for pc in palette:
                if color_dist(rgb, pc) < t:
                    merged = True
                    break
            if not merged:
                palette.append(rgb)
        if len(palette) <= 15:
            return palette
        t += 10

    return palette[:15]

def index_pixels(img, palette):
    """Map each pixel to nearest palette index."""
    pixels = []
    for y in range(img.height):
        for x in range(img.width):
            c = img.getpixel((x, y))
            rgb = c[:3]
            a = c[3] if len(c) > 3 else 255
            if a < 128:
                # Transparent -> index 0 (or find closest to black)
                best = 0
            else:
                best = 0
                best_d = float('inf')
                for i, pc in enumerate(palette):
                    d = color_dist(rgb, pc)
                    if d < best_d:
                        best_d = d
                        best = i
            pixels.append(best)
    return pixels

def rle_encode(pixels):
    """RLE encode: pairs of (count, index). Output as hex string.
    Each run: 1 hex char for index (0-f) + 1-3 hex chars for count.
    Format: index_char + count_chars (variable length, terminated by next index or end).
    
    Simpler: just output raw palette indices as hex chars."""
    return ''.join(format(p, 'x') for p in pixels)

def to_js_key(filename):
    """Convert filename to JS-safe key."""
    name = os.path.splitext(filename)[0]
    return name.lower().replace(' ', '_')

def main():
    lines = []
    lines.append("// Auto-generated from PNG assets — do not edit by hand")
    lines.append("var BLDG_PIXEL_DATA = {};")
    lines.append("")

    for fname in ASSETS:
        path = os.path.join(SRC_DIR, fname)
        if not os.path.exists(path):
            print(f"  SKIP {fname} (not found)", file=sys.stderr)
            continue

        img = Image.open(path).convert("RGBA")
        palette = quantize_palette(img)
        pixels = index_pixels(img, palette)
        hex_str = rle_encode(pixels)

        key = to_js_key(fname)
        pal_js = "[" + ",".join(f"'#{r:02x}{g:02x}{b:02x}'" for r,g,b in palette) + "]"
        
        lines.append(f"BLDG_PIXEL_DATA.{key} = {{")
        lines.append(f"  w: {img.width}, h: {img.height},")
        lines.append(f"  pal: {pal_js},")
        # Split hex string into chunks of 200 for readability
        chunks = [hex_str[i:i+200] for i in range(0, len(hex_str), 200)]
        lines.append(f"  px: " + " +\n    ".join(f"'{c}'" for c in chunks))
        lines.append("};")
        lines.append("")
        
        print(f"  {fname:30s} -> {key:20s}  {img.width}x{img.height}  pal={len(palette)}  data={len(hex_str)} chars", file=sys.stderr)

    # Add the canvas builder function
    lines.append("""
// Build offscreen canvases from pixel data at startup
var BLDG_CANVASES = {};

function buildBldgCanvases() {
    var keys = Object.keys(BLDG_PIXEL_DATA);
    for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var d = BLDG_PIXEL_DATA[key];
        var cv = document.createElement('canvas');
        cv.width = d.w;
        cv.height = d.h;
        var c = cv.getContext('2d');
        var imgData = c.createImageData(d.w, d.h);
        var buf = imgData.data;
        var px = d.px;
        var pal = d.pal;
        // Pre-parse palette to RGB arrays
        var palRGB = [];
        for (var p = 0; p < pal.length; p++) {
            var hex = pal[p];
            palRGB.push([
                parseInt(hex.substr(1,2), 16),
                parseInt(hex.substr(3,2), 16),
                parseInt(hex.substr(5,2), 16)
            ]);
        }
        for (var i = 0; i < px.length; i++) {
            var idx = parseInt(px[i], 16);
            var rgb = palRGB[idx] || [0,0,0];
            var off = i * 4;
            buf[off]     = rgb[0];
            buf[off + 1] = rgb[1];
            buf[off + 2] = rgb[2];
            buf[off + 3] = 255;
        }
        c.putImageData(imgData, 0, 0);
        BLDG_CANVASES[key] = cv;
    }
}""")

    print("\n".join(lines))

if __name__ == "__main__":
    main()
