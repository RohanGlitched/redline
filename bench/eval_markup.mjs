// usage: node eval_markup.mjs <photos_dir> [limit]
import fs from 'node:fs';
import path from 'node:path';
import { readMarkups } from '../static/lighttable/src/engine/markup.mjs';

const [dir, lim] = process.argv.slice(2);
const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).slice(0, lim ? +lim : undefined);

function ppm(f) { // binary PPM (P6) -> RGBA
  const b = fs.readFileSync(f); let pos = 0; const tok = [];
  while (tok.length < 4) {
    while (/\s/.test(String.fromCharCode(b[pos]))) pos++;
    let s = ''; while (!/\s/.test(String.fromCharCode(b[pos]))) s += String.fromCharCode(b[pos++]); tok.push(s);
  }
  pos++;
  const w = +tok[1], h = +tok[2], out = new Uint8Array(w * h * 4);
  for (let i = 0, j = pos; i < w * h; i++, j += 3) { out[i * 4] = b[j]; out[i * 4 + 1] = b[j + 1]; out[i * 4 + 2] = b[j + 2]; out[i * 4 + 3] = 255; }
  return { w, h, data: out };
}

const pad = 10, hit = (c, r) => !(c.x1 < r[0] - pad || c.x0 > r[2] + pad || c.y1 < r[1] - pad || c.y0 > r[3] + pad);
let found = 0, total = 0, fp = 0, fails = 0, ms = 0; const byKind = {};
for (const e of idx) {
  const photo = ppm(path.join(dir, e.id + '.ppm')), ref = ppm(path.join(dir, e.id + '_ref.ppm'));
  const r = readMarkups(photo, ref);
  if (r.error) { fails++; total += e.marks.length; console.log(e.id, 'FAILED', r.error); continue; }
  ms += r.ms;
  const f = r.marks.filter((m) => !e.marks.some((t) => hit(m, t.box))).length; fp += f;
  for (const t of e.marks) {
    const ok = r.marks.some((m) => hit(m, t.box)); byKind[t.kind] ??= [0, 0]; byKind[t.kind][1]++; if (ok) byKind[t.kind][0]++;
    total++; if (ok) found++;
  }
  console.log(e.id, `marks ${r.marks.length} truth ${e.marks.length} false ${f} ${r.ms}ms`);
}
console.log(JSON.stringify({ photos: idx.length, sheetNotFound: fails, recall: +(found / total).toFixed(3), found, total, falsePerPhoto: +(fp / idx.length).toFixed(2),
  byKind: Object.fromEntries(Object.entries(byKind).map(([k, [a, b]]) => [k, `${a}/${b}`])), avgMs: Math.round(ms / Math.max(1, idx.length - fails)) }));
