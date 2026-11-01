// usage: node eval.mjs <bench_dir> [variant b|bs] [limit]
import fs from 'node:fs';
import path from 'node:path';
import { compare } from '../static/lighttable/src/engine/core.mjs';

const [dir, variant = 'b', limitArg] = process.argv.slice(2);
const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).slice(0, limitArg ? +limitArg : undefined);

function pgm(f) {
  const buf = fs.readFileSync(f); let pos = 0; const tok = [];
  while (tok.length < 4) {
    while (/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    if (buf[pos] === 35) { while (buf[pos] !== 10) pos++; continue; }
    let s = ''; while (!/\s/.test(String.fromCharCode(buf[pos]))) s += String.fromCharCode(buf[pos++]);
    tok.push(s);
  }
  pos++;
  const w = +tok[1], h = +tok[2];
  return { w, h, data: new Uint8Array(buf.buffer, buf.byteOffset + pos, w * h) };
}

const pad = 8, hit = (c, r) => !(c.x1 < r[0] - pad || c.x0 > r[2] + pad || c.y1 < r[1] - pad || c.y0 > r[3] + pad);
const byKind = {}; let found = 0, total = 0, falseClouds = 0, cleanFalse = 0, cleanPairs = 0, ms = 0, regErr = [];
for (const e of idx) {
  const A = pgm(path.join(dir, e.id + '_a.pgm')), B = pgm(path.join(dir, e.id + `_${variant}.pgm`));
  const r = compare(A, B, { ...(variant === 'bs' ? { tol: 3 } : {}), ...JSON.parse(process.env.RL_OPTS || '{}') });
  ms += r.ms.register + r.ms.diff;
  const fc = r.clouds.filter((c) => !e.truth.some((t) => hit(c, t.px))).length;
  e.truth = e.truth.filter((t) => t.visible);
  falseClouds += fc;
  if (!e.truth.length) { cleanPairs++; cleanFalse += fc; }
  for (const t of e.truth) {
    const ok = r.clouds.some((c) => hit(c, t.px));
    byKind[t.kind] ??= [0, 0]; byKind[t.kind][1]++; if (ok) byKind[t.kind][0]++;
    total++; if (ok) found++;
  }
  if (variant === 'bs') { // check recovered transform against the known rescan (rough)
    regErr.push(Math.abs(Math.atan2(r.transform[3], r.transform[0]) * 180 / Math.PI + e.rescan.angle));
  }
  process.stdout.write(`${e.id} clouds=${r.clouds.length} false=${fc} truth=${e.truth.length} ${r.ms.register}+${r.ms.diff}ms\n`);
}
console.log(JSON.stringify({ variant, pairs: idx.length, recall: +(found / total).toFixed(3), found, total,
  byKind: Object.fromEntries(Object.entries(byKind).map(([k, [a, b]]) => [k, `${a}/${b}`])),
  falsePerSheet: +(falseClouds / idx.length).toFixed(2), falsePerCleanSheet: +(cleanFalse / Math.max(1, cleanPairs)).toFixed(2),
  avgMs: Math.round(ms / idx.length), medianAngleErr: regErr.length ? regErr.sort((a, b) => a - b)[regErr.length >> 1].toFixed(3) : null }, null, 1));
