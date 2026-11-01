"""Redline gate: build a benchmark of drawing revision pairs from NIST public-domain PMI drawings.

For each vector page we plant 1-3 edits at the PDF level (move, resize, delete, add, change a dimension),
record ground-truth boxes, and render rev A / rev B rasters. Rev B also gets "rescan" variants
(small rotation, scale, shift, blur, noise, JPEG, paper tint). Pairs with no edits measure false clouds.

usage: python gen.py <nist_dir> <out_dir> [pairs_per_page]
"""
import sys, os, json, glob, random, io
import numpy as np, pymupdf, cv2

NIST, OUT = sys.argv[1], sys.argv[2]
PER_PAGE = int(sys.argv[3]) if len(sys.argv) > 3 else 3
DPI = 150
S = DPI / 72.0
os.makedirs(OUT, exist_ok=True)
rng = random.Random(7)

def pages():
    for f in sorted(glob.glob(os.path.join(NIST, '*', '*', '*.pdf'))):
        if 'elem_ids' in f or 'fsi' in f or 'suppl' in f or 'assembly' in f:
            continue
        d = pymupdf.open(f)
        for i, p in enumerate(d):
            if len(p.get_drawings()) > 200:
                yield f, i

def ink_paths(page):
    """Stroked/dark paths (not light shading) with their rects."""
    out = []
    for d in page.get_drawings():
        col = d.get('color') or d.get('fill')
        if not col or sum(col[:3]) > 2.2:  # light fills (face shading)
            continue
        r = d['rect']
        if r.width > 250 or r.height > 250:
            continue
        out.append(d)
    return out

def clusters(paths, gap=3.0):
    """Group nearby same-colour paths (a dimension's strokes, a hole's arcs)."""
    rects = [pymupdf.Rect(p['rect']) for p in paths]
    n = len(rects); parent = list(range(n))
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    grid = {}
    C = 40.0
    for i, r in enumerate(rects):
        for gx in range(int((r.x0 - gap) // C), int((r.x1 + gap) // C) + 1):
            for gy in range(int((r.y0 - gap) // C), int((r.y1 + gap) // C) + 1):
                grid.setdefault((gx, gy), []).append(i)
    col = [paths[i].get('color') or paths[i].get('fill') for i in range(n)]
    for cell in grid.values():
        for a in range(len(cell)):
            i = cell[a]; ri = rects[i] + (-gap, -gap, gap, gap)
            for b in range(a + 1, len(cell)):
                j = cell[b]
                if col[i] == col[j] and ri.intersects(rects[j]):
                    parent[find(i)] = find(j)
    g = {}
    for i in range(n):
        g.setdefault(find(i), []).append(i)
    out = []
    for idx in g.values():
        r = pymupdf.Rect(rects[idx[0]])
        for k in idx[1:]:
            r |= rects[k]
        if 4 < r.width < 120 and 4 < r.height < 120:
            out.append(([paths[k] for k in idx], r))
    return out

def redraw(page, paths, fn):
    sh = page.new_shape()
    for p in paths:
        for it in p['items']:
            pts = [fn(pymupdf.Point(x)) for x in it[1:] if isinstance(x, pymupdf.Point)]
            if it[0] == 'l':
                sh.draw_line(*pts)
            elif it[0] == 'c':
                sh.draw_bezier(*pts)
            elif it[0] == 're':
                r = it[1]; q = [fn(r.tl), fn(r.tr), fn(r.br), fn(r.bl)]
                sh.draw_polyline(q + [q[0]])
            elif it[0] == 'qu':
                q = it[1]; qq = [fn(q.ul), fn(q.ur), fn(q.lr), fn(q.ll)]
                sh.draw_polyline(qq + [qq[0]])
        sh.finish(color=p.get('color'), fill=p.get('fill'), width=p.get('width') or 0.5,
                  closePath=bool(p.get('closePath')), even_odd=bool(p.get('even_odd')))
    sh.commit()

def remove(page, rect):
    page.add_redact_annot(rect, fill=False)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE,
                          graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED, text=pymupdf.PDF_REDACT_TEXT_NONE)

NOTES = ['NOTE 4: BREAK ALL SHARP EDGES', 'DEBURR 0.2 MAX', 'MATL: AL 6061-T6', 'FINISH: ANODIZE CLEAR',
         'TORQUE 12 Nm', 'Ø6.2 THRU', '2X R3', 'SEE DETAIL B']

def plant(page, n):
    cands = clusters(ink_paths(page))
    rng.shuffle(cands)
    used, truth = [], []
    W, H = page.rect.width, page.rect.height
    for kind in rng.sample(['move', 'resize', 'delete', 'add', 'retext'], k=n):
        if kind == 'add':
            for _ in range(30):
                x, y = rng.uniform(60, W - 220), rng.uniform(60, H - 60)
                r = pymupdf.Rect(x, y - 9, x + 160, y + 3)
                if not any(r.intersects(u) for u in used):
                    break
            if rng.random() < 0.5:
                t = rng.choice(NOTES); fs = rng.uniform(6, 8)
                page.insert_text((x, y), t, fontsize=fs, color=(0, 0, 1))
                r = pymupdf.Rect(x, y - fs, x + pymupdf.get_text_length(t, fontsize=fs), y + 2)
            else:
                rad = rng.uniform(3, 7)
                page.draw_circle((x + 20, y), rad, color=(0, 0, 0), width=0.6)
                r = pymupdf.Rect(x + 20 - rad, y - rad, x + 20 + rad, y + rad)
            used.append(r); truth.append({'kind': 'add', 'rect': list(r)})
            continue
        pick = None
        for paths, r in cands:
            if not any(r.intersects(u + (-8, -8, 8, 8)) for u in used):
                pick = (paths, r); break
        if not pick:
            continue
        cands.remove(pick)
        paths, r = pick
        remove(page, r + (-0.3, -0.3, 0.3, 0.3))
        if kind == 'move':
            ang = rng.uniform(0, 6.283); d = rng.uniform(1.5, 4.0) * 72 / 25.4  # 1.5-4 mm on paper
            dx, dy = d * np.cos(ang), d * np.sin(ang)
            redraw(page, paths, lambda p: pymupdf.Point(p.x + dx, p.y + dy))
            nr = r + (dx, dy, dx, dy)
        elif kind == 'resize':
            k = rng.choice([0.75, 0.8, 1.2, 1.3]); c = (r.tl + r.br) / 2
            redraw(page, paths, lambda p: c + (p - c) * k)
            nr = pymupdf.Rect(c + (r.tl - c) * k, c + (r.br - c) * k)
        elif kind == 'retext':
            t = rng.choice(['Ø26 ±0.15', '35.4', 'R4', '0.5 A B', '12.70', '60° ±1°'])
            fs = max(5, min(9, r.height * 0.8))
            page.insert_text((r.x0, r.y1), t, fontsize=fs, color=(0, 0, 1))
            nr = pymupdf.Rect(r.x0, r.y1 - fs, r.x0 + pymupdf.get_text_length(t, fontsize=fs), r.y1 + 2)
        else:
            nr = r
        u = r | nr
        used.append(u); truth.append({'kind': kind, 'rect': list(u)})
    return truth

def render(page):
    pix = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csGRAY)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w).copy()

def rescan(img, r):
    h, w = img.shape
    ang = r.uniform(-1.5, 1.5); sc = r.uniform(0.98, 1.02); tx, ty = r.uniform(-25, 25), r.uniform(-25, 25)
    M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, sc); M[:, 2] += (tx, ty)
    out = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=255)
    out = cv2.GaussianBlur(out, (0, 0), r.uniform(0.5, 1.0))
    paper = r.uniform(215, 245)
    out = out.astype(np.float32) * (paper / 255.0) + np.random.default_rng(r.randint(0, 9999)).normal(0, r.uniform(3, 9), out.shape)
    out = np.clip(out, 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode('.jpg', out, [cv2.IMWRITE_JPEG_QUALITY, r.randint(45, 80)])
    return cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE), {'angle': ang, 'scale': sc, 'tx': tx, 'ty': ty}

index = []
k = 0
for f, pi in pages():
    for rep in range(PER_PAGE + 1):
        src = pymupdf.open(f)
        page = src[pi]
        if page.rotation:
            page.remove_rotation()
        a = render(page)
        n = 0 if rep == 0 else rng.randint(1, 3)
        truth = plant(page, n) if n else []
        b = render(page)
        name = f'p{k:04d}'; k += 1
        cv2.imwrite(os.path.join(OUT, name + '_a.png'), a)
        cv2.imwrite(os.path.join(OUT, name + '_b.png'), b)
        bs, meta = rescan(b, rng)
        cv2.imwrite(os.path.join(OUT, name + '_bs.jpg'), bs)
        index.append({'id': name, 'src': os.path.basename(f), 'page': pi, 'scale': S,
                      'truth': [{**t, 'px': [v * S for v in t['rect']]} for t in truth], 'rescan': meta})
        print(name, os.path.basename(f), pi, [t['kind'] for t in truth], flush=True)
json.dump(index, open(os.path.join(OUT, 'index.json'), 'w'), indent=1)
print('pairs', len(index), 'edits', sum(len(x['truth']) for x in index))
