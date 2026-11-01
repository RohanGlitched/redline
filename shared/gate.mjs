// The release gate, in one place. The light table uses it to show the verdict as people decide; the
// backend uses the same code to recompute the verdict from the saved decisions, so the workflow validator
// never trusts a verdict sent by a browser.

// Numbers written in a piece of text: "Ø25.6 ±0.15" gives [25.6, 0.15].
export const numbersIn = (s) => [...String(s || '').matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => parseFloat(m[0].replace(',', '.')));

// A declared change whose drawing text carries a value its change note does not mention: the note says
// Ø25.5 and the drawing says Ø25.6. Returns the values the note is missing (empty when they agree).
export function valueSlip(cloud, noteText) {
  if (!cloud?.values?.length || noteText == null) return [];
  const said = new Set(numbersIn(noteText));
  return cloud.values.filter((v) => !said.has(v));
}

export function gateOf(clouds, decisions = {}, marks = [], markDecisions = {}, sheets = null, notes = null) {
  let open = 0, unsigned = 0, rejected = 0, mismatched = 0;
  for (const c of clouds) {
    const d = decisions[c.id] || {};
    if (d.status === 'rejected') rejected++;
    else if (d.status !== 'declared' && d.status !== 'accepted') open++;
    else if (d.status === 'declared' && notes && !d.valueOk && valueSlip(c, notes.find((n) => n.n === d.note)?.text).length) mismatched++;
    else if (!d.signedBy) unsigned++;
  }
  // a pen markup from the floor needs an answer too: raised as a work item, covered by a change, or dismissed
  const markups = marks.filter((m) => !['raised', 'covered', 'dismissed'].includes(markDecisions[m.id]?.status)).length;
  // every sheet of a multi-sheet drawing has to be compared before release
  const unseen = sheets && sheets.count > 1 ? sheets.count - new Set(sheets.done || []).size : 0;
  const blocked = open + unsigned + rejected + mismatched + markups + unseen > 0;
  // every reason the release is held, most serious first, so the verdict never hides a second problem
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const parts = [
    unseen && `${unseen} of ${sheets.count} sheets ${unseen === 1 ? 'is' : 'are'} not compared yet`,
    rejected && `${n(rejected, 'change was', 'changes were')} sent back to the drafter`,
    open && `${n(open, 'change on the drawing is', 'changes on the drawing are')} not in the change notes`,
    mismatched && `${n(mismatched, 'declared change shows a value its change note does not', 'declared changes show values their change notes do not')}`,
    markups && `${n(markups, 'pen markup on the printed sheet needs', 'pen markups on the printed sheets need')} an answer`,
    unsigned && `${n(unsigned, 'declared change needs', 'declared changes need')} a sign-off`,
  ].filter(Boolean);
  const text = parts.length ? parts.join('; ')
    : !clouds.length && !marks.length ? 'No differences found between the revisions'
    : `All ${clouds.length} changes declared and signed off`;
  return { blocked, status: blocked ? 'blocked' : 'clear', open, unsigned, rejected, mismatched, markups, unseen, text };
}

// The release verdict for one work item, from its PDF attachments and the review in app storage. The
// workflow validator, the dashboard gadget and the Rovo actions all use this, never the issue property.
export function verdictOf(attachments, review, notes = null) {
  const pdfs = (attachments || []).filter((a) => a.mimeType === 'application/pdf')
    .sort((x, y) => x.created.localeCompare(y.created) || +x.id - +y.id);
  if (pdfs.length < 2) {
    // a work item that never had two revisions is not a drawing change; one whose reviewed PDF was
    // deleted afterwards must not slip through
    return review ? { blocked: true, text: 'a reviewed drawing revision was removed from the work item' } : { blocked: false, none: true };
  }
  if (!review) return { blocked: true, text: 'the two latest drawing revisions have not been compared yet' };
  const [a, b] = pdfs.slice(-2);
  if (+review.revB?.id !== +b.id) return { blocked: true, text: 'a newer drawing revision was attached after the last review' };
  if (review.revA?.id && +review.revA.id !== +a.id) return { blocked: true, text: 'the review compared a different pair of revisions' };
  // the newest photo on the work item must be the print the review read (or set aside as not a print)
  const photos = (attachments || []).filter((x) => /^image\/(jpeg|png|webp)$/.test(x.mimeType))
    .sort((x, y) => x.created.localeCompare(y.created) || +x.id - +y.id);
  if (photos.length && +review.print?.id !== +photos[photos.length - 1].id) {
    return { blocked: true, text: 'the newest photo of a marked-up print has not been read on the light table' };
  }
  return gateOf(review.clouds || [], review.decisions || {}, review.marks || [], review.markDecisions || {}, review.sheets, notes);
}
