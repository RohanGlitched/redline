// The title block's revision letter. A drafter who changes a drawing but forgets to change "Rev C" to
// "Rev D" in the title block releases a sheet that names the wrong revision: the shop floor cannot tell
// which print is current. Pure functions, tested in test/gate.test.mjs.

// The revision a file name says it is: "BRKT-0142_rev-D.pdf" -> "D".
export function revisionOfName(filename = '') {
  const m = String(filename).match(/(?:^|[^a-z])rev(?:ision)?[-_ .]?([A-Z0-9]{1,3})(?![a-z])/i);
  return m ? m[1].toUpperCase() : null;
}

// The letter after "Rev", "REV:", "Revision" in the bottom-right part of the sheet, where title blocks
// sit. texts: [{ str, x0, y0, x1, y1 }] in page pixels; w, h: page size in the same pixels.
export function titleBlockRevision(texts = [], w, h) {
  const words = texts.filter((t) => t.x0 > w * 0.5 && t.y0 > h * 0.6 && String(t.str).trim());
  // the lowest, rightmost label wins: a revision table above the title block lists older letters too
  const labels = words.filter((t) => /^rev(?:ision)?\b/i.test(String(t.str).trim()))
    .sort((p, q) => q.y1 - p.y1 || q.x1 - p.x1);
  for (const t of labels) {
    const own = String(t.str).trim().match(/^rev(?:ision)?\s*[:.]?\s*([A-Z0-9]{1,2})$/i);
    if (own) return { letter: own[1].toUpperCase(), box: t };
    if (!/^rev(?:ision)?\s*[:.]?$/i.test(String(t.str).trim())) continue;
    const lh = t.y1 - t.y0, cy = (t.y0 + t.y1) / 2;
    const next = words.filter((u) => u !== t && Math.abs((u.y0 + u.y1) / 2 - cy) < lh * 0.6 && u.x0 >= t.x1 - 2 && u.x0 - t.x1 < lh * 3)
      .sort((p, q) => p.x0 - q.x0)[0];
    const letter = next && String(next.str).trim().match(/^([A-Z0-9]{1,2})$/i);
    if (letter) return { letter: letter[1].toUpperCase(), box: { x0: t.x0, y0: Math.min(t.y0, next.y0), x1: next.x1, y1: Math.max(t.y1, next.y1) } };
  }
  return null;
}
