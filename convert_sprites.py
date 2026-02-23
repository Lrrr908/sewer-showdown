#!/usr/bin/env python3
"""Convert extracted NES TMNT sprite PNGs to game.js pattern format.

Reads each pixel, maps to nearest NES PAL color key, outputs JS pattern arrays.
The NES blue background (#6888fc / similar) is treated as transparent ('_').
"""

from PIL import Image
import math, os, sys, json

# Exact color mapping for these extracted NES TMNT sprites
EXACT_MAP = {
    (0x93, 0xbb, 0xec): '_',  # background
    (0x00, 0x00, 0x00): 'K',  # black outline
    (0x00, 0x44, 0x00): 'G',  # dark green (shell shadow)
    (0x1b, 0x59, 0x99): 'N',  # medium blue-gray (detail)
    (0x20, 0x38, 0xec): 'B',  # blue (Leo's mask - swappable)
    (0x4c, 0xdc, 0x48): 'V',  # green (body)
    (0xfc, 0xd8, 0xa8): 'T',  # tan (skin/weapon)
}

PAL = {
    'W': (0xfc, 0xfc, 0xfc),
    'L': (0xbc, 0xbc, 0xbc),
    'G': (0x74, 0x74, 0x74),
    'B': (0x00, 0x70, 0xec),
    'K': (0x00, 0x00, 0x00),
    'N': (0x24, 0x18, 0x8c),
    'C': (0x3c, 0xbc, 0xfc),
    'R': (0xa4, 0x00, 0x00),
    'P': (0xfc, 0x74, 0x60),
    'T': (0xfc, 0xd8, 0xa8),
    'D': (0x7c, 0x08, 0x00),
    'M': (0xc8, 0x4c, 0x0c),
    'O': (0xfc, 0x98, 0x38),
    'V': (0x00, 0xa8, 0x00),
    'S': (0x78, 0x78, 0x78),
}

BG_COLORS = []
BG_THRESHOLD = 999  # unused with exact map

def color_dist(c1, c2):
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(c1, c2)))

def convert_sprite(filepath):
    img = Image.open(filepath).convert('RGBA')
    w, h = img.size
    rows = []
    for y in range(h):
        row = ''
        for x in range(w):
            r, g, b, a = img.getpixel((x, y))
            if a < 128:
                row += '_'
                continue
            exact = EXACT_MAP.get((r, g, b))
            if exact:
                row += exact
            else:
                best_key = '_'
                best_dist = float('inf')
                for key, (pr, pg, pb) in PAL.items():
                    d = color_dist((r, g, b), (pr, pg, pb))
                    if d < best_dist:
                        best_dist = d
                        best_key = key
                row += best_key
        rows.append(row)
    return rows, w, h

def format_pattern(name, rows):
    lines = [f"    PATTERNS.{name} = ["]
    for i, row in enumerate(rows):
        comma = ',' if i < len(rows) - 1 else ''
        lines.append(f"        '{row}'{comma}")
    lines.append("    ];")
    return '\n'.join(lines)

def main():
    leo_dir = '/home/beast/Downloads/Leo'
    files = sorted(os.listdir(leo_dir))

    # Map filenames to meaningful names based on sprite analysis
    sprite_map = {
        'sprite_1_368_16x24.png':    'leoWalkR1',
        'sprite_18_368_16x24.png':   'leoWalkR2',
        'sprite_35_368_16x24.png':   'leoWalkR3',
        'sprite_52_376_16x16.png':   'leoStand1',
        'sprite_69_376_16x16.png':   'leoStand2',
        'sprite_86_376_16x16.png':   'leoStand3',
        'sprite_103_376_16x16.png':  'leoStand4',
        'sprite_120_376_16x23.png':  'leoWalkR4',
        'sprite_137_376_16x16.png':  'leoAction1',
        'sprite_154_376_16x16.png':  'leoAction2',
        'sprite_171_376_16x16.png':  'leoAction3',
        'sprite_188_376_16x16.png':  'leoAction4',
        'sprite_205_368_16x24.png':  'leoWalkR5',
        'sprite_222_376_16x16.png':  'leoAction5',
        'sprite_239_376_16x16.png':  'leoAction6',
        'sprite_256_368_15x32.png':  'leoJump',
        'sprite_273_376_24x16.png':  'leoAttack',
        'sprite_298_368_16x24.png':  'leoWalkR6',
    }

    print("// ── Auto-converted Leo sprites from NES TMNT ──")
    print("// B = mask color (blue for Leo, swap for other turtles)")
    print()

    all_patterns = {}
    for fname in files:
        if not fname.endswith('.png'):
            continue
        name = sprite_map.get(fname, fname.replace('.png', '').replace('sprite_', 'leo_'))
        filepath = os.path.join(leo_dir, fname)
        rows, w, h = convert_sprite(filepath)
        all_patterns[name] = rows
        print(format_pattern(name, rows))
        print()

    # Also output a JSON version for easy inspection
    with open('/home/beast/tmnt-art-show/leo_patterns.json', 'w') as f:
        json.dump(all_patterns, f, indent=2)
    print(f"// Saved {len(all_patterns)} patterns to leo_patterns.json", file=sys.stderr)

if __name__ == '__main__':
    main()
