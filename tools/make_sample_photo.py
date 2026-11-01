"""A phone photo of the printed rev D sample with a machinist's pen markups, for the sample change order.
The markups are a ring around the B5 datum area, "R3 MAX" beside a fillet, and a crossed-out callout.
Simulated photograph (perspective, light, blur, noise, JPEG); labelled as simulated wherever it is shown.
usage: python make_sample_photo.py <rev-D.pdf> <out.jpg>
"""
import sys, numpy as np, cv2, pymupdf
rng = np.random.default_rng(5)
p = pymupdf.open(sys.argv[1])[0]
pix = p.get_pixmap(dpi=200)
sheet = cv2.cvtColor(np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, pix.n)[:, :, :3], cv2.COLOR_RGB2BGR)
sheet = (sheet.astype(np.float32) / 255 * np.array([238, 245, 250])).astype(np.uint8)
s = 200 / 72  # points -> px
pen, th = (38, 36, 196), 4
def pts(a): return (np.array(a) * s).astype(np.int32)
# ring around a hole near zone C4 (a question about the hole the drafter moved)
c = (509 * s, 316 * s); cv2.ellipse(sheet, (int(c[0]), int(c[1])), (int(22 * s), int(16 * s)), -12, 10, 350, pen, th, cv2.LINE_AA)
cv2.putText(sheet, 'CHECK POS?', (int(528 * s), int(296 * s)), cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, 2.2, pen, th, cv2.LINE_AA)
# "R3 MAX" with an arrow to a fillet in zone B6
cv2.arrowedLine(sheet, (int(118 * s), int(268 * s)), (int(146 * s), int(240 * s)), pen, th, cv2.LINE_AA, tipLength=0.2)
cv2.putText(sheet, 'R3 MAX', (int(62 * s), int(292 * s)), cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, 2.4, pen, th, cv2.LINE_AA)
H, W = sheet.shape[:2]
OW, OH = 3200, 2400
photo = np.zeros((OH, OW, 3), np.float32); photo[:] = (52, 70, 92)
photo += cv2.GaussianBlur(rng.normal(0, 16, (OH, OW)).astype(np.float32), (0, 0), 3)[..., None]
k = 0.74 * min(OW / W, OH / H); cw, ch = W * k, H * k; ox, oy = (OW - cw) / 2 + 40, (OH - ch) / 2 - 20
dst = np.float32([[ox + 70, oy + 30], [ox + cw - 20, oy - 40], [ox + cw + 60, oy + ch + 20], [ox - 30, oy + ch - 10]])
M = cv2.getPerspectiveTransform(np.float32([[0, 0], [W, 0], [W, H], [0, H]]), dst)
sh = np.zeros((OH, OW), np.float32); cv2.fillConvexPoly(sh, (dst + [22, 26]).astype(np.int32), 1.0); sh = cv2.GaussianBlur(sh, (0, 0), 28)
photo *= (1 - 0.45 * sh[..., None])
warped = cv2.warpPerspective(sheet, M, (OW, OH)); mask = cv2.warpPerspective(np.full((H, W), 255, np.uint8), M, (OW, OH))
photo = np.where(mask[..., None] > 127, warped.astype(np.float32), photo)
yy, xx = np.mgrid[0:OH, 0:OW].astype(np.float32)
photo *= (1 - 0.22 * np.hypot(xx - OW * 0.8, yy - OH * 0.1) / np.hypot(OW, OH))[..., None]
photo = cv2.GaussianBlur(np.clip(photo, 0, 255), (0, 0), 0.9)
photo = np.clip(photo + rng.normal(0, 3.5, photo.shape), 0, 255).astype(np.uint8)
cv2.imwrite(sys.argv[2], photo, [cv2.IMWRITE_JPEG_QUALITY, 86])
print('ok', sys.argv[2])
