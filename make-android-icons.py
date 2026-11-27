# Generate Android launcher icons from tarot-icon.png.
#
# Android wants one icon per screen density; shipping a single image makes the
# system scale it and the star's edges go soft.
#
#     python make-android-icons.py
#
# ASCII only: this environment's Python reads source as something other than
# UTF-8, so non-ASCII text in the file triggers a SyntaxError.

import os
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'tarot-icon.png')
RES = os.path.join(HERE, 'android', 'app', 'src', 'main', 'res')

# density -> icon edge length in px (Android's recommended launcher sizes)
DENSITIES = [
    ('mdpi', 48),
    ('hdpi', 72),
    ('xhdpi', 96),
    ('xxhdpi', 144),
    ('xxxhdpi', 192),
]

if not os.path.exists(SRC):
    print('source image not found: ' + SRC)
    sys.exit(1)

src = Image.open(SRC).convert('RGBA')
print('source: %dx%d' % src.size)

# Centre-crop to a square first, otherwise the icon gets stretched
w, h = src.size
if w != h:
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    src = src.crop((left, top, left + side, top + side))
    print('cropped to square: %dx%d' % src.size)

made = 0
for name, size in DENSITIES:
    out_dir = os.path.join(RES, 'mipmap-' + name)
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, 'ic_launcher.png')

    # LANCZOS keeps the star edges clean when downscaling
    img = src.resize((size, size), Image.LANCZOS)
    img.save(out, 'PNG', optimize=True)
    print('  mipmap-%-8s %3dx%-3d  %6d bytes' % (name, size, size, os.path.getsize(out)))
    made += 1

print('')
print('generated %d icons' % made)
