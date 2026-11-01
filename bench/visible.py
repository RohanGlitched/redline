"""Mark planted edits that actually change visible line work (dark ink) in the clean render.
An edit nobody can see (e.g. a hidden or zero-area path) cannot be found by a person or a tool."""
import cv2, json, sys, numpy as np
D = sys.argv[1]
idx = json.load(open(D + '/index.json'))
n = vis = 0
for e in idx:
    a = cv2.imread(f"{D}/{e['id']}_a.pgm", 0); b = cv2.imread(f"{D}/{e['id']}_b.pgm", 0)
    ia, ib = a < 0.62 * np.percentile(a, 95), b < 0.62 * np.percentile(b, 95)
    k = np.ones((5, 5), np.uint8)
    ch = (ia & ~cv2.dilate(ib.astype(np.uint8), k).astype(bool)) | (ib & ~cv2.dilate(ia.astype(np.uint8), k).astype(bool))
    for t in e['truth']:
        r = [int(v) for v in t['px']]
        px = int(ch[max(0, r[1] - 6):r[3] + 6, max(0, r[0] - 6):r[2] + 6].sum())
        t['inkpx'] = px; t['visible'] = px >= 25
        n += 1; vis += t['visible']
json.dump(idx, open(D + '/index.json', 'w'), indent=1)
print('edits', n, 'visible', vis)
