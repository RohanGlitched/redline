// Rules for saving a review that the browser and the backend share. Pure functions, tested in
// test/gate.test.mjs.

// The comparison engine's version. The backend accepts a review that re-reads the drawings from scratch
// only from exactly this version, so a browser cannot claim a made-up newer engine to drop changes.
export const ENGINE_VERSION = 'redline-core 0.6';

// How much of the smaller of two boxes ([x0, y0, x1, y1]) the other covers, 0 to 1.
export function overlap(p, q) {
  const w = Math.min(p[2], q[2]) - Math.max(p[0], q[0]), h = Math.min(p[3], q[3]) - Math.max(p[1], q[1]);
  if (w <= 0 || h <= 0) return 0;
  const area = (b) => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
  return (w * h) / Math.min(area(p), area(q));
}

// After a re-read, which earlier change does each new change stand in for? Matched on the same sheet by
// overlap (at least half of the smaller box), each earlier change used at most once, best match first.
// Returns { newId: oldId }.
export function matchChanges(oldClouds = [], newClouds = []) {
  const pairs = [];
  for (const n of newClouds) for (const o of oldClouds) {
    if ((n.sheet || 1) !== (o.sheet || 1)) continue;
    const f = overlap(n.box, o.box);
    if (f >= 0.5) pairs.push({ n: n.id, o: o.id, f });
  }
  pairs.sort((a, b) => b.f - a.f);
  const out = {}, used = new Set();
  for (const p of pairs) if (!(p.n in out) && !used.has(p.o)) { out[p.n] = p.o; used.add(p.o); }
  return out;
}

// A save that changes nothing a person decided or the engine found is not written again.
export function sameReview(a, b) {
  if (!a || !b) return false;
  const pick = (r) => JSON.stringify([r.revA?.id, r.revB?.id, r.engine, r.clouds, r.sheets, r.marks, r.print,
    Object.fromEntries(Object.entries(r.decisions || {}).map(([k, d]) => [k, [d.status, d.note ?? null, d.signedAt || null, d.valueOk?.at || null]])),
    Object.fromEntries(Object.entries(r.markDecisions || {}).map(([k, d]) => [k, [d.status, d.note ?? null]]))]);
  return pick(a) === pick(b);
}
