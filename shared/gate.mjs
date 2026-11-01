// The release gate, in one place. The light table uses it to show the verdict as people decide; the
// backend uses the same code to recompute the verdict from the saved decisions, so the workflow validator
// never trusts a verdict sent by a browser.

export function gateOf(clouds, decisions = {}, marks = [], markDecisions = {}) {
  let open = 0, unsigned = 0, rejected = 0;
  for (const c of clouds) {
    const d = decisions[c.id] || {};
    if (d.status === 'rejected') rejected++;
    else if (d.status !== 'declared' && d.status !== 'accepted') open++;
    else if (!d.signedBy) unsigned++;
  }
  // a pen markup from the floor needs an answer too: raised as a work item, covered by a change, or dismissed
  const markups = marks.filter((m) => !['raised', 'covered', 'dismissed'].includes(markDecisions[m.id]?.status)).length;
  const blocked = open + unsigned + rejected + markups > 0;
  let text;
  if (!clouds.length && !marks.length) text = 'No differences found between the revisions';
  else if (rejected) text = `${rejected} ${rejected === 1 ? 'change was' : 'changes were'} sent back to the drafter`;
  else if (open) text = `${open} ${open === 1 ? 'change on the sheet is' : 'changes on the sheet are'} not in the change notes`;
  else if (markups) text = `${markups} pen ${markups === 1 ? 'markup on the printed sheet needs' : 'markups on the printed sheet need'} an answer`;
  else if (unsigned) text = `${unsigned} declared ${unsigned === 1 ? 'change needs' : 'changes need'} a sign-off`;
  else text = `All ${clouds.length} changes declared and signed off`;
  return { blocked, status: blocked ? 'blocked' : 'clear', open, unsigned, rejected, markups, text };
}
