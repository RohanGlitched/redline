import json, sys
from PIL import Image, ImageDraw, ImageFont
R = json.load(open('results.json')); J = {j['name']+j['path']: j for j in json.load(open('jobs.json'))}
want = sys.argv[1:]
for r in R:
    tag = f"{r['repo']}|{r['path']}|{r['from']['i']}-{r['to']['i']}"
    if want and not any(w in tag for w in want): continue
    job = J[r['name']+r['path']]
    tiles = []
    for p in r['pages']:
        if 'clouds' not in p: continue
        jp = next(x for x in job['pages'] if x['page'] == p['page'])
        A, B = Image.open(jp['A']), Image.open(jp['B'])
        for c in p["clouds"]:
            x0, y0, x1, y1 = c['box']; pad = 40
            box = (max(0, x0-pad), max(0, y0-pad), min(A.width, x1+pad), min(A.height, y1+pad))
            a, b = A.crop(box), B.crop(box)
            s = min(1.0, 320 / max(a.width, a.height))
            a = a.resize((max(1, int(a.width*s)), max(1, int(a.height*s)))); b = b.resize(a.size)
            t = Image.new('L', (a.width*2+30, a.height+22), 255); t.paste(a, (0, 20)); t.paste(b, (a.width+30, 20))
            ImageDraw.Draw(t).text((2, 2), f"#{len(tiles)+1} p{p['page']} {c['kind']}  A | B", fill=0)
            tiles.append(t)
    if not tiles: continue
    W = 1400; x = y = rowh = 0; pos = []
    for t in tiles:
        if x + t.width > W: x = 0; y += rowh + 10; rowh = 0
        pos.append((x, y)); x += t.width + 10; rowh = max(rowh, t.height)
    sheet = Image.new('L', (W, y + rowh + 40), 235)
    d = ImageDraw.Draw(sheet); d.text((5, y + rowh + 15), f"{tag}  NOTE: {r['to']['subject']}", fill=0)
    for t, (px, py) in zip(tiles, pos): sheet.paste(t, (px, py))
    out = f"sheet_{r['repo']}_{r['path'].replace('/','_')}_{r['from']['i']}-{r['to']['i']}.png"; sheet.save(out); print(out, len(tiles))
