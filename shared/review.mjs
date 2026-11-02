import { noteKey, slipOf, valueOkFor } from './gate.mjs';
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
// A change the gate had cleared: answered, signed, and (declared) against a note that still reads as signed, with
// its value agreeing or confirmed. Anything less was still holding the release.
function settled(c, d, notes) {
  if (!d?.signedBy) return false;
  if (d.status === 'accepted') return true;
  if (d.status !== 'declared') return false;
  if (!notes) return true;
  const note = notes.find((n) => n.n === d.note);
  if (!note) return false;
  if (d.noteText != null && d.noteText !== noteKey(note.text)) return false;
  return valueOkFor(d, note) || !slipOf(c, note.text);
}

export function carriedChanges(previous, revA, notes = null) {
  if (!previous) return [];
  const holding = (c) => !settled(c, previous.decisions?.[c.id], notes);
  return (previous.clouds || []).filter(holding).map((c, i) => {
    const d = previous.decisions?.[c.id] || {};
    return {
      ...c, id: `k-${c.id.replace(/^k-/, '')}`, n: `K${i + 1}`, x0: c.box?.[0] ?? c.x0, y0: c.box?.[1] ?? c.y0, x1: c.box?.[2] ?? c.x1, y1: c.box?.[3] ?? c.y1,
      carried: { from: c.carried?.from || previous.revA?.filename, to: previous.revB?.filename, note: d.status === 'declared' ? d.note : c.carried?.note,
        was: d.status === 'rejected' ? 'sent back' : !(d.status === 'declared' || d.status === 'accepted') ? 'not answered' : 'not cleared (a sign-off or a value check was missing)' },
    };
  });
}

// Notes carried out before: declared on a change the gate had cleared, or signed off as needing no drawing change,
// against words that still read so. A later review does not show changes made earlier, so those notes are done.
export function notesDoneBefore(previous, revA, notes = null) {
  if (!previous) return [];
  const done = new Map((previous.notesDone || []).map((x) => [x.n, x]));
  for (const c of previous.clouds || []) {
    const d = previous.decisions?.[c.id];
    if (d?.status === 'declared' && d.noteText != null && settled(c, d, notes)) done.set(d.note, { n: d.note, noteText: d.noteText });
  }
  for (const [id, d] of Object.entries(previous.decisions || {})) {
    if (/^note\d+$/.test(id) && d.signedBy && d.noteText != null) done.set(+id.slice(4), { n: +id.slice(4), noteText: d.noteText });
  }
  return [...done.values()];
}

// ---------- pen markups across saves ----------

// Every markup has its own id: two sent under one id are both kept, the second renamed and left unanswered.
export function uniqueMarks(marks, markDecisions) {
  if (!marks?.length) return { marks, markDecisions };
  const seen = new Set(), decisions = { ...(markDecisions || {}) };
  const out = marks.map((m) => {
    if (!seen.has(m.id)) { seen.add(m.id); return m; }
    let id = m.id;
    for (let k = 2; seen.has(id); k++) id = `${m.id}-${k}`;
    seen.add(id);
    decisions[id] = { status: 'open' };
    return { ...m, id };
  });
  return { marks: out, markDecisions: decisions };
}

// A save of a new pair of revisions: the markups the new read found, merged with the ones stored before.
//  - An answer follows its markup by place, and only when every earlier markup in that place was answered: a read
//    that merges two markups into one never absorbs an open question. An answer the browser carried over from an
//    earlier markup (not given in this session) is held to the same rule.
//  - Every earlier markup the new read did not find again in the same place is kept with its answer, under an id no
//    other markup has (its own, else "-was", "-was2"...): a machinist's open question never disappears with a re-read.
// stillAttached(photoId) says whether the photo a markup came from is still on the work item.
export function keepEarlierMarks(stored, marks = [], markDecisions = {}, stillAttached = () => true) {
  marks = [...(marks || [])];
  const decisions = { ...(markDecisions || {}) };
  const photoOf = (m) => +(/^p(\d+)-/.exec(m.id)?.[1] || stored.print?.id);
  const samePlace = (a, b) => photoOf(a) === photoOf(b) && a.box && b.box && overlap(a.box, b.box) >= 0.3;
  const storedAnswers = new Set((stored.marks || []).map((m) => JSON.stringify(stored.markDecisions?.[m.id] || null)));
  for (const x of marks) {
    const answers = (stored.marks || []).filter((m) => samePlace(m, x)).map((m) => stored.markDecisions?.[m.id]);
    if (!answers.length) continue;
    const allAnswered = answers.every((a) => a && a.status !== 'open'), sent = decisions[x.id];
    if (allAnswered && (!sent || sent.status === 'open')) decisions[x.id] = answers[0];
    else if (!allAnswered && sent && sent.status !== 'open' && storedAnswers.has(JSON.stringify(sent))) decisions[x.id] = { status: 'open' };
  }
  const found = marks.slice();
  const taken = new Set(marks.map((m) => m.id));
  const freeId = (id) => { if (!taken.has(id)) return id; for (let k = 1; ; k++) { const c = `${id}-was${k > 1 ? k : ''}`; if (!taken.has(c)) return c; } };
  for (const m of (stored.marks || []).filter((m) => stillAttached(photoOf(m)) && !found.some((x) => samePlace(m, x)))) {
    const id = freeId(m.id);
    taken.add(id);
    marks.push({ ...m, id });
    decisions[id] = stored.markDecisions?.[m.id] || { status: 'open' };
  }
  return { marks, markDecisions: decisions };
}
