// The release gate, in one place. The light table uses it to show the verdict as people decide; the
// backend uses the same code to recompute the verdict from the saved decisions, so the workflow validator
// never trusts a verdict sent by a browser.

// Numbers written in a piece of text: "Ø25.6 ±0.15" gives [25.6, 0.15].
export const numbersIn = (s) => [...String(s || '').matchAll(/\d*[.,]?\d+/g)].map((m) => parseFloat(m[0].replace(',', '.')));

// A declared change whose drawing text carries a value its change note does not mention: the note says
// Ø25.5 and the drawing says Ø25.6. Returns the values the note is missing (empty when they agree).
export function valueSlip(cloud, noteText) {
  if (!cloud?.values?.length || noteText == null) return [];
  const said = new Set(numbersIn(String(noteText).replace(/\b(zones?|sheets?)\s+[A-Z]?\d{1,3}(\s*(,|and|&)\s*[A-Z]?\d{1,3})*/gi, ' ')));
  return cloud.values.filter((v) => !said.has(v));
}

// A change note as signed: spacing does not matter, anything else does.
export const noteKey = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// extra.setAside: how many differences the engine set aside as re-plot shifts. A review that found nothing, or
// set something aside, needs one person to confirm it (decisions.__ack), so no release clears with nobody looking.
// The other way round: a value the note promises that the drawing does not show. The note says Ø25.5 and
// the drawing still says Ø25 (only the tolerance was changed). Only for a note that is about this text: it has
// to mention one of the values the drawing had before. Returns the promised values the drawing is missing.
export function noteSlip(cloud, noteText) {
  if (!cloud?.before || !cloud?.after || noteText == null) return [];
  const text = String(noteText).replace(/\b(zones?|sheets?)\s+[A-Z]?\d{1,3}(\s*(,|and|&)\s*[A-Z]?\d{1,3})*/gi, ' ');
  const said = [...text.matchAll(/(?:[Ø⌀∅±]\s*|(?<![A-Za-z])[RM]\s?)(\d*[.,]?\d+)|(\d*[.,]?\d+)\s*(?:°|mm\b|"|in\b)|(\d*[.,]?\d+)\s*(?:to|→|->|becomes)\s*[Ø⌀∅R]?\s*(\d*[.,]?\d+)/g)]
    .flatMap((m) => (m[3] != null ? [m[3], m[4]] : [m[1] ?? m[2]])).map((v) => parseFloat(v.replace(',', '.')));
  const before = numbersIn(cloud.before), after = numbersIn(cloud.after);
  if (!said.some((v) => before.includes(v))) return [];
  // "Ø25 to Ø25.5": the new value must be on the drawing now (a drawing that went back from 25.5 to 25 has it only before)
  const pairs = [...text.matchAll(/(\d*[.,]?\d+)\s*(?:to|→|->|becomes)\s*[Ø⌀∅R]?\s*(\d*[.,]?\d+)/g)].map((m) => [m[1], m[2]].map((v) => parseFloat(v.replace(',', '.'))));
  const backwards = pairs.filter(([x, y]) => x !== y && !after.includes(y) && before.includes(y)).map(([, y]) => y);
  return [...new Set([...said.filter((v) => !before.includes(v) && !after.includes(v)), ...backwards])];
}

// "The drawing is right" stands for the note as it read when said; a rewritten note asks again.
export const valueOkFor = (d, note) => !!d?.valueOk && (d.valueOk.noteText == null || !note || d.valueOk.noteText === noteKey(note.text));

// Either way round: the drawing and its note disagree about a value.
export const slipOf = (cloud, noteText) => valueSlip(cloud, noteText).length + noteSlip(cloud, noteText).length > 0;

export function gateOf(clouds, decisions = {}, marks = [], markDecisions = {}, sheets = null, notes = null, extra = {}) {
  let open = 0, unsigned = 0, rejected = 0, mismatched = 0, noteChanged = 0, carriedOpen = 0;
  for (const c of clouds) {
    const d = decisions[c.id] || {};
    const note = d.status === 'declared' && notes ? notes.find((n) => n.n === d.note) : null;
    if (d.status === 'rejected') rejected++;
    else if (c.carried && d.status !== 'declared' && d.status !== 'accepted') carriedOpen++;
    else if (d.status !== 'declared' && d.status !== 'accepted') open++;
    else if (d.status === 'declared' && notes && !note) open++;
    // a signature is for the note as it read when signed: a rewritten (or renumbered) note needs signing again
    else if (note && d.signedBy && d.noteText != null && noteKey(note.text) !== d.noteText) noteChanged++;
    else if (d.status === 'declared' && notes && !valueOkFor(d, note) && slipOf(c, note?.text)) mismatched++;
    else if (!d.signedBy) unsigned++;
  }
  // a pen markup from the floor needs an answer too: raised as a work item, covered by a change, or dismissed
  // (a markup raised as a work item Jira could not confirm yet is not answered until the next save checks it)
  const markups = marks.filter((m) => !['raised', 'covered', 'dismissed'].includes(markDecisions[m.id]?.status) || markDecisions[m.id]?.unchecked).length;
  // every sheet of a multi-sheet drawing has to be compared before release
  const unseen = sheets && sheets.count > 1 ? sheets.count - new Set(sheets.done || []).size : 0;
  // every numbered note is carried out on the drawing, or a named person says it needs no drawing change
  const unmet = notes?.length && (!sheets || sheets.count <= 1 || new Set(sheets.done || []).size >= sheets.count)
    ? notes.filter((nt) => {
      if (clouds.some((c) => decisions[c.id]?.status === 'declared' && decisions[c.id]?.note === nt.n)) return false;
      if (clouds.some((c) => c.carried?.note === nt.n && decisions[c.id]?.status === 'accepted' && decisions[c.id]?.signedBy)) return false;
      if ((extra.notesDone || []).some((x) => x.n === nt.n && x.noteText === noteKey(nt.text))) return false;
      const x = decisions[`note${nt.n}`];
      return !(x?.signedBy && (x.noteText == null || x.noteText === noteKey(nt.text)));
    }).length : 0;
  const needsAck = !clouds.length || (extra.setAside || 0) > 0;
  const ack = decisions.__ack;
  const unconfirmed = needsAck && (!ack?.signedBy || (ack.asideCount != null && (extra.setAside || 0) > ack.asideCount)) ? 1 : 0;
  const blocked = open + carriedOpen + unsigned + rejected + mismatched + markups + unseen + noteChanged + unconfirmed + unmet > 0;
  // every reason the release is held, most serious first, so the verdict never hides a second problem
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const parts = [
    unseen && `${unseen} of ${sheets.count} sheets ${unseen === 1 ? 'is' : 'are'} not compared yet`,
    rejected && `${n(rejected, 'change was', 'changes were')} sent back to the drafter`,
    carriedOpen && `${n(carriedOpen, 'change left open on the previous revisions is', 'changes left open on the previous revisions are')} not confirmed fixed`,
    open && `${n(open, 'change on the drawing is', 'changes on the drawing are')} not in the change notes`,
    mismatched && `${n(mismatched, 'declared change shows a value its change note does not', 'declared changes show values their change notes do not')}`,
    markups && `${n(markups, 'pen markup on the print needs', 'pen markups on the print need')} an answer`,
    noteChanged && `${n(noteChanged, 'change note was', 'change notes were')} edited after the sign-off`,
    unsigned && `${n(unsigned, 'declared change needs', 'declared changes need')} a sign-off`,
    unconfirmed && (!clouds.length ? 'nobody has confirmed that the revisions show no differences' : 'nobody has confirmed what Redline set aside as re-plot shifts'),
    unmet && `${n(unmet, 'change note has', 'change notes have')} no change on the drawing`,
  ].filter(Boolean);
  const text = parts.length ? parts.join('; ')
    : !clouds.length ? `No differences found between the revisions, confirmed by ${decisions.__ack?.signedBy || 'a reviewer'}`
    : clouds.length === 1 ? 'The change is declared and signed off' : `All ${clouds.length} changes declared and signed off`;
  // the same reasons, short, for places with little room (the light table's header)
  const reasons = [
    unseen && { kind: 'unseen', n: unseen, short: `${unseen} ${unseen === 1 ? 'sheet' : 'sheets'} not compared` },
    rejected && { kind: 'rejected', n: rejected, short: `${rejected} sent back` },
    carriedOpen && { kind: 'carried', n: carriedOpen, short: `${carriedOpen} left open before` },
    open && { kind: 'open', n: open, short: `${open} not in the notes` },
    mismatched && { kind: 'mismatched', n: mismatched, short: `${mismatched} ${mismatched === 1 ? 'value differs' : 'values differ'} from the note` },
    markups && { kind: 'markups', n: markups, short: `${markups} pen ${markups === 1 ? 'markup' : 'markups'} to answer` },
    noteChanged && { kind: 'noteChanged', n: noteChanged, short: `${noteChanged} ${noteChanged === 1 ? 'note' : 'notes'} edited since signed` },
    unsigned && { kind: 'unsigned', n: unsigned, short: `${unsigned} to sign off` },
    unconfirmed && { kind: 'ack', n: 1, short: !clouds.length ? 'confirm no differences' : 'confirm what was set aside' },
    unmet && { kind: 'unmet', n: unmet, short: `${unmet} ${unmet === 1 ? 'note' : 'notes'} not on the drawing` },
  ].filter(Boolean);
  return { blocked, status: blocked ? 'blocked' : 'clear', open, unsigned, rejected, mismatched, markups, unseen, noteChanged, unconfirmed, unmet, carriedOpen, text, parts, reasons };
}

// The release verdict for one work item, from its PDF attachments and the review in app storage. The
// workflow validator, the dashboard gadget and the Rovo actions all use this, never the issue property.
// "BRKT-0142_rev-D.pdf" -> "brkt-0142": the drawing a revision belongs to (null when the name has no revision)
// One reading of revision names for every part of Redline (the gate, the light table, the title-block check):
// "rev" (any case, "revision" too) then a capital letter or two or a number, or a separator then any letter or two
// ("rev-d"); an optional digit after the letter ("RevD1"); then optional words after a separator ("(released)",
// "-signed"). Never part of a word: "review", "revs", "preview" and "drawing_rev.pdf" are not revisions.
// A sub-revision follows the letter directly or after "-" or "." ("RevD1", "Rev D-1", "rev-d.2").
const REV = /(^|[^A-Za-z])[Rr][Ee][Vv](?:ision|ISION)?(?:[-_ .]+([A-Za-z]{1,2}|\d{1,4})|([A-Z]{1,2}|\d{1,4}))(?:[-.]?(\d{1,2}))?((?:[-_ ]+\(?[A-Za-z0-9]+\)?)*)$/;
export function parseRevision(filename) {
  const base = String(filename || '').replace(/\.[a-z0-9]{2,4}$/i, '');
  const m = REV.exec(base);
  if (!m) return null;
  const t = m[2] ?? m[3];
  const drawing = base.slice(0, m.index + m[1].length).toLowerCase().replace(/[-_ .]+$/, '');
  return { rev: /^\d+$/.test(t) ? String(+t) : t.toUpperCase(), sub: m[4] ? +m[4] : 0, extra: !!m[5], drawing: drawing || null };
}

// "BRKT-0142_rev-D.pdf" -> "rev D" (the file name itself when it names no revision)
export const revLabel = (filename) => { const p = parseRevision(filename); return p ? `rev ${p.rev}` : String(filename || ''); };

export function drawingOf(filename) {
  return parseRevision(filename)?.drawing || null;
}

// The drawing revisions Redline compares on a work item, oldest first. When PDFs are named as revisions of one
// drawing ("BRKT-0142_rev-C.pdf", "BRKT0142 Rev D.pdf"), those are the revisions and anything else (an ECO form, a
// test report) is left alone; with no such names, every PDF counts. Two drawings that each have revisions attached
// are a conflict: Redline compares one drawing per change order.
// The revision a file name gives, as something to sort by: letters A..Z, AA.. in order, numbers by value, numbers before
// letters; null when the name has none.
export function revisionRank(filename) {
  const p = parseRevision(filename);
  if (!p) return null;
  if (/^\d+$/.test(p.rev)) return +p.rev * 100 + p.sub;
  return 10000000 + [...p.rev].reduce((v, ch) => v * 27 + (ch.charCodeAt(0) - 64), 0) * 100 + p.sub;
}

export function drawingPdfs(attachments) {
  const byTime = (x, y) => Date.parse(x.created) - Date.parse(y.created) || +x.id - +y.id;
  const pdfs = (attachments || []).filter((a) => a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename || '')).sort(byTime);
  const groups = new Map();
  for (const a of pdfs) {
    const k = drawingOf(a.filename)?.replace(/[^a-z0-9]/g, '');
    if (k) groups.set(k, [...(groups.get(k) || []), a]);
  }
  // a drawing's revisions go in revision order: rev D attached before rev C is still compared C to D
  const withRevs = [...groups.values()].filter((g) => g.length >= 2)
    // among copies of one revision the plain name is the revision itself ("rev-E.pdf", not "rev-E marked up.pdf")
    .map((g) => [...g].sort((x, y) => (revisionRank(x.filename) ?? 0) - (revisionRank(y.filename) ?? 0)
      || (parseRevision(y.filename)?.extra ? 1 : 0) - (parseRevision(x.filename)?.extra ? 1 : 0) || byTime(x, y)));
  if (withRevs.length > 1) return { pdfs: [], conflict: withRevs.length };
  return withRevs[0] ? { pdfs: withRevs[0], named: true } : { pdfs, named: false };
}

// The two revisions to compare: from the last reviewed revision to the newest (two revisions attached at once are
// never skipped: D to F, not E to F), or the reviewed pair itself while nothing newer has arrived.
export function pairOf(pdfs, review) {
  // a later copy of the reviewed revision (same revision, another file) is not a new revision
  const reviewedB = review && pdfs.find((p) => +p.id === +review.revB?.id);
  if (reviewedB && revisionRank(reviewedB.filename) != null) pdfs = pdfs.filter((p) => +p.id === +reviewedB.id || +p.id === +review.revA?.id || revisionRank(p.filename) !== revisionRank(reviewedB.filename));
  const last = pdfs[pdfs.length - 1];
  if (!last) return [];
  const from = review && pdfs.find((p) => +p.id === +review.revB?.id);
  if (from && +from.id !== +last.id) return [from, last];
  if (review && +review.revB?.id === +last.id) { const a = pdfs.find((p) => +p.id === +review.revA?.id); if (a) return [a, last]; }
  // the first comparison (or one after the reviewed revision was removed): the oldest against the newest
  return pdfs.length >= 2 ? [pdfs[0], last] : pdfs.slice(-2);
}

// PDFs attached after a review was saved that the comparison does not cover, each with the reason it holds:
//  - not named as a revision of this drawing (an unknown file);
//  - another copy of the reviewed revision ("rev-D marked up.pdf");
//  - named as a revision older than the one reviewed ("rev C2" after a C to D review).
// A named revision between the pair compared is covered by it (D to F includes E). One set aside by name holds no more.
export function unplacedPdfs(attachments, review) {
  if (!review) return [];
  const all = (attachments || []).filter((a) => a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename || ''));
  const { pdfs } = drawingPdfs(attachments);
  const [pa, pb] = pairOf(pdfs, review);
  const reviewedB = all.find((a) => +a.id === +review.revB?.id);
  const seen = review.pdfsSeen ? new Set(review.pdfsSeen.map(Number)) : null;
  const later = (a) => (seen ? !seen.has(+a.id) : reviewedB && (Date.parse(a.created) > Date.parse(review.savedAt || reviewedB.created) || +a.id > +reviewedB.id));
  const rank = (a) => revisionRank(a?.filename);
  return all.filter((a) => +a.id !== +pa?.id && +a.id !== +pb?.id && later(a) && !review.decisions?.[`pdf${a.id}`]?.signedBy).map((a) => {
    const inChain = pdfs.some((p) => +p.id === +a.id);
    if (!inChain) return { ...a, why: 'is not named as a revision of this drawing and is not compared' };
    if (reviewedB && rank(a) != null && rank(a) === rank(reviewedB)) return { ...a, why: `is another copy of the reviewed ${revLabel(reviewedB.filename)}` };
    if (pb && rank(a) != null && rank(a) === rank(pb)) return { ...a, why: `is another copy of ${revLabel(pb.filename)}, which is compared` };
    // covered: newer than the reviewed revision and older than the newest, so the comparison runs across it
    if (reviewedB && pb && rank(a) > rank(reviewedB) && rank(a) < rank(pb)) return null;
    return { ...a, why: reviewedB ? `is named as a revision older than the one reviewed (${revLabel(reviewedB.filename)})` : 'is named as an older revision' };
  }).filter(Boolean);
}

export function verdictOf(attachments, review, notes = null) {
  const { pdfs, conflict } = drawingPdfs(attachments);
  if (conflict) return { blocked: true, text: `${conflict} different drawings are attached with revisions; Redline compares one drawing per change order, so raise one change order per drawing` };
  if (pdfs.length < 2) {
    // a work item that never had two revisions is not a drawing change; one whose reviewed PDF was
    // deleted afterwards must not slip through
    return review ? { blocked: true, text: 'a reviewed drawing revision was removed from the work item' } : { blocked: false, none: true };
  }
  if (!review) return { blocked: true, text: 'the drawing revisions have not been compared yet' };
  const reviewedB = (attachments || []).find((a) => +a.id === +review.revB?.id);
  const unplaced = unplacedPdfs(attachments, review);
  if (unplaced.length) return { blocked: true, text: unplaced.map((a) => `${a.filename} ${a.why}`).join('; ') + '; set it aside on the light table if it is not a revision to compare' };
  const [a, b] = pairOf(pdfs, review);
  if (!a || !b) return { blocked: true, text: 'Redline cannot tell which two revisions to compare; name each revision once' };
  if (+review.revB?.id !== +b.id) return { blocked: true, text: pdfs.some((p) => +p.id === +review.revB?.id) ? 'a newer drawing revision was attached after the last review' : 'the reviewed drawing revision was removed or replaced; compare the revisions again' };
  if (review.revA?.id && +review.revA.id !== +a.id) return { blocked: true, text: 'the review compared a different pair of revisions' };
  // the newest photo on the work item must be the print the review read (or set aside as not a print)
  const photos = (attachments || []).filter((x) => /^image\/(jpeg|png|webp|heic|heif)$/.test(x.mimeType))
    .sort((x, y) => Date.parse(x.created) - Date.parse(y.created) || +x.id - +y.id);
  if (photos.length && +review.print?.id !== +photos[photos.length - 1].id) {
    return { blocked: true, text: 'the newest photo of a marked-up print has not been read on the light table' };
  }
  const attached = new Set((attachments || []).map((x) => String(x.id)));
  const marks = (review.marks || []).filter((m) => attached.has(/^p(\d+)-/.exec(m.id)?.[1] || String(review.print?.id)));
  return gateOf(review.clouds || [], review.decisions || {}, marks, review.markDecisions || {}, review.sheets, notes, { setAside: (review.setAside || []).length, notesDone: review.notesDone });
}
