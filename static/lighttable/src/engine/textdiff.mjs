// Text the pixels can miss. A one-letter or one-digit edit ("Rev A" to "Rev B", "25.5" to "25.6") moves
// fewer pixels than the line tolerance forgives, so the pixel comparison can let it through. When the PDF
// keeps its text, Redline compares the words too. Pure functions, tested in test/gate.test.mjs.

const norm = (s) => String(s).replace(/\s+/g, '').replace(/�/g, 'Ø');
const touch = (p, q, pad) => p.x0 - pad <= q.x1 && q.x0 - pad <= p.x1 && p.y0 - pad <= q.y1 && q.y0 - pad <= p.y1;

// a: revision A's words, b: revision B's words moved onto revision A's sheet, both [{ str, x0, y0, x1, y1 }]
// in the same pixels. Words from both revisions that overlap are grouped (however each PDF split its text
// into runs), and a group whose text reads differently is a change: { x0, y0, x1, y1, before, after }.
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
    const read = (side) => g.filter((t) => t.side === side).sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0).map((t) => t.str.trim()).join(' ');
    const before = read('a'), after = read('b');
    if (norm(before) === norm(after)) continue;
    out.push({ x0: Math.min(...g.map((t) => t.x0)), y0: Math.min(...g.map((t) => t.y0)), x1: Math.max(...g.map((t) => t.x1)), y1: Math.max(...g.map((t) => t.y1)), before, after });
  }
  return out;
}
