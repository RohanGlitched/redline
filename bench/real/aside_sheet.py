"""Draw every difference the re-plot shift check set aside, before and after side by side, so anyone can
check that none of them hides an edit. Run in the folder holding jobs.json and results.json (made by
render.py and compare.mjs): python aside_sheet.py -> set_aside_all.png"""
import json
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont

R = json.load(open('results.json'))
J = {j['name'] + j['path']: j for j in json.load(open('jobs.json'))}
try:
    FONT = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 15)
    SMALL = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 12)
except OSError:
    FONT = SMALL = ImageFont.load_default()

TILE_W, CROP_H = 520, 150


def crop(img, box):
    """A crop centred on the box, at least 220 x 110 px of drawing around it."""
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    hw, hh = max(110, (x1 - x0) // 2 + 30), max(55, (y1 - y0) // 2 + 30)
    X0, Y0 = max(0, cx - hw), max(0, cy - hh)
    X1, Y1 = min(img.shape[1], cx + hw), min(img.shape[0], cy + hh)
    return img[Y0:Y1, X0:X1]


def drawing_name(j):
    repo = j['name'].split('__')[0].replace('SparkFun_', '').replace('_', ' ')
    sub = ' Plus' if 'Plus' in j['path'] else (' dimensions' if 'dimensions' in j['path'] else '')
    return f"{repo}{sub}"


tiles = []
for j in R:
    job = J[j['name'] + j['path']]
    for p, jp in zip(j['pages'], job['pages']):
        for a in p.get('setAside', []):
            A, B = cv2.imread(jp['A'], 0), cv2.imread(jp['B'], 0)
            ca, cb = crop(A, a['box']), crop(B, a['box'])
            half = (TILE_W - 12) // 2
            s = min(half / ca.shape[1], CROP_H / ca.shape[0], 3)
            size = (max(1, int(ca.shape[1] * s)), max(1, int(ca.shape[0] * s)))
            ia = Image.fromarray(cv2.resize(ca, size, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_NEAREST)).convert('RGB')
            ib = Image.fromarray(cv2.resize(cb, size, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_NEAREST)).convert('RGB')
            tile = Image.new('RGB', (TILE_W, size[1] + 46), (255, 255, 255))
            d = ImageDraw.Draw(tile)
            d.text((0, 0), f"{len(tiles) + 1}. {drawing_name(j)}, sheet {p['page']}, {j['from']['hash'][:7]} to {j['to']['hash'][:7]}", font=FONT, fill=(23, 43, 77))
            d.text((0, 22), 'Before', font=SMALL, fill=(98, 111, 134))
            d.text((half + 12, 22), f"After (matches at {a['match'] * 100:.1f}%)", font=SMALL, fill=(98, 111, 134))
            tile.paste(ia, (0, 40))
            tile.paste(ib, (half + 12, 40))
            d.line([(half + 5, 40), (half + 5, 40 + size[1])], fill=(210, 214, 220), width=1)
            tiles.append(tile)

cols, gap = 2, 24
rows = [tiles[i:i + cols] for i in range(0, len(tiles), cols)]
H = sum(max(t.height for t in r) + gap for r in rows) + 60
sheet = Image.new('RGB', (cols * TILE_W + (cols + 1) * gap, H), (255, 255, 255))
d = ImageDraw.Draw(sheet)
d.text((gap, 14), f"All {len(tiles)} differences Redline set aside as re-plot shifts on the SparkFun run: each reads the same before and after.", font=FONT, fill=(23, 43, 77))
y = 50
for r in rows:
    for i, t in enumerate(r):
        sheet.paste(t, (gap + i * (TILE_W + gap), y))
    y += max(t.height for t in r) + gap
d.text((gap, H - 22), 'Drawings (c) SparkFun Electronics, CC BY-SA 4.0; cropped and arranged by us, shared under the same licence.', font=SMALL, fill=(98, 111, 134))
sheet.save('set_aside_all.png')
print(len(tiles), sheet.size)
