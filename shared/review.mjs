import { noteKey } from './gate.mjs';
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
  const pick = (r) => JSON.stringify([r.revA?.id, r.revB?.id, r.engine, r.clouds, r.sheets, r.marks, r.print, (r.setAside || []).map((a) => a.id).sort(),
    Object.fromEntries(Object.entries(r.decisions || {}).map(([k, d]) => [k, [d.status, d.note ?? null, d.signedAt || null, d.valueOk?.at || null]])),
    Object.fromEntries(Object.entries(r.markDecisions || {}).map(([k, d]) => [k, [d.status, d.note ?? null]]))]);
  return pick(a) === pick(b);
}

// Who signed what, decided by the server. The caller names the decisions they signed or confirmed in this save
// (signed, confirmed); those are stamped with the caller's Jira name. Every other signature, and every "the
// drawing is right", is kept only while its decision and the words of the note it was given against are
// unchanged; otherwise it is dropped. beforeOf(id) gives the stored decision this one continues (or undefined).
// Changes `decisions` in place; returns the ids stamped in this save.
// shown: id -> the note's words the reviewer had on screen; a signature for words that have changed since is not taken
// (its note number is returned in stale).
export function settleSignatures(decisions, { beforeOf, notes = [], signed = [], confirmed = [], shown = {}, me, now, asideTotal = 0, stale = [] }) {
  const signedIds = new Set(signed.map(String)), confirmedIds = new Set(confirmed.map(String)), stamped = [];
  for (const [id, d] of Object.entries(decisions)) {
    const before = beforeOf(id);
    // the note a decision is about: the note a change is declared in, or note N for "needs no drawing change"
    const noteNo = d.status === 'declared' ? d.note : /^note(\d+)$/.test(id) ? +id.slice(4) : null;
    const noteNow = noteNo != null ? notes.find((n) => n.n === noteNo) : null;
    // (a note that does not read right now keeps the words it was signed against)
    const noteText = noteNow ? noteKey(noteNow.text) : noteNo != null ? (before?.noteText ?? null) : null;
    const same = !!before && before.status === d.status && (before.note ?? null) === (d.note ?? null)
      && (before.noteText == null || noteText == null || before.noteText === noteText);
    const seen = shown[id] == null || noteText == null || noteKey(shown[id]) === noteText;
    if (!seen && (signedIds.has(id) || confirmedIds.has(id)) && !stale.includes(noteNo)) stale.push(noteNo);
    if (!seen) { signedIds.delete(id); confirmedIds.delete(id); }
    if (signedIds.has(id) && d.signedAt) {
      d.signedById = me.accountId; d.signedBy = me.displayName; d.signedAt = now; stamped.push(id);
      if (id === '__ack') d.asideCount = asideTotal; else delete d.asideCount;
    } else if (same && before.signedById) {
      d.signedAt = before.signedAt; d.signedById = before.signedById; d.signedBy = before.signedBy;
      if (before.asideCount != null) d.asideCount = before.asideCount; else delete d.asideCount;
    } else { delete d.signedAt; delete d.signedById; delete d.signedBy; delete d.asideCount; }
    if (confirmedIds.has(id) && d.valueOk) d.valueOk = { by: me.displayName, byId: me.accountId, at: now, ...(noteText != null ? { noteText } : {}) };
    else if (same && before?.valueOk && (before.valueOk.noteText == null || before.valueOk.noteText === noteText)) d.valueOk = before.valueOk;
    else delete d.valueOk;
    if (noteText != null) d.noteText = noteText; else delete d.noteText;
  }
  return stamped;
}

// Changes carried from the previous pair of revisions. When revision E arrives after a review of C to D, every change of
// that review that was sent back or never answered comes along to the D to E review: the drafter may have fixed the
// value but not the moved hole, and D to E would not show a hole that is in both D and E. A carried change stays open
// until someone says by name that this revision fixes it, or sends it back again.
export function carriedChanges(previous, revA) {
  if (!previous || +previous.revB?.id !== +revA?.id) return [];
  const open = (c) => { const d = previous.decisions?.[c.id] || {}; return d.status === 'rejected' || !(d.status === 'declared' || d.status === 'accepted'); };
  return (previous.clouds || []).filter((c) => !c.carried || open(c)).filter(open).map((c, i) => ({
    ...c, id: `k-${c.id.replace(/^k-/, '')}`, n: `K${i + 1}`,
    carried: { from: previous.revA?.filename, to: previous.revB?.filename, was: previous.decisions?.[c.id]?.status === 'rejected' ? 'sent back' : 'not answered' },
  }));
}

// Notes carried out on the previous pair of revisions: declared there, signed, against the same words. A D to E review
// does not show changes made from C to D, so those notes are done, not missing from the drawing.
export function notesDoneBefore(previous, revA) {
  if (!previous || +previous.revB?.id !== +revA?.id) return [];
  const done = new Map((previous.notesDone || []).map((x) => [x.n, x]));
  for (const d of Object.values(previous.decisions || {})) {
    if (d.status === 'declared' && d.signedBy && d.noteText != null) done.set(d.note, { n: d.note, noteText: d.noteText });
  }
  return [...done.values()];
}
