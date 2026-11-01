// Text the pixels can miss. A one-letter or one-digit edit ("Rev A" to "Rev B", "25.5" to "25.6") moves
// fewer pixels than the line tolerance forgives, so the pixel comparison can let it through. When the PDF
// keeps its text, Redline compares the words too. Pure functions, tested in test/gate.test.mjs.

const norm = (s) => String(s).normalize('NFKC').replace(/\s+/g, '').replace(/[\uFFFD\u2205\u2300]/g, 'Ø').replace(/\u00D7/g, 'x');
const touch = (p, q, pad) => p.x0 - pad <= q.x1 && q.x0 - pad <= p.x1 && p.y0 - pad <= q.y1 && q.y0 - pad <= p.y1;

// a: revision A's words, b: revision B's words moved onto revision A's sheet, both [{ str, x0, y0, x1, y1 }]
// in the same pixels. Words from both revisions that overlap are grouped (however each PDF split its text
// into runs), and a group whose text reads differently is a change: { x0, y0, x1, y1, before, after }.
// Both revisions keep readable text: most of revision A's words appear in revision B too. A scanned revision,
// or one exported with its text turned into outlines, has none, and comparing words would call them all removed.
export function bothReadable(a = [], b = []) {
  if (a.length < 3 || b.length < 3) return false;
  const words = new Set(b.map((t) => norm(t.str)));
  return a.filter((t) => words.has(norm(t.str))).length / a.length >= 0.5;
}

export function textChanges(a = [], b = [], pad = 1) {
  const items = [...a.map((t) => ({ ...t, side: 'a' })), ...b.map((t) => ({ ...t, side: 'b' }))].filter((t) => norm(t.str))
    .sort((p, q) => p.x0 - q.x0);
  const group = items.map((_, i) => i);
  const find = (i) => (group[i] === i ? i : (group[i] = find(group[i])));
  // a sweep from left to right: only words that start before this one ends can touch it
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length && items[j].x0 - pad <= items[i].x1; j++) if (touch(items[i], items[j], pad)) group[find(i)] = find(j);
  const groups = new Map();
  for (let i = 0; i < items.length; i++) { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(items[i]); }
  const out = [];
  for (const g of groups.values()) {
    // read line by line: words whose middles sit within half a line of each other are on one line
    const cy = (t) => (t.y0 + t.y1) / 2, lh = (t) => t.y1 - t.y0;
    // (lines are formed first, top to bottom, then each is read left to right: a stable order)
    const read = (side) => {
      const lines = [];
      for (const t of g.filter((w) => w.side === side).sort((p, q) => cy(p) - cy(q))) {
        const line = lines[lines.length - 1];
        if (line && Math.abs(cy(t) - line.cy) < Math.min(lh(t), line.h) * 0.5) line.words.push(t);
        else lines.push({ cy: cy(t), h: lh(t), words: [t] });
      }
      return lines.map((l) => l.words.sort((p, q) => p.x0 - q.x0).map((t) => t.str.trim()).join(' ')).join(' ');
    };
    const before = read('a'), after = read('b');
    if (norm(before) === norm(after)) continue;
    out.push({ x0: Math.min(...g.map((t) => t.x0)), y0: Math.min(...g.map((t) => t.y0)), x1: Math.max(...g.map((t) => t.x1)), y1: Math.max(...g.map((t) => t.y1)), before, after });
  }
  return out;
}
