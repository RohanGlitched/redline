import fs from 'node:fs';
import { compare } from '../../static/lighttable/src/engine/core.mjs';
function pgm(f) {
  const b = fs.readFileSync(f); let pos = 0; const tok = [];
  while (tok.length < 4) { while (/\s/.test(String.fromCharCode(b[pos]))) pos++; let s = ''; while (!/\s/.test(String.fromCharCode(b[pos]))) s += String.fromCharCode(b[pos++]); tok.push(s); }
  pos++; const w = +tok[1], h = +tok[2];
  return { w, h, data: new Uint8Array(b.buffer, b.byteOffset + pos, w * h) };
}
const r = compare(pgm('docs/cover/revC.pgm'), pgm('docs/cover/revD.pgm'), { gap: 45 });
console.log(JSON.stringify(r.clouds.map(({ x0, y0, x1, y1, kind }) => ({ x0, y0, x1, y1, kind }))));
