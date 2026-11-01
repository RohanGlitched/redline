// Turns two drawing revisions into everything the light table shows: rasters, the registered overlay,
// revision clouds with drawing zones, and the links between clouds and the change notes.
import { renderPage } from './pdf.js';
import { compare, warpGray } from './engine/core.mjs';
import { readMarkups } from './engine/markup.mjs';
import { numbersIn } from '../../../shared/gate.mjs';
import { withHousekeeping } from './engine/housekeeping.mjs';
import { revisionOfName, titleBlockRevision } from './engine/titleblock.mjs';

export { ENGINE_VERSION } from '../../../shared/review.mjs';
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ASME Y14.1 style zones: columns numbered right to left, rows lettered bottom to top.
export const ZONE_COLS = 8, ZONE_ROWS = 6;
export function zoneOf(c, w, h) {
  const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
  const col = ZONE_COLS - Math.min(ZONE_COLS - 1, Math.floor((cx / w) * ZONE_COLS));
  const row = String.fromCharCode(65 + Math.min(ZONE_ROWS - 1, Math.floor(((h - cy) / h) * ZONE_ROWS)));
  return row + col;
}

// Fetch an attachment's bytes in slices (Forge caps one response at 5 MB).
// Each attachment is downloaded once per light table session; every sheet and both passes reuse it.
const files = new Map();
export function fetchBytes(invoke, id) {
  if (!files.has(id)) files.set(id, download(invoke, id).catch((e) => { files.delete(id); throw e; }));
  return files.get(id);
}

async function download(invoke, id) {
  let first = await invoke('getAttachment', { id, offset: 0 });
  const out = new Uint8Array(first.size);
  let off = 0, part = first;
  for (;;) {
    const bytes = b64(part.data); out.set(bytes, off); off += bytes.length;
    if (off >= first.size || !bytes.length) break;
    part = await invoke('getAttachment', { id, offset: off });
  }
  return out;
}

export async function loadRevision(invoke, att, dpi, page = 1, maxPixels) {
  // pdf.js takes ownership of the buffer it is given, so it gets a copy and the cached file stays usable
  return renderPage((await fetchBytes(invoke, att.id)).slice(), page, dpi, maxPixels);
}

// The drawing text inside a change, before and after, and the numbers that are new in revision B. Boxes
// are in analysis pixels on revision A; revision B's text is found through the registration transform.
function textOf(c, textsA = [], textsB = [], T, k) {
  const pad = 10, hit = (t, x0, y0, x1, y1) => t.x1 / k >= x0 && t.x0 / k <= x1 && t.y1 / k >= y0 && t.y0 / k <= y1;
  const inA = textsA.filter((t) => hit(t, c.x0 - pad, c.y0 - pad, c.x1 + pad, c.y1 + pad));
  const corners = [[c.x0, c.y0], [c.x1, c.y0], [c.x0, c.y1], [c.x1, c.y1]].map(([x, y]) => [T[0] * x + T[1] * y + T[2], T[3] * x + T[4] * y + T[5]]);
  const bx = corners.map((p) => p[0]), by = corners.map((p) => p[1]);
  const inB = textsB.filter((t) => hit(t, Math.min(...bx) - pad, Math.min(...by) - pad, Math.max(...bx) + pad, Math.max(...by) + pad));
  const clean = (ts) => ts.map((t) => t.str.trim()).join(' ').replace(/\uFFFD/g, 'Ø').replace(/\s+/g, ' ').trim();
  const before = clean(inA), after = clean(inB);
  if (before === after) return {};
  const old = new Set(numbersIn(before));
  return { before, after, values: [...new Set(numbersIn(after).filter((v) => !old.has(v)))] };
}

// How far and which way a change's content moved, in millimetres on the sheet.
function moveOf(m, dpi) {
  if (!m) return undefined;
  const mm = (Math.hypot(m.dx, m.dy) * 25.4) / dpi;
  const dirs = [m.dx > 1 ? 'right' : m.dx < -1 ? 'left' : null, m.dy > 1 ? 'down' : m.dy < -1 ? 'up' : null].filter(Boolean);
  return { mm: Math.round(mm * 10) / 10, dir: dirs.join(' and ') };
}

// The drawing text in the change reads the same before and after (it only moved or was re-plotted).
function sameTextOf(c, textsA = [], textsB = [], T, k) {
  const t = textOf(c, textsA, textsB, T, k);
  if (t.before !== undefined) return false;
  const pad = 10, hit = (w) => w.x1 / k >= c.x0 - pad && w.x0 / k <= c.x1 + pad && w.y1 / k >= c.y0 - pad && w.y0 / k <= c.y1 + pad;
  return textsA.some(hit);
}

// The share of a change's changed pixels that lie inside the drawing's text: removed ink checked against
// revision A's text boxes, added ink against revision B's. A moved hole with its callout is mostly not text.
function textShareOf(c, A, Bw, textsA = [], textsB = [], T, k) {
  const pad = 3, near = (ts, x0, y0, x1, y1) => ts.filter((t) => t.x1 / k >= x0 - 20 && t.x0 / k <= x1 + 20 && t.y1 / k >= y0 - 20 && t.y0 / k <= y1 + 20);
  const tA = near(textsA, c.x0, c.y0, c.x1, c.y1);
  const cb = [[c.x0, c.y0], [c.x1, c.y1], [c.x0, c.y1], [c.x1, c.y0]].map(([x, y]) => [T[0] * x + T[1] * y + T[2], T[3] * x + T[4] * y + T[5]]);
  const tB = near(textsB, Math.min(...cb.map((q) => q[0])), Math.min(...cb.map((q) => q[1])), Math.max(...cb.map((q) => q[0])), Math.max(...cb.map((q) => q[1])));
  if (!tA.length && !tB.length) return 0;
  const inBox = (ts, x, y) => ts.some((t) => x >= t.x0 / k - pad && x <= t.x1 / k + pad && y >= t.y0 / k - pad && y <= t.y1 / k + pad);
  let n = 0, hit = 0;
  for (let y = c.y0; y <= c.y1; y += 2) for (let x = c.x0; x <= c.x1; x += 2) {
    const a = A.data[y * A.w + x] < 140, b = Bw.data[y * A.w + x] < 140;
    if (a === b) continue;
    n++;
    if (a ? inBox(tA, x, y) : inBox(tB, T[0] * x + T[1] * y + T[2], T[3] * x + T[4] * y + T[5])) hit++;
  }
  return n ? hit / n : 0;
}

// A sheet only one revision has: the whole sheet is one change, which has to be declared like any other.
function wholeSheet(present, side, k) {
  const img = downsample(present, k);
  let x0 = img.w, y0 = img.h, x1 = 0, y1 = 0;
  for (let y = 0; y < img.h; y += 2) for (let x = 0; x < img.w; x += 2) {
    if (img.data[y * img.w + x] < 140) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 <= x0) { x0 = 0; y0 = 0; x1 = img.w - 1; y1 = img.h - 1; }
  const blank = { w: present.w, h: present.h, data: new Uint8Array(present.w * present.h).fill(255) };
  return { img, blank, cloud: { x0, y0, x1, y1, kind: side === 'A' ? 'sheetRemoved' : 'sheetAdded' } };
}

// The overlay a checker reads on a light table: shared line work in graphite, lines only on rev A in red
// (gone in rev B), lines only on rev B in blue (new in rev B). Face shading is kept faint.
export function composite(A, Bw) {
  const { w, h } = A, out = new ImageData(w, h), d = out.data;
  for (let i = 0, j = 0; i < A.data.length; i++, j += 4) {
    const a = 1 - A.data[i] / 255, b = 1 - Bw.data[i] / 255; // darkness 0..1
    const inkA = a > 0.3, inkB = b > 0.3;
    let r = 255, g = 255, bl = 255;
    if (inkA && inkB) { const k = Math.max(a, b); r = 255 - k * 212; g = 255 - k * 208; bl = 255 - k * 201; } // graphite #2B2F36
    else if (inkA) { const k = a; r = 255 - k * 40; g = 255 - k * 217; bl = 255 - k * 194; } // red #D7263D
    else if (inkB) { const k = b; r = 255 - k * 211; g = 255 - k * 181; bl = 255 - k * 101; } // diazo #2C4A9A
    else { const k = Math.max(a, b) * 0.5; r = 255 - k * 60; g = 255 - k * 55; bl = 255 - k * 40; }
    d[j] = r; d[j + 1] = g; d[j + 2] = bl; d[j + 3] = 255;
  }
  return out;
}

export function grayToImage(img, tint) {
  const out = new ImageData(img.w, img.h), d = out.data;
  for (let i = 0, j = 0; i < img.data.length; i++, j += 4) {
    const k = 1 - img.data[i] / 255;
    d[j] = 255 - k * (255 - tint[0]); d[j + 1] = 255 - k * (255 - tint[1]); d[j + 2] = 255 - k * (255 - tint[2]); d[j + 3] = 255;
  }
  return out;
}

// Match each cloud to a change-note line that names its zone ("Zone D3: ..."). Engineers already write
// zones into change notes, so this is a deterministic link, not a guess.
// The sheet a change note names ("Sheet 2, zone A7: ..."), or null when it does not name one.
export function noteSheet(text) {
  const m = /\bsheets?\s+(\d{1,3})\b/i.exec(text);
  return m ? +m[1] : null;
}

export function linkNotes(clouds, notes, sheet = 1) {
  const zoneRe = /\bzones?\s+([A-H]\d{1,2}(?:\s*(?:,|and|&)\s*[A-H]\d{1,2})*)/gi;
  const byZone = new Map();
  for (const n of notes) {
    // a note that names another sheet never declares a change on this one
    const ns = noteSheet(n.text);
    if (ns && ns !== sheet) continue;
    for (const m of n.text.matchAll(zoneRe)) for (const z of m[1].split(/\s*(?:,|and|&)\s*/i)) byZone.set(z.toUpperCase(), n.n);
  }
  // A note claims a cloud outright only when it is the single change in the zone the note names.
  // Two changes in one zone, or a change one zone over, are offered as suggestions a person confirms,
  // so an undeclared edit can never hide behind a declared one next to it.
  const inZone = new Map();
  for (const c of clouds) inZone.set(c.zone, (inZone.get(c.zone) || 0) + 1);
  return clouds.map((c) => {
    if (byZone.has(c.zone) && inZone.get(c.zone) === 1) return { ...c, note: byZone.get(c.zone), suggest: null };
    const near = [c.zone, ...neighbours(c.zone)].find((z) => byZone.has(z));
    return { ...c, note: null, suggest: near ? byZone.get(near) : null };
  });
}

function neighbours(z) {
  const r = z.charCodeAt(0), c = +z.slice(1), out = [];
  for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const rr = r + dr, cc = c + dc;
    if (rr >= 65 && rr < 65 + ZONE_ROWS && cc >= 1 && cc <= ZONE_COLS) out.push(String.fromCharCode(rr) + cc);
  }
  return out;
}

// Box-filter a raster down by an integer factor (the engine works at 150 dpi).
export function downsample(img, k) {
  if (k === 1) return img;
  const w = Math.floor(img.w / k), h = Math.floor(img.h / k), out = new Uint8Array(w * h), n = k * k;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let yy = 0; yy < k; yy++) { const row = (y * k + yy) * img.w + x * k; for (let xx = 0; xx < k; xx++) s += img.data[row + xx]; }
    out[y * w + x] = s / n;
  }
  return { w, h, data: out };
}

export async function analyse(invoke, revA, revB, notes, onStage = () => {}, page = 1) {
  // Render once at display resolution (300 dpi, or 150 dpi for very large sheets) so zooming in stays
  // crisp, and give the engine a 150 dpi copy.
  onStage('Reading both revisions');
  // fetch both files together, then draw revision B at the dpi revision A got, so a change of sheet size
  // between revisions cannot turn into a change of scale
  await Promise.all([fetchBytes(invoke, revA.id), fetchBytes(invoke, revB.id)]);
  let hA = await loadRevision(invoke, revA, 300, page);
  let hB = await loadRevision(invoke, revB, hA.missing ? 300 : hA.dpi, page, 16e6);
  if (hA.missing || hB.missing) {
    if (hA.missing && hB.missing) throw new Error(`Neither revision has a sheet ${page}`);
    const present = hA.missing ? hB : hA;
    const k = Math.max(1, Math.round(present.dpi / 150));
    const w = wholeSheet(present, hA.missing ? 'B' : 'A', k);
    const A = hA.missing ? downsample(w.blank, k) : w.img, B = hA.missing ? w.img : downsample(w.blank, k);
    const hiA = hA.missing ? w.blank : present, hiBw = hA.missing ? present : w.blank;
    const clouds = [{ id: 'c1', n: 1, ...w.cloud, zone: zoneOf(w.cloud, A.w, A.h) }];
    return { A, B, Bw: B, hiA, hiBw, k, bCanvas: hB.canvas || present.canvas, clouds: linkNotes(clouds, notes, page || 1), transform: [1, 0, 0, 0, 1, 0], ms: 0, dpi: Math.round(present.dpi / k), displayDpi: Math.round(present.dpi), pages: [hA.pages, hB.pages] };
  }
  // the engine works near 150 dpi; small sheets are drawn at 300 dpi and halved, large ones used as drawn
  const k = Math.max(1, Math.round(hA.dpi / 150));
  const [A, B] = [downsample(hA, k), downsample(hB, k)];
  const dpi = Math.round(hA.dpi / k), displayDpi = Math.round(hA.dpi);
  onStage('Lining up the sheets');
  await new Promise((r) => setTimeout(r, 0));
  const t0 = performance.now();
  // distances are set in millimetres and scaled to this sheet's resolution: changes within ~7.6 mm read as
  // one edit, re-plot shifts are under ~0.7 mm, moves are measured up to ~5 mm (45, 4 and 30 px at 150 dpi)
  const px = (mm) => Math.max(1, Math.round((mm * dpi) / 25.4));
  const r = compare(A, B, { gap: px(7.62), shiftPx: px(0.68), moveMaxPx: px(5.08) });
  const Bw = warpGray(B, r.transform, A.w, A.h);
  const ms = Math.round(performance.now() - t0);
  // the same transform at display resolution: translation scales with the raster, the linear part does not
  const p = r.transform, hiA = k === 2 ? hA : A;
  const hiBw = k === 2 ? warpGray(hB, [p[0], p[1], p[2] * k, p[3], p[4], p[5] * k], hA.w, hA.h) : Bw;
  const clouds = r.clouds
    .sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0)
    .map((c, i) => withHousekeeping({ id: `c${i + 1}`, n: i + 1, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, kind: c.kind, added: c.added, removed: c.removed,
      zone: zoneOf(c, A.w, A.h), move: moveOf(c.moved, dpi), ...textOf(c, hA.texts, hB.texts, r.transform, k), sameText: sameTextOf(c, hA.texts, hB.texts, r.transform, k),
      textShare: textShareOf(c, A, Bw, hA.texts, hB.texts, r.transform, k) }));
  // The title block must name the revision this change order releases. A sheet whose title block still
  // reads the old letter is a change of its own, answered like any other; a letter that moved on as it
  // should is housekeeping.
  const expected = revisionOfName(revB.filename);
  const tA = titleBlockRevision(hA.texts, hA.w, hA.h), tB = titleBlockRevision(hB.texts, hB.w, hB.h);
  if (expected && tB && tB.letter !== expected) {
    // revision B's box, brought back onto revision A's sheet through the registration
    const [a, b, c, d, e, f] = r.transform, det = a * e - b * d || 1;
    const back = (x, y) => [(e * (x - c) - b * (y - f)) / det, (-d * (x - c) + a * (y - f)) / det];
    const p = back(tB.box.x0 / k, tB.box.y0 / k), q = back(tB.box.x1 / k, tB.box.y1 / k);
    const box = { x0: Math.max(0, Math.round(Math.min(p[0], q[0]) - 6)), y0: Math.max(0, Math.round(Math.min(p[1], q[1]) - 6)), x1: Math.min(A.w - 1, Math.round(Math.max(p[0], q[0]) + 6)), y1: Math.min(A.h - 1, Math.round(Math.max(p[1], q[1]) + 6)) };
    clouds.push({ id: `c${clouds.length + 1}`, n: clouds.length + 1, ...box, kind: 'titleBlock', zone: zoneOf(box, A.w, A.h), titleBlock: { a: tA?.letter || null, b: tB.letter, expected } });
  } else if (expected && tB && tA && tA.letter !== tB.letter) {
    const bx = tB.box, hit = (cl) => cl.x1 >= bx.x0 / k - 4 && cl.x0 <= bx.x1 / k + 4 && cl.y1 >= bx.y0 / k - 4 && cl.y0 <= bx.y1 / k + 4;
    for (const cl of clouds) if (hit(cl) && !cl.housekeeping && (cl.textShare ?? 0) >= 0.9) { cl.housekeeping = 'revLetter'; cl.revLetter = { a: tA.letter, b: tB.letter }; }
  }
  // differences the engine set aside as re-plot shifts (line work nudged under ~0.7 mm, matching once
  // shifted): not changes, but listed so a reviewer can see each one and count it back in
  const setAside = (r.rejected || []).filter((c) => c.shiftNcc !== undefined)
    .sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0)
    .map((c, i) => ({ id: `a${i + 1}`, n: i + 1, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, kind: c.kind, zone: zoneOf(c, A.w, A.h), match: Math.round(Math.min(c.shiftNcc, c.shiftNccWorst ?? 1) * 1000) / 1000 }));
  return { A, B, Bw, hiA, hiBw, k, bCanvas: hB.canvas, clouds: linkNotes(clouds, notes, page || 1), setAside, transform: r.transform, ms, dpi, displayDpi, pages: [hA.pages, hB.pages] };
}

// ---------- paper markups ----------

function rgbaOf(source, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(source, 0, 0, w, h);
  return { w, h, data: x.getImageData(0, 0, w, h).data, canvas: c };
}

// A phone photo of a printed revision, from a Jira attachment (the Jira mobile app attaches photos natively).
export async function loadPhoto(invoke, att) {
  const bmp = await createImageBitmap(new Blob([await fetchBytes(invoke, att.id)], { type: att.mimeType || 'image/jpeg' }));
  const k = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  return rgbaOf(bmp, Math.round(bmp.width * k), Math.round(bmp.height * k));
}

function invertAffine([a, b, c, d, e, f]) {
  const det = a * e - b * d;
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det];
}
const apply = (p, x, y) => [p[0] * x + p[1] * y + p[2], p[3] * x + p[4] * y + p[5]];

// Line the photo up with the latest revision (the print it came from) and find the pen marks.
// Everything returned is in rev A's frame, the frame the light table draws in.
export function readPrint(photo, res) {
  const ref = rgbaOf(res.bCanvas, res.B.w, res.B.h);
  const r = readMarkups(photo, ref);
  if (r.error) return r;
  const q = invertAffine(res.transform); // rev B frame -> rev A frame
  const marks = r.marks.map((m) => {
    const pts = [apply(q, m.x0, m.y0), apply(q, m.x1, m.y0), apply(q, m.x1, m.y1), apply(q, m.x0, m.y1)];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    return { ...m, ...box, zone: zoneOf(box, res.A.w, res.A.h) };
  });
  // the flattened photo, resampled into rev A's frame so it can sit on the light table as a layer
  const { w, h } = res.A, out = new ImageData(w, h), p = res.transform;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [bx, by] = apply(p, x, y), ix = Math.round(bx), iy = Math.round(by), o = (y * w + x) * 4;
    if (ix < 0 || iy < 0 || ix >= r.warped.w || iy >= r.warped.h) { out.data[o] = out.data[o + 1] = out.data[o + 2] = out.data[o + 3] = 255; continue; }
    const i = (iy * r.warped.w + ix) * 4, R = r.warped.data[i], G = r.warped.data[i + 1], B = r.warped.data[i + 2];
    // the print reads as paper and pencil; only the pen ink keeps its colour, so the markups carry the eye
    if (R - G > 55 && R - B > 45 && G < 150) { out.data[o] = R; out.data[o + 1] = G; out.data[o + 2] = B; }
    else { const l = 0.299 * R + 0.587 * G + 0.114 * B; out.data[o] = Math.min(255, l * 1.02 + 4); out.data[o + 1] = Math.min(255, l + 2); out.data[o + 2] = l * 0.97; }
    out.data[o + 3] = 255;
  }
  return { marks, flat: out, corners: r.corners, photo, ms: r.ms };
}

// Shrink a phone photo for upload (Forge payloads stay under ~3.5 MB once base64 encoded).
export async function photoForUpload(file) {
  const bmp = await createImageBitmap(file);
  // Forge lets the browser send its backend about 500 KB per call, so the photo is re-encoded, smaller
  // and softer step by step, until it fits with room to spare. Pen marks read well down to ~1600 px.
  let data = '';
  for (const [side, q] of [[2400, 0.86], [2400, 0.76], [2000, 0.76], [1800, 0.7], [1600, 0.66], [1400, 0.6]]) {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = rgbaOf(bmp, Math.round(bmp.width * k), Math.round(bmp.height * k)).canvas;
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    data = btoa(s);
    if (data.length < 360000) break;
  }
  return { name: (file.name || 'print-photo').replace(/\.[^.]+$/, '') + '.jpg', data };
}

// CSS matrix3d that maps an element's own pixels (src quad) onto screen points (dst quad).
export function quadMatrix(src, dst) {
  const A = [], bb = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); bb.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); bb.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let pv = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
    [A[c], A[pv]] = [A[pv], A[c]]; [bb[c], bb[pv]] = [bb[pv], bb[c]];
    for (let r = 0; r < 8; r++) if (r !== c) { const k = A[r][c] / A[c][c]; for (let j = c; j < 8; j++) A[r][j] -= k * A[c][j]; bb[r] -= k * bb[c]; }
  }
  const h = bb.map((v, i) => v / A[i][i]);
  return `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,1)`;
}
