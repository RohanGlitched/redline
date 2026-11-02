// Paper markups: line up a phone photo of a printed drawing with the CAD revision it was printed from,
// then find the pen marks (red ink that the CAD sheet does not have). Pure JS, no dependencies.
// Photos and references are RGBA rasters {w, h, data: Uint8ClampedArray|Uint8Array (4 bytes/px)}.
import { register, inkMask } from './core.mjs';

const lum = (d, i) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;

export function toGray(img) {
  const out = new Uint8Array(img.w * img.h);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = lum(img.data, i);
  return { w: img.w, h: img.h, data: out };
}

function shrink(img, maxSide) { // nearest-neighbour downscale of an RGBA raster (for finding the sheet)
  const k = Math.max(1, Math.max(img.w, img.h) / maxSide), w = Math.round(img.w / k), h = Math.round(img.h / k);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (Math.min(img.h - 1, Math.round(y * k)) * img.w + Math.min(img.w - 1, Math.round(x * k))) * 4, di = (y * w + x) * 4;
    out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
  }
  return { w, h, data: out, k };
}

function otsu(values) {
  const hist = new Float64Array(256); for (const v of values) hist[v | 0]++;
  let total = values.length, sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break;
    sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

// The sheet of paper is the largest bright region; its corners are the extreme points along the diagonals.
export function findSheet(photo) {
  const s = shrink(photo, 900), n = s.w * s.h, L = new Uint8Array(n);
  for (let i = 0; i < n; i++) L[i] = lum(s.data, i * 4);
  const thr = otsu(L), bright = new Uint8Array(n);
  for (let i = 0; i < n; i++) bright[i] = L[i] > thr ? 1 : 0;
  // largest 4-connected bright component
  const lab = new Int32Array(n); let best = 0, bestId = 0, id = 0; const st = [];
  for (let i = 0; i < n; i++) {
    if (!bright[i] || lab[i]) continue;
    id++; let c = 0; lab[i] = id; st.push(i);
    while (st.length) {
      const j = st.pop(); c++; const x = j % s.w;
      for (const k of [j - 1, j + 1, j - s.w, j + s.w]) {
        if (k < 0 || k >= n || lab[k] || !bright[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === s.w - 1)) continue;
        lab[k] = id; st.push(k);
      }
    }
    if (c > best) { best = c; bestId = id; }
  }
  if (best < n * 0.08) return null; // no sheet-sized bright region: not a photo of a print
  let tl = [0, 0, 1e9], tr = [0, 0, -1e9], br = [0, 0, -1e9], bl = [0, 0, 1e9];
  for (let i = 0; i < n; i++) if (lab[i] === bestId) {
    const x = i % s.w, y = (i / s.w) | 0;
    if (x + y < tl[2]) tl = [x, y, x + y];
    if (x + y > br[2]) br = [x, y, x + y];
    if (x - y > tr[2]) tr = [x, y, x - y];
    if (x - y < bl[2]) bl = [x, y, x - y];
  }
  return [tl, tr, br, bl].map(([x, y]) => [x * s.k, y * s.k]);
}

// Homography from 4 point pairs (src -> dst), solved as an 8x8 linear system.
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) if (r !== c) { const k = A[r][c] / A[c][c]; for (let j = c; j < 8; j++) A[r][j] -= k * A[c][j]; b[r] -= k * b[c]; }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

// Resample the photo into the reference frame: H maps reference pixels to photo pixels.
export function warpToRef(photo, H, w, h) {
  const out = new Uint8Array(w * h * 4), d = photo.data, W = photo.w, Hh = photo.h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const z = H[6] * x + H[7] * y + H[8], px = (H[0] * x + H[1] * y + H[2]) / z, py = (H[3] * x + H[4] * y + H[5]) / z;
    const o = (y * w + x) * 4;
    if (px < 0 || py < 0 || px >= W - 1 || py >= Hh - 1) { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 255; continue; }
    const x0 = px | 0, y0 = py | 0, fx = px - x0, fy = py - y0, i = (y0 * W + x0) * 4;
    for (let c = 0; c < 3; c++) {
      out[o + c] = (d[i + c] * (1 - fx) + d[i + 4 + c] * fx) * (1 - fy) + (d[i + W * 4 + c] * (1 - fx) + d[i + W * 4 + 4 + c] * fx) * fy;
    }
    out[o + 3] = 255;
  }
  return { w, h, data: out };
}

// Pen red: clearly red, and dark enough to be ink rather than a pinkish face shading.
const isPen = (r, g, b) => r - g > 55 && r - b > 45 && g < 150 && r > 90;
// Red the CAD sheet already has (red PMI, red title text) must not read as a markup.
const isRedInk = (r, g, b) => r - g > 60 && r - b > 40;

export function readMarkups(photo, ref, opts = {}) {
  const t0 = Date.now();
  const corners = findSheet(photo);
  if (!corners) return { error: 'Could not find a printed sheet in the photo. Photograph the whole sheet on a darker surface.' };
  const { w, h } = ref;
  const H = homography([[0, 0], [w, 0], [w, h], [0, h]], corners);
  let warped = warpToRef(photo, H, w, h);
  // refine the four-corner fit with the drawing's own line work (paper edges are a few pixels off)
  const p = register(inkMask(toGray(ref)), inkMask(toGray(warped)), { levels: [8, 4, 2] });
  const rw = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = p[0] * x + p[1] * y + p[2], sy = p[3] * x + p[4] * y + p[5], o = (y * w + x) * 4;
    const ix = Math.round(sx), iy = Math.round(sy);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) { rw[o] = rw[o + 1] = rw[o + 2] = rw[o + 3] = 255; continue; }
    const i = (iy * w + ix) * 4; rw[o] = warped.data[i]; rw[o + 1] = warped.data[i + 1]; rw[o + 2] = warped.data[i + 2]; rw[o + 3] = 255;
  }
  warped = { w, h, data: rw };
  // pen pixels, minus anything near red ink that is printed on the CAD sheet
  const tol = opts.tol ?? 4, refRed = new Uint8Array(w * h), pen = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < pen.length; i += 4, j++) {
    if (isRedInk(ref.data[i], ref.data[i + 1], ref.data[i + 2])) refRed[j] = 1;
    if (isPen(warped.data[i], warped.data[i + 1], warped.data[i + 2])) pen[j] = 1;
  }
  const redNear = dilate(refRed, w, h, tol);
  let count = 0;
  for (let j = 0; j < pen.length; j++) { if (redNear[j]) pen[j] = 0; count += pen[j]; }
  const raw = blobs(pen, w, h).filter((b) => b.n >= (opts.minPx ?? 25));
  // each mark keeps its pen strokes, so a loop drawn round a feature can say which change it points at
  const marks = mergeBoxes(raw, opts.gap ?? 48)
    .filter((b) => b.n >= (opts.minMark ?? 60))
    .map((b, i) => ({ id: `m${i + 1}`, n: i + 1, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, px: b.n,
      parts: raw.filter((r) => r.x0 >= b.x0 && r.x1 <= b.x1 && r.y0 >= b.y0 && r.y1 <= b.y1).map((r) => [r.x0, r.y0, r.x1, r.y1, r.n]) }));
  return { marks, corners, transform: p, warped, penPixels: count, ms: Date.now() - t0 };
}

function dilate(m, w, h, r) {
  const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) { let last = -1e9; for (let x = 0; x < w; x++) { if (m[y * w + x]) last = x; t[y * w + x] = x - last <= r ? 1 : 0; } last = 1e9; for (let x = w - 1; x >= 0; x--) { if (m[y * w + x]) last = x; if (last - x <= r) t[y * w + x] = 1; } }
  for (let x = 0; x < w; x++) { let last = -1e9; for (let y = 0; y < h; y++) { if (t[y * w + x]) last = y; o[y * w + x] = y - last <= r ? 1 : 0; } last = 1e9; for (let y = h - 1; y >= 0; y--) { if (t[y * w + x]) last = y; if (last - y <= r) o[y * w + x] = 1; } }
  return o;
}

function blobs(m, w, h) {
  const lab = new Int32Array(w * h), out = []; const st = [];
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || lab[i]) continue;
    const b = { x0: 1e9, y0: 1e9, x1: -1, y1: -1, n: 0 }; lab[i] = 1; st.push(i);
    while (st.length) {
      const j = st.pop(), x = j % w, y = (j / w) | 0; b.n++;
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { // pen strokes break up: link within 2 px
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = yy * w + xx; if (m[k] && !lab[k]) { lab[k] = 1; st.push(k); }
      }
    }
    out.push(b);
  }
  return out;
}

function mergeBoxes(bs, gap) {
  const out = bs.map((b) => ({ ...b }));
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      if (a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1) {
        a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0); a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1); a.n += b.n;
        out.splice(j, 1); changed = true; j--;
      }
    }
  }
  return out;
}

// The change a pen mark points at: one its pen loop encloses first (a ring drawn round a feature), else the one its
// strokes overlap most, else none.
export function markTarget(m, clouds) {
  const touching = clouds.filter((c) => c.x0 <= m.x1 && m.x0 <= c.x1 && c.y0 <= m.y1 && m.y0 <= c.y1);
  if (!touching.length) return null;
  const ring = (p) => { const w = p[2] - p[0], h = p[3] - p[1]; return w > 12 && h > 12 && p[4] / (w * h) < 0.35; };
  const inside = (c, p) => { const x = (c.x0 + c.x1) / 2, y = (c.y0 + c.y1) / 2; return x >= p[0] && x <= p[2] && y >= p[1] && y <= p[3]; };
  const enclosed = touching.filter((c) => (m.parts || []).some((p) => ring(p) && inside(c, p)));
  if (enclosed.length) return enclosed[0];
  const over = (c) => Math.max(0, Math.min(c.x1, m.x1) - Math.max(c.x0, m.x0)) * Math.max(0, Math.min(c.y1, m.y1) - Math.max(c.y0, m.y0)) / Math.max(1, (c.x1 - c.x0) * (c.y1 - c.y0));
  return touching.reduce((a, c) => (over(c) > over(a) ? c : a));
}
