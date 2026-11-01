// Redline core (gate version): align rev B onto rev A, diff the line work, group changes into clouds.
// Pure JS on grayscale rasters {w, h, data: Uint8Array}; no dependencies, runs in browsers and Node.

export function inkMask(img, frac = 0.62) {
  const { w, h, data } = img;
  // paper level = 95th percentile brightness; ink = darker than 55% of paper (drops light face shading)
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 7) hist[data[i]]++;
  let tot = 0; for (const v of hist) tot += v;
  let acc = 0, paper = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= tot * 0.05) { paper = v; break; } }
  const thr = paper * frac;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = data[i] < thr ? 1 : 0;
  return { w, h, data: m };
}

function boxBlur(src, w, h, r) { // separable box blur on Float32Array, applied twice ~ gaussian
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), k = 2 * r + 1;
  for (let pass = 0; pass < 2; pass++) {
    const a = pass === 0 ? src : out;
    for (let y = 0; y < h; y++) {
      let s = 0; const o = y * w;
      for (let x = -r; x <= r; x++) s += a[o + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[o + x] = s / k;
        s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / k;
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
  return out;
}

function downInk(m, f) { // max-pool a binary mask by factor f -> Float32Array
  const w = Math.floor(m.w / f), h = Math.floor(m.h / f), o = new Float32Array(w * h);
  for (let y = 0; y < m.h - f + 1; y++) {
    const oy = Math.floor(y / f); if (oy >= h) break;
    for (let x = 0; x < m.w - f + 1; x++) if (m.data[y * m.w + x]) { const ox = Math.floor(x / f); if (ox < w) o[oy * w + ox] = 1; }
  }
  return { w, h, data: o };
}

function sample(img, w, h, x, y) {
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 0;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + w] * (1 - fx) + img[i + w + 1] * fx) * fy;
}

function moments(m) {
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.data[y * m.w + x]) { n++; sx += x; sy += y; }
  const cx = sx / n, cy = sy / n; let v = 0;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.data[y * m.w + x]) v += (x - cx) ** 2 + (y - cy) ** 2;
  return { cx, cy, r: Math.sqrt(v / n) };
}

// Affine p = [a, b, tx, c, d, ty] maps A-frame (x, y) -> B-frame (a x + b y + tx, c x + d y + ty).
// Forward-additive Lucas-Kanade on blurred ink maps over a pyramid.
export function register(A, B, opts = {}) {
  const mA = moments(A), mB = moments(B);
  // a sheet with no ink (a blank placeholder, or everything erased) cannot be lined up: compare as drawn
  if (!(mA.r > 0) || !(mB.r > 0)) return [1, 0, 0, 0, 1, 0];
  const s0 = mB.r / mA.r;
  let p = [s0, 0, mB.cx - s0 * mA.cx, 0, s0, mB.cy - s0 * mA.cy];
  for (const f of opts.levels || [16, 8, 4, 2]) {
    const a = downInk(A, f), b = downInk(B, f);
    const r = f >= 8 ? 2 : 1;
    const Ia = boxBlur(a.data, a.w, a.h, r), Ib = boxBlur(b.data, b.w, b.h, r);
    // gradients of Ib
    const gx = new Float32Array(b.w * b.h), gy = new Float32Array(b.w * b.h);
    for (let y = 1; y < b.h - 1; y++) for (let x = 1; x < b.w - 1; x++) {
      const i = y * b.w + x; gx[i] = (Ib[i + 1] - Ib[i - 1]) / 2; gy[i] = (Ib[i + b.w] - Ib[i - b.w]) / 2;
    }
    let q = [p[0], p[1], p[2] / f, p[3], p[4], p[5] / f];
    const step = Math.max(1, Math.round(Math.sqrt(a.w * a.h / 60000)));
    for (let it = 0; it < 40; it++) {
      const H = new Float64Array(36), g = new Float64Array(6);
      for (let y = 0; y < a.h; y += step) for (let x = 0; x < a.w; x += step) {
        const ia = Ia[y * a.w + x];
        const bx = q[0] * x + q[1] * y + q[2], by = q[3] * x + q[4] * y + q[5];
        const ib = sample(Ib, b.w, b.h, bx, by);
        if (ia === 0 && ib === 0) continue;
        const e = ia - ib, Gx = sample(gx, b.w, b.h, bx, by), Gy = sample(gy, b.w, b.h, bx, by);
        const J = [Gx * x, Gx * y, Gx, Gy * x, Gy * y, Gy];
        for (let i = 0; i < 6; i++) { g[i] += J[i] * e; for (let j = 0; j < 6; j++) H[i * 6 + j] += J[i] * J[j]; }
      }
      for (let i = 0; i < 6; i++) H[i * 6 + i] *= 1.0001;
      const d = solve6(H, g); if (!d) break;
      for (let i = 0; i < 6; i++) q[i] += d[i];
      if (Math.abs(d[2]) + Math.abs(d[5]) < 0.01 && Math.abs(d[0]) + Math.abs(d[4]) < 1e-5) break;
    }
    p = [q[0], q[1], q[2] * f, q[3], q[4], q[5] * f];
  }
  return p;
}

function solve6(H, g) {
  const n = 6, M = [];
  for (let i = 0; i < n; i++) { M.push([]); for (let j = 0; j < n; j++) M[i].push(H[i * n + j]); M[i].push(g[i]); }
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function warpGray(B, p, w, h) { // resample B into A frame
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const bx = p[0] * x + p[1] * y + p[2], by = p[3] * x + p[4] * y + p[5];
    out[y * w + x] = bx < 0 || by < 0 || bx >= B.w - 1 || by >= B.h - 1 ? 255 : Math.round(sample(B.data, B.w, B.h, bx, by));
  }
  return { w, h, data: out };
}

function dilate(m, w, h, r) { // square dilation via two 1-D passes
  const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -1e9; const row = y * w;
    for (let x = 0; x < w; x++) { if (m[row + x]) last = x; t[row + x] = x - last <= r ? 1 : 0; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (m[row + x]) last = x; if (last - x <= r) t[row + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) { if (t[y * w + x]) last = y; o[y * w + x] = y - last <= r ? 1 : 0; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (t[y * w + x]) last = y; if (last - y <= r) o[y * w + x] = 1; }
  }
  return o;
}

function components(m, w, h) {
  const lab = new Int32Array(w * h), boxes = []; let n = 0; const st = [];
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || lab[i]) continue;
    n++; lab[i] = n; st.push(i); let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, c = 0;
    while (st.length) {
      const j = st.pop(), x = j % w, y = (j / w) | 0; c++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= m.length || lab[k] || !m[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === w - 1)) continue;
        lab[k] = n; st.push(k);
      }
    }
    boxes.push({ id: n, x0, y0, x1, y1, area: c });
  }
  return { lab, boxes };
}

function paperLevel(img) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i += 7) hist[img.data[i]]++;
  let tot = 0; for (const v of hist) tot += v;
  let acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= tot * 0.05) return Math.max(v, 1); }
  return 255;
}

export function noiseLevel(img) { // mean neighbour difference on blank paper: ~0 for rendered PDFs, >2 for scans/photos
  const p = paperLevel(img), { w, data } = img; let n = 0, s = 0;
  for (let i = 0; i < data.length - 1; i += 5) {
    const v = data[i], u = data[i + 1];
    if (v > p * 0.9 && u > p * 0.9 && (i + 1) % w) { n++; s += Math.abs(v - u); }
  }
  return n ? s / n : 0;
}

function darkness(img, ridge, smooth) { // 0 = paper, 1 = black, relative to this sheet's paper
  const p = paperLevel(img); let o = new Float32Array(img.data.length);
  for (let i = 0; i < o.length; i++) o[i] = Math.max(0, (p - img.data[i]) / p);
  if (smooth) o = boxBlur(o, img.w, img.h, smooth);
  if (!ridge) return o;
  // keep only line-like darkness (white top-hat): an opening wider than any stroke keeps flat face
  // shading but erases lines and lettering, so subtracting it leaves just the line work
  const bg = maxFilter(minFilter(o, img.w, img.h, ridge), img.w, img.h, ridge);
  for (let i = 0; i < o.length; i++) o[i] = Math.max(0, o[i] - bg[i]);
  return o;
}

function minFilter(src, w, h, r) {
  const neg = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) neg[i] = 1 - src[i];
  const m = maxFilter(neg, w, h, r);
  for (let i = 0; i < m.length; i++) m[i] = 1 - m[i];
  return m;
}

function maxFilter(src, w, h, r) { // square max filter, separable
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0; const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      for (let k = a; k <= b; k++) if (src[row + k] > m) m = src[row + k];
      t[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = 0; const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
    for (let k = a; k <= b; k++) if (t[k * w + x] > m) m = t[k * w + x];
    o[y * w + x] = m;
  }
  return o;
}

export function diff(A, Bw, opts = {}) {
  const { w, h } = A, tol = opts.tol ?? 2, gap = opts.gap ?? 12, minPx = opts.minPx ?? 14;
  // a pixel is ink if it is >= `ink` darker than paper; it changed if the other sheet keeps < `keep`
  // of that darkness anywhere within `tol` px (so faded or thicker scanned lines still match)
  const ink = opts.ink ?? 0.3, keep = opts.keep ?? 1;
  const sm = (img) => opts.smooth ?? (noiseLevel(img) > (opts.noisy ?? 0.4) ? 1 : 0);
  const da = darkness(A, opts.ridge ?? 0, sm(A)), db = darkness(Bw, opts.ridge ?? 0, sm(Bw));
  const ma = maxFilter(da, w, h, tol), mb = maxFilter(db, w, h, tol);
  const add = new Uint8Array(w * h), rem = new Uint8Array(w * h), any = new Uint8Array(w * h);
  for (let i = 0; i < da.length; i++) {
    if (db[i] >= ink && ma[i] < (opts.abs !== false ? ink * keep : keep * db[i])) add[i] = 1;
    if (da[i] >= ink && mb[i] < (opts.abs !== false ? ink * keep : keep * da[i])) rem[i] = 1;
  }
  // drop specks: a change pixel needs >= 2 change neighbours in its 3x3
  for (const m of [add, rem]) {
    const c = m.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (!c[i]) continue;
      const s = c[i - 1] + c[i + 1] + c[i - w] + c[i + w] + c[i - w - 1] + c[i - w + 1] + c[i + w - 1] + c[i + w + 1];
      if (s < 2) m[i] = 0;
    }
    for (let i = 0; i < m.length; i++) if (m[i]) any[i] = 1;
  }
  // 1) small blobs of changed pixels
  const blobs = boxesOf(any, w, h, opts.link ?? 3).filter((bx) => bx.n >= (opts.minBlob ?? 6));
  // 2) second look: a faded or re-weighted line keeps its shape, a real edit does not. Normalised
  // cross-correlation ignores contrast, so blobs whose patches still match after a small local
  // shift are dropped.
  const noisy = Math.max(noiseLevel(A), noiseLevel(Bw)) > (opts.noisy ?? 0.4);
  const tau = opts.ncc ?? (noisy ? 0.94 : 9);
  let kept = blobs, rejected = [];
  if (tau < 1.5) {
    const sa = darkness(A, 0, 1), sb = darkness(Bw, 0, 1);
    for (const bx of blobs) bx.ncc = bestNcc(sa, sb, w, h, bx, 3, 6);
    kept = blobs.filter((bx) => bx.ncc < tau); rejected = blobs.filter((bx) => bx.ncc >= tau);
  }
  // 3) merge surviving blobs that sit within `gap` px into revision clouds
  const clouds = mergeBoxes(kept, gap).map((c) => {
    let ad = 0, rm = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) { const i = y * w + x; ad += add[i]; rm += rem[i]; }
    return { ...c, added: ad, removed: rm, kind: ad && rm ? 'changed' : ad ? 'added' : 'removed' };
  }).filter((c) => c.added + c.removed >= minPx);
  // 4) on clean (vector) drawings, a re-exported PDF can nudge line work by a pixel or two. A cloud whose
  // before and after patches match almost perfectly once shifted up to `shiftPx` (about 0.7 mm) is a
  // re-plot shift, not an edit, and is set aside with the rejected blobs. Each blob in the cloud has to
  // match on its own too, so one changed digit inside a nudged block keeps the whole cloud.
  let final = clouds;
  if (!noisy && (opts.shiftTau ?? 0.985) < 1) {
    const ra = darkness(A, 0, 0), rb = darkness(Bw, 0, 0);
    final = [];
    for (const c of clouds) {
      const sTau = opts.shiftTau ?? 0.985, sPx = opts.shiftPx ?? 4;
      c.shiftNcc = bestNcc(ra, rb, w, h, c, sPx, 4);
      if (c.shiftNcc >= sTau) {
        // (long slivers under 3 px across are line work redrawn in place; small dots such as a decimal point still count)
        const inside = kept.filter((b) => b.x0 >= c.x0 && b.x1 <= c.x1 && b.y0 >= c.y0 && b.y1 <= c.y1 && !(Math.min(b.x1 - b.x0, b.y1 - b.y0) < 3 && Math.max(b.x1 - b.x0, b.y1 - b.y0) > 8));
        const worst = Math.min(1, ...inside.map((b) => bestNcc(ra, rb, w, h, b, sPx, 2)));
        if (worst >= sTau) { c.shiftNccWorst = worst; rejected.push(c); continue; }
        c.shiftNcc = worst;
      }
      // 5) the same content a little further away is a move: say how far, so a checker can tell a
      // nudged label from a hole that moved 3 mm
      // (a move needs ink on both sides: something added or removed alone is never a move)
      if (c.kind === 'changed') {
        const m = moveOf(add, rem, da, db, ink, w, h, c, opts.moveMaxPx ?? 30);
        c.moveFit = Math.round(m.fit * 100) / 100;
        if (m.fit >= (opts.moveTau ?? 0.6)) c.moved = { dx: m.dx, dy: m.dy };
      }
      final.push(c);
    }
  }
  return { clouds: final, rejected, add, rem };
}

function boxesOf(m, w, h, link) {
  const grown = link ? dilate(m, w, h, link) : m;
  const { lab, boxes } = components(grown, w, h);
  const byId = new Map(boxes.map((b) => [b.id, { x0: 1e9, y0: 1e9, x1: -1, y1: -1, n: 0 }]));
  for (let i = 0; i < m.length; i++) if (m[i]) {
    const b = byId.get(lab[i]), x = i % w, y = (i / w) | 0; b.n++;
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
  }
  return [...byId.values()].filter((b) => b.n);
}

function mergeBoxes(bs, gap) {
  const out = bs.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      if (a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1) {
        a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0); a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
        out.splice(j, 1); changed = true; j--;
      }
    }
  }
  return out;
}

// A move: the ink that disappeared reappears, same shape, a short distance away. For each shift, removed
// pixels must land on revision B's ink and added pixels, shifted back, on revision A's; the fit is the
// weaker of the two shares, so a shape that merely sits near other ink does not count.
function moveOf(add, rem, da, db, ink, w, h, c, maxPx) {
  const rp = [], ap = [];
  for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
    const i = y * w + x;
    if (rem[i]) rp.push(i);
    if (add[i]) ap.push(i);
  }
  if (rp.length < 8 || ap.length < 8) return { fit: 0, dx: 0, dy: 0 };
  const thin = (arr, n) => (arr.length > n ? arr.filter((_, k) => k % Math.ceil(arr.length / n) === 0) : arr);
  const share = (pts, img, dx, dy) => {
    let hits = 0;
    for (const i of pts) { const x = (i % w) + dx, y = ((i / w) | 0) + dy; if (x >= 0 && x < w && y >= 0 && y < h && img[y * w + x] >= ink) hits++; }
    return hits / pts.length;
  };
  const fitAt = (R, Ad, dx, dy, floor) => { const f1 = share(R, db, dx, dy); return f1 <= floor ? 0 : Math.min(f1, share(Ad, da, -dx, -dy)); };
  // coarse to fine: every other shift on a sample of 400 pixels, then every shift near the best few at full
  // detail (up to 2,000 pixels). About 15 times less work than trying every shift at full detail.
  const r1 = thin(rp, 400), a1 = thin(ap, 400), coarse = [];
  for (let dy = -maxPx; dy <= maxPx; dy += 2) for (let dx = -maxPx; dx <= maxPx; dx += 2) {
    if (Math.abs(dx) + Math.abs(dy) < 2) continue;
    const fit = fitAt(r1, a1, dx, dy, 0.3);
    if (fit > 0.3) coarse.push({ fit, dx, dy });
  }
  coarse.sort((p, q) => q.fit - p.fit);
  const R = thin(rp, 2000), Ad = thin(ap, 2000), tried = new Set();
  let best = { fit: 0, dx: 0, dy: 0 };
  for (const k of coarse.slice(0, 4)) for (let dy = k.dy - 1; dy <= k.dy + 1; dy++) for (let dx = k.dx - 1; dx <= k.dx + 1; dx++) {
    if (Math.abs(dx) + Math.abs(dy) < 2 || Math.abs(dx) > maxPx || Math.abs(dy) > maxPx || tried.has(dy * 1000 + dx)) continue;
    tried.add(dy * 1000 + dx);
    const fit = fitAt(R, Ad, dx, dy, best.fit);
    if (fit > best.fit) best = { fit, dx, dy };
  }
  return best;
}

function bestNcc(a, b, w, h, c, shift, pad) {
  const x0 = Math.max(shift, c.x0 - pad), y0 = Math.max(shift, c.y0 - pad);
  const x1 = Math.min(w - 1 - shift, c.x1 + pad), y1 = Math.min(h - 1 - shift, c.y1 + pad);
  let best = -1;
  const st = Math.max(1, Math.round(Math.sqrt((x1 - x0) * (y1 - y0) / 20000)));
  for (let dy = -shift; dy <= shift; dy++) for (let dx = -shift; dx <= shift; dx++) {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let y = y0; y <= y1; y += st) for (let x = x0; x <= x1; x += st) {
      const va = a[y * w + x], vb = b[(y + dy) * w + x + dx];
      n++; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
    const cov = sab - sa * sb / n, va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    // two flat patches match only when they are the same tone (white paper is not solid ink)
    const r = va > 1e-9 && vb > 1e-9 ? cov / Math.sqrt(va * vb) : (va <= 1e-9 && vb <= 1e-9 && Math.abs(sa - sb) / n < 0.1 ? 1 : 0);
    if (r > best) best = r;
  }
  return best;
}

export function compare(A, B, opts = {}) {
  const t0 = Date.now();
  const p = register(inkMask(A), inkMask(B), opts);
  const t1 = Date.now();
  const Bw = warpGray(B, p, A.w, A.h);
  // a scanned or photocopied revision gets a wider line tolerance (3 px instead of 2): its lines are
  // thicker and fuzzier than the PDF's
  const scanned = Math.max(noiseLevel(A), noiseLevel(Bw)) > (opts.noisy ?? 0.4);
  const r = diff(A, Bw, { tol: scanned ? 3 : 2, ...opts });
  return { ...r, transform: p, ms: { register: t1 - t0, diff: Date.now() - t1 } };
}
