"""Simulated phone photos of marked-up prints, with ground truth, for the paper-markup gate.

Each photo: a NIST drawing page "printed" on slightly warm paper, red-pen markups drawn by a jittery hand
(circles, clouds, arrows, strike-throughs, handwritten values), then laid on a desk at a random perspective,
with uneven light, a soft shadow, blur, sensor noise and JPEG compression. Ground truth is each markup's box
in the 150-dpi raster of the page, which is what the engine aligns the photo to.

usage: python photos.py <nist_dir> <out_dir> [n]
"""
import sys, os, json, glob, random
import numpy as np, cv2, pymupdf

NIST, OUT = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 60
os.makedirs(OUT, exist_ok=True)
rng = random.Random(11)
nprng = np.random.default_rng(11)

pages = []
for f in sorted(glob.glob(os.path.join(NIST, '*', '*', '*.pdf'))):
    if any(k in f for k in ('elem_ids', 'fsi', 'suppl', 'assembly', 'atc_all')):
        continue
    d = pymupdf.open(f)
    for i, p in enumerate(d):
        if len(p.get_drawings()) > 200:
            pages.append((f, i))


def render(f, i, dpi):
    p = pymupdf.open(f)[i]
    if p.rotation:
        p.remove_rotation()
    pix = p.get_pixmap(dpi=dpi)
    rgb = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, pix.n)[:, :, :3]
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)  # OpenCV works in BGR


PEN = [(40, 40, 200), (30, 30, 170), (60, 50, 215)]  # BGR reds of ballpoint and felt pens


def jitter_poly(pts, amp):
    return np.array([(x + rng.gauss(0, amp), y + rng.gauss(0, amp)) for x, y in pts], np.int32)


def mark(img, s):
    """Draw one markup at a random spot; return its box in this image's pixels."""
    h, w = img.shape[:2]
    col = rng.choice(PEN); th = max(2, int(rng.uniform(2.0, 3.5) * s))
    cx, cy = rng.uniform(0.15, 0.85) * w, rng.uniform(0.15, 0.8) * h
    kind = rng.choice(['circle', 'cloud', 'arrow', 'strike', 'text', 'text'])
    pts = []
    if kind in ('circle', 'cloud'):
        rx, ry = rng.uniform(30, 70) * s, rng.uniform(22, 50) * s
        n = 40 if kind == 'circle' else 14
        for k in range(n + 3):
            a = 2 * np.pi * k / n
            r = 1 + (0.12 * np.sin(a * 7) if kind == 'cloud' else 0)
            pts.append((cx + rx * r * np.cos(a), cy + ry * r * np.sin(a)))
        cv2.polylines(img, [jitter_poly(pts, 1.2 * s)], False, col, th, cv2.LINE_AA)
    elif kind == 'arrow':
        L = rng.uniform(60, 120) * s; a = rng.uniform(0, 2 * np.pi)
        x2, y2 = cx + L * np.cos(a), cy + L * np.sin(a)
        cv2.arrowedLine(img, (int(cx), int(cy)), (int(x2), int(y2)), col, th, cv2.LINE_AA, tipLength=0.25)
        pts = [(cx, cy), (x2, y2)]
    elif kind == 'strike':
        L = rng.uniform(50, 110) * s
        for o in (0, 6 * s):
            p = [(cx - L / 2, cy + o), (cx + L / 2, cy + o - rng.uniform(-8, 8) * s)]
            cv2.polylines(img, [jitter_poly(p, 1)], False, col, th, cv2.LINE_AA); pts += p
    else:
        t = rng.choice(['DIA 6.5', 'R3 MAX', 'ADD CHAMFER', '12.7', 'WRONG DATUM', '2X', 'CHECK', '25.5?'])
        fs = rng.uniform(0.9, 1.4) * s
        cv2.putText(img, t, (int(cx), int(cy)), cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, fs, col, th, cv2.LINE_AA)
        (tw, tht), _ = cv2.getTextSize(t, cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, fs, th)
        pts = [(cx, cy - tht), (cx + tw, cy + 6 * s)]
    a = np.array(pts)
    return kind, [a[:, 0].min() - th, a[:, 1].min() - th, a[:, 0].max() + th, a[:, 1].max() + th]


def desk(w, h):
    base = np.zeros((h, w, 3), np.uint8)
    tone = rng.choice([(60, 85, 120), (40, 45, 50), (120, 130, 140), (35, 60, 95)])
    base[:] = tone
    grain = cv2.GaussianBlur(nprng.normal(0, 18, (h, w)).astype(np.float32), (0, 0), 3)
    return np.clip(base + grain[..., None], 0, 255).astype(np.uint8)


index = []
for k in range(N):
    f, i = rng.choice(pages)
    PR = 200  # print resolution of the simulated sheet
    sheet = render(f, i, PR)
    paper = np.array([rng.uniform(232, 250), rng.uniform(238, 252), rng.uniform(242, 255)])  # BGR, warm
    sheet = (sheet.astype(np.float32) / 255 * paper).astype(np.uint8)
    s = PR / 150
    marks = [mark(sheet, s) for _ in range(rng.randint(1, 4))]
    H, W = sheet.shape[:2]
    # lay the sheet on a desk with perspective
    OW, OH = 3000, 2250
    scale = rng.uniform(0.62, 0.8) * min(OW / W, OH / H)
    cw, ch = W * scale, H * scale
    ox, oy = (OW - cw) / 2 + rng.uniform(-80, 80), (OH - ch) / 2 + rng.uniform(-60, 60)
    j = lambda: rng.uniform(-0.06, 0.06) * cw
    dst = np.float32([[ox + j(), oy + j()], [ox + cw + j(), oy + j()], [ox + cw + j(), oy + ch + j()], [ox + j(), oy + ch + j()]])
    src = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
    M = cv2.getPerspectiveTransform(src, dst)
    photo = desk(OW, OH)
    shadow = np.zeros((OH, OW), np.float32)
    cv2.fillConvexPoly(shadow, (dst + [18, 22]).astype(np.int32), 1.0)
    shadow = cv2.GaussianBlur(shadow, (0, 0), 25)
    photo = (photo * (1 - 0.45 * shadow[..., None])).astype(np.uint8)
    warped = cv2.warpPerspective(sheet, M, (OW, OH), flags=cv2.INTER_LINEAR)
    mask = cv2.warpPerspective(np.full((H, W), 255, np.uint8), M, (OW, OH))
    photo = np.where(mask[..., None] > 127, warped, photo)
    # uneven light, blur, noise, JPEG
    yy, xx = np.mgrid[0:OH, 0:OW].astype(np.float32)
    lx, ly = rng.uniform(0, OW), rng.uniform(0, OH)
    light = 1 - rng.uniform(0.1, 0.3) * (np.hypot(xx - lx, yy - ly) / np.hypot(OW, OH))
    photo = np.clip(photo * light[..., None], 0, 255)
    photo = cv2.GaussianBlur(photo, (0, 0), rng.uniform(0.6, 1.4))
    photo = np.clip(photo + nprng.normal(0, rng.uniform(2, 6), photo.shape), 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode('.jpg', photo, [cv2.IMWRITE_JPEG_QUALITY, rng.randint(70, 90)])
    name = f'ph{k:03d}'
    open(os.path.join(OUT, name + '.jpg'), 'wb').write(buf.tobytes())
    ref = render(f, i, 150)
    cv2.imwrite(os.path.join(OUT, name + '_ref.png'), ref)  # colour: printed red PMI must not read as pen
    cv2.imwrite(os.path.join(OUT, name + '.ppm'), cv2.imdecode(buf, cv2.IMREAD_COLOR))
    cv2.imwrite(os.path.join(OUT, name + '_ref.ppm'), ref)
    index.append({'id': name, 'src': os.path.basename(f), 'page': i,
                  'marks': [{'kind': kd, 'box': [v / s for v in b]} for kd, b in marks]})
    print(name, os.path.basename(f), i, [m[0] for m in marks], flush=True)
json.dump(index, open(os.path.join(OUT, 'index.json'), 'w'), indent=1)
print('photos', len(index), 'marks', sum(len(x['marks']) for x in index))
