// Which changes are housekeeping: real differences that are not engineering changes, grouped so a
// reviewer can look them over and sign them together. Pure functions, tested in test/gate.test.mjs.

// Plot stamps: a re-exported PDF carries a new date, time, file path or tool version. These are real
// differences but not engineering changes, so they are grouped as housekeeping for one-click review.
// Strict on purpose: both texts must consist of nothing but stamp tokens and title-block words, so a
// scale (1:20), a thread (1/4-20), a limit dimension (12.70-12.75) or a word added next to a date is
// never a stamp.
const STAMP_TOKEN = new RegExp([
  String.raw`\b\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b`,
  String.raw`\b\d{1,2}([/.-])\d{1,2}\1\d{4}\b`,
  String.raw`\b\d{1,2}:\d{2}(?::\d{2}|\s*[AP]M)\b`,
  String.raw`\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b`,
  String.raw`(?:[A-Za-z]:)?[\/][^\s]*[\/][^\s]*`,
  String.raw`[^\s]*\.(?:sch|kicad_sch|kicad_pcb|brd|dwg|dxf|sldprt|slddrw|pdf)\b`,
  String.raw`\b(?:kicad|eeschema|pcbnew|eagle|altium|solidworks|autocad)(?:\s*e\.d\.a\.)?\s*\(?v?\d+(?:\.\d+){1,3}(?:-\S+)?\)?`,
].join('|'), 'gi');
const STAMP_WORDS = /\b(?:date|time|file|filename|path|plotted|printed|on|at|kicad|e\.d\.a\.|eeschema|version|ver)\b/gi;
export function isStamp(before, after) {
  if (!before || !after || before === after) return false;
  const has = (t) => (t.match(STAMP_TOKEN) || []).length > 0;
  const rest = (t) => t.replace(STAMP_TOKEN, ' ').replace(STAMP_WORDS, ' ').replace(/[\s:,;()[\]|#]+/g, '');
  return has(before) && has(after) && !rest(before) && !rest(after);
}

// Housekeeping needs the changed ink to be text (90% of it): a label that moved without changing, or a
// plot stamp. Anything else that moved stays in the main list with its distance.
export function withHousekeeping(c) {
  if ((c.textShare ?? 0) < 0.9) return c;
  const stamp = isStamp(c.before, c.after);
  const textMove = !!c.move && c.sameText;
  return textMove || stamp ? { ...c, housekeeping: stamp ? 'stamp' : 'textMove' } : c;
}

