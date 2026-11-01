// The release gate, in one place. The light table uses it to show the verdict as people decide; the
// backend uses the same code to recompute the verdict from the saved decisions, so the workflow validator
// never trusts a verdict sent by a browser.

export function gateOf(clouds, decisions = {}, marks = [], markDecisions = {}, sheets = null) {
  let open = 0, unsigned = 0, rejected = 0;
  for (const c of clouds) {
    const d = decisions[c.id] || {};
    if (d.status === 'rejected') rejected++;
    else if (d.status !== 'declared' && d.status !== 'accepted') open++;
    else if (!d.signedBy) unsigned++;
  }
  // a pen markup from the floor needs an answer too: raised as a work item, covered by a change, or dismissed
  const markups = marks.filter((m) => !['raised', 'covered', 'dismissed'].includes(markDecisions[m.id]?.status)).length;
  // every sheet of a multi-sheet drawing has to be compared before release
  const unseen = sheets && sheets.count > 1 ? sheets.count - new Set(sheets.done || []).size : 0;
  const blocked = open + unsigned + rejected + markups + unseen > 0;
  let text;
  if (unseen) text = `${unseen} of ${sheets.count} sheets ${unseen === 1 ? 'is' : 'are'} not compared yet`;
  else if (!clouds.length && !marks.length) text = 'No differences found between the revisions';
  else if (rejected) text = `${rejected} ${rejected === 1 ? 'change was' : 'changes were'} sent back to the drafter`;
  else if (open) text = `${open} ${open === 1 ? 'change on the drawing is' : 'changes on the drawing are'} not in the change notes`;
  else if (markups) text = `${markups} pen ${markups === 1 ? 'markup on the printed sheet needs' : 'markups on the printed sheets need'} an answer`;
  else if (unsigned) text = `${unsigned} declared ${unsigned === 1 ? 'change needs' : 'changes need'} a sign-off`;
  else text = `All ${clouds.length} changes declared and signed off`;
  return { blocked, status: blocked ? 'blocked' : 'clear', open, unsigned, rejected, markups, unseen, text };
}

// The release verdict for one work item, from its PDF attachments and the review in app storage. The
// workflow validator, the dashboard gadget and the Rovo actions all use this, never the issue property.
export function verdictOf(attachments, review) {
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
  return gateOf(review.clouds || [], review.decisions || {}, review.marks || [], review.markDecisions || {}, review.sheets);
}
