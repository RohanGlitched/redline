import fs from 'node:fs';
import { compare } from '../../static/lighttable/src/engine/core.mjs';
function pgm(f) {
  const b = fs.readFileSync(f); let pos = 0; const tok = [];
  while (tok.length < 4) { while (/\s/.test(String.fromCharCode(b[pos]))) pos++; let s = ''; while (!/\s/.test(String.fromCharCode(b[pos]))) s += String.fromCharCode(b[pos++]); tok.push(s); }
  pos++; const w = +tok[1], h = +tok[2];
  return { w, h, data: new Uint8Array(b.buffer, b.byteOffset + pos, w * h) };
}
const jobs = JSON.parse(fs.readFileSync('jobs.json', 'utf8'));
const out = [];
for (const j of jobs) {
  const res = { name: j.name, repo: j.repo, path: j.path, from: j.from, to: j.to, pages: [] };
  for (const p of j.pages) {
    if (!p.A || !p.B) { res.pages.push({ page: p.page, sheet: p.A ? 'removed' : 'added' }); continue; }
    const A = pgm(p.A), B = pgm(p.B);
    const t0 = Date.now();
    const r = compare(A, B, { gap: 45 });
    const T = r.transform;
    const words = (ws, x0, y0, x1, y1) => ws.filter((w) => w[2] >= x0 && w[0] <= x1 && w[3] >= y0 && w[1] <= y1).map((w) => w[4]).join(' ');
    const clouds = r.clouds.map((c) => {
      const pad = 10;
      const cs = [[c.x0, c.y0], [c.x1, c.y0], [c.x0, c.y1], [c.x1, c.y1]].map(([x, y]) => [T[0] * x + T[1] * y + T[2], T[3] * x + T[4] * y + T[5]]);
      const bx = cs.map((q) => q[0]), by = cs.map((q) => q[1]);
      return { box: [c.x0, c.y0, c.x1, c.y1].map(Math.round), kind: c.kind, moved: c.moved || null, area: (c.x1 - c.x0) * (c.y1 - c.y0),
        before: words(p.Awords, c.x0 - pad, c.y0 - pad, c.x1 + pad, c.y1 + pad), after: words(p.Bwords, Math.min(...bx) - pad, Math.min(...by) - pad, Math.max(...bx) + pad, Math.max(...by) + pad) };
    });
    // what the shift check set aside, kept so anyone can look at each one (sheets.py crops them too)
    const setAside = (r.rejected || []).filter((c) => c.shiftNcc !== undefined).map((c) => ({ box: [c.x0, c.y0, c.x1, c.y1].map(Math.round), match: Math.round(Math.min(c.shiftNcc, c.shiftNccWorst ?? 1) * 1000) / 1000 }));
    res.pages.push({ page: p.page, w: A.w, h: A.h, ms: Date.now() - t0, clouds, setAside });
  }
  out.push(res);
  console.log(j.name, res.pages.map((p) => p.clouds ? p.clouds.length : p.sheet).join(','));
}
fs.writeFileSync('results.json', JSON.stringify(out, null, 1));
