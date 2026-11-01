import { parseRevision } from '../../../../shared/gate.mjs';
// The title block's revision letter. A drafter who changes a drawing but forgets to change "Rev C" to
// "Rev D" in the title block releases a sheet that names the wrong revision: the shop floor cannot tell
// which print is current. Pure functions, tested in test/gate.test.mjs.

// The revision a file name says it is: "BRKT-0142_rev-D.pdf" -> "D".
export function revisionOfName(filename = '') {
  // the same reading as the release gate (shared/gate.mjs parseRevision)
  return parseRevision(filename)?.rev ?? null;
}

// "03" and "3" are the same revision
export const normalRev = (r) => (/^\d+$/.test(r) ? String(+r) : String(r).toUpperCase());

// The letter after "Rev", "REV:", "Revision" in the bottom-right part of the sheet, where title blocks
// sit. texts: [{ str, x0, y0, x1, y1 }] in page pixels; w, h: page size in the same pixels.
export function titleBlockRevision(texts = [], w, h) {
  const words = texts.filter((t) => t.x0 > w * 0.5 && t.y0 > h * 0.6 && String(t.str).trim());
  // the lowest, rightmost label wins: a revision table above the title block lists older letters too
  const labels = words.filter((t) => /^rev(?:ision)?\b/i.test(String(t.str).trim()))
    .sort((p, q) => q.y1 - p.y1 || q.x1 - p.x1);
  for (const t of labels) {
    const own = String(t.str).trim().match(/^rev(?:ision)?\s*[:.]?\s*([A-Z0-9]{1,2})$/i);
    if (own) return { letter: normalRev(own[1]), box: t };
    if (!/^rev(?:ision)?\s*[:.]?$/i.test(String(t.str).trim())) continue;
    const lh = t.y1 - t.y0, cy = (t.y0 + t.y1) / 2;
    const next = words.filter((u) => u !== t && Math.abs((u.y0 + u.y1) / 2 - cy) < lh * 0.6 && u.x0 >= t.x1 - 2 && u.x0 - t.x1 < lh * 3)
      .sort((p, q) => p.x0 - q.x0)[0];
    // the letter beside the label, or in the box below it (the usual title-block cell)
    const below = words.filter((u) => u !== t && u.y0 >= t.y1 - 2 && u.y0 - t.y1 < lh * 2.5 && u.x1 >= t.x0 - lh && u.x0 <= t.x1 + lh)
      .sort((p, q) => p.y0 - q.y0)[0];
    for (const cand of [next, below]) {
      const letter = cand && String(cand.str).trim().match(/^([A-Z]{1,2}|\d{1,3})$/);
      if (letter) return { letter: normalRev(letter[1]), box: { x0: Math.min(t.x0, cand.x0), y0: Math.min(t.y0, cand.y0), x1: Math.max(t.x1, cand.x1), y1: Math.max(t.y1, cand.y1) } };
    }
  }
  return null;
}
