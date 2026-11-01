// What a changed callout means, in an engineer's words: "Tolerance tightened ±0.15 to ±0.05" is a cost and
// inspection question; "Diameter 25 to 25.5" is a fit question. Read from the drawing's text before and after.
// Pure functions, tested in test/gate.test.mjs.

const num = (s) => Number(String(s).replace(',', '.'));
const fmt = (n) => String(Math.round(n * 1000) / 1000);

// each kind of callout: a pattern whose first group is the value, and how to name it
const KINDS = [
  { kind: 'tolerance', re: /±\s*(\d+(?:[.,]\d+)?)/g, name: 'Tolerance', compare: true },
  { kind: 'diameter', re: /[Ø⌀]\s*(\d+(?:[.,]\d+)?)/g, name: 'Diameter' },
  { kind: 'radius', re: /(?:^|[^A-Z])R\s?(\d+(?:[.,]\d+)?)/g, name: 'Radius' },
  { kind: 'angle', re: /(\d+(?:[.,]\d+)?)\s*°/g, name: 'Angle' },
  { kind: 'thread', re: /(?<![A-Za-z0-9])(M\d+(?:[.,]\d+)?(?:\s*[x×]\s*\d+(?:[.,]\d+)?)?|\d+\/\d+-\d+\s*UN[CFE]?|#\d+-\d+\s*UN[CFE]?)/gi, name: 'Thread', text: true },
];

const all = (re, s) => [...String(s || '').matchAll(new RegExp(re.source, re.flags))].map((m) => m[1]);

// before, after: the drawing's text in a change. Returns [{ kind, text }] such as
// { kind: 'tolerance', text: 'Tolerance tightened: ±0.15 to ±0.05' }.
export function meaningOf(before, after) {
  if (!before || !after || before === after) return [];
  const out = [];
  for (const k of KINDS) {
    const a = all(k.re, before), b = all(k.re, after);
    if (a.length !== 1 || b.length !== 1) continue; // only when each side has exactly one such value
    if (k.text) {
      if (a[0].replace(/\s/g, '').toUpperCase() !== b[0].replace(/\s/g, '').toUpperCase()) out.push({ kind: k.kind, text: `${k.name} changed: ${a[0]} to ${b[0]}` });
      continue;
    }
    const x = num(a[0]), y = num(b[0]);
    if (!(x !== y) || Number.isNaN(x) || Number.isNaN(y)) continue;
    if (k.compare) {
      out.push({ kind: k.kind, text: `${k.name} ${y < x ? 'tightened' : 'loosened'}: ±${fmt(x)} to ±${fmt(y)}`, tighter: y < x });
    } else {
      const d = y - x;
      out.push({ kind: k.kind, text: `${k.name} ${fmt(x)} to ${fmt(y)} (${d > 0 ? '+' : ''}${fmt(d)})` });
    }
  }
  return out;
}
