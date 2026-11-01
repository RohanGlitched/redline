"""Contact sheets of every cloud in the real-world run, before and after, for classification."""
import json, csv, os
import cv2
from PIL import Image, ImageDraw, ImageFont
R = json.load(open('results.json')); J = {j['name'] + j['path']: j for j in json.load(open('jobs.json'))}
FONT = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 15); SMALL = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 12)
os.makedirs('clouds', exist_ok=True)
rows, tiles = [], []
def crop(img, box):
    x0, y0, x1, y1 = box; cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    hw, hh = max(120, (x1 - x0) // 2 + 40), max(70, (y1 - y0) // 2 + 40)
    X0, Y0 = max(0, cx - hw), max(0, cy - hh); X1, Y1 = min(img.shape[1], cx + hw), min(img.shape[0], cy + hh)
    return img[Y0:Y1, X0:X1], (X0, Y0)
for j in R:
    job = J[j['name'] + j['path']]
    for p, jp in zip(j['pages'], job['pages']):
        if not p.get('clouds'): continue
        A, B = cv2.imread(jp['A'], 0), cv2.imread(jp['B'], 0)
        for k, c in enumerate(p['clouds']):
            cid = f"C{len(rows) + 1:03d}"
            ca, (ox, oy) = crop(A, c['box']); cb, _ = crop(B, c['box'])
            ca, cb = cv2.cvtColor(ca, cv2.COLOR_GRAY2BGR), cv2.cvtColor(cb, cv2.COLOR_GRAY2BGR)
            for im in (ca, cb): cv2.rectangle(im, (c['box'][0] - ox - 3, c['box'][1] - oy - 3), (c['box'][2] - ox + 3, c['box'][3] - oy + 3), (40, 40, 220), 1)
            half = 380; s = min(half / ca.shape[1], 220 / ca.shape[0], 3)
            sz = (max(1, int(ca.shape[1] * s)), max(1, int(ca.shape[0] * s)))
            ia = Image.fromarray(cv2.cvtColor(cv2.resize(ca, sz, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_NEAREST), cv2.COLOR_BGR2RGB))
            ib = Image.fromarray(cv2.cvtColor(cv2.resize(cb, sz, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_NEAREST), cv2.COLOR_BGR2RGB))
            t = Image.new('RGB', (2 * half + 12, sz[1] + 40), 'white'); d = ImageDraw.Draw(t)
            mv = c.get('moved'); mvs = f", moved ({mv['dx']},{mv['dy']}) px" if mv else ''
            d.text((0, 0), f"{cid}  {j['name'].split('__')[0].replace('SparkFun_', '')} {j['path'].split('/')[-2] if 'Plus' in j['path'] else ''} sheet {p['page']}  {c['kind']}{mvs}", font=FONT, fill=(23, 43, 77))
            d.text((0, 20), 'Before', font=SMALL, fill=(98, 111, 134)); d.text((half + 12, 20), 'After', font=SMALL, fill=(98, 111, 134))
            t.paste(ia, (0, 38)); t.paste(ib, (half + 12, 38)); tiles.append(t)
            rows.append({'id': cid, 'repo': j['repo'] if 'repo' in j else j['name'].split('__')[0], 'path': j['path'], 'from': j['from']['hash'][:7], 'to': j['to']['hash'][:7], 'commit': j['to'].get('subject', ''), 'page': p['page'], 'box': ' '.join(map(str, c['box'])), 'kind': c['kind'], 'moved': f"{mv['dx']},{mv['dy']}" if mv else '', 'before': c.get('before', ''), 'after': c.get('after', '')})
per = 12
for i in range(0, len(tiles), per):
    grp = tiles[i:i + per]; W = max(t.width for t in grp); H = sum(t.height + 16 for t in grp)
    sh = Image.new('RGB', (W, H), 'white'); y = 0
    for t in grp: sh.paste(t, (0, y)); y += t.height + 16
    sh.save(f'clouds/sheet_{i // per + 1:02d}.png')
with open('clouds/index.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
print(len(rows), 'clouds on', (len(tiles) + per - 1) // per, 'sheets')
