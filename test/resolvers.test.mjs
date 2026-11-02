// The resolvers against stand-ins for Jira and app storage. Run with: npm test
// (node --import ./test/forge/register.mjs swaps @forge/api, @forge/kvs and @forge/resolver for test/forge/stub-*.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { notesFromAdf } from '../shared/notes.mjs';
import { noteKey } from '../shared/gate.mjs';
import { kvs } from './forge/stub-kvs.mjs';
await import('../src/index.js');
const defs = globalThis.RESOLVERS;

// one work item, ENG-1 (id 100), whose description holds the change notes
const S = { me: { accountId: 'alice', displayName: 'Alice' }, description: null, putFail: false };
const desc = (...ts) => ({ type: 'doc', version: 1, content: [{ type: 'orderedList', attrs: { order: 1 }, content: ts.map((t) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })) }] });
globalThis.JIRA = async (path, init) => {
  if (path.includes('mypermissions')) return { permissions: { EDIT_ISSUES: { havePermission: true } } };
  if (path.includes('/myself')) return S.me;
  if (init?.method === 'PUT') {
    if (S.putFail) return { __status: 500, body: { errorMessages: ['boom'] } };
    S.description = structuredClone(JSON.parse(init.body).fields.description);
    return {};
  }
  return { id: '100', key: 'ENG-1', fields: { summary: 's', description: structuredClone(S.description), attachment: [] } };
};
const said = () => notesFromAdf(S.description).map((x) => `${x.n}:${noteKey(x.text)}`).join('|');
const add = (text, expect = said()) => defs.addNote({ context: { extension: { issue: { key: 'ENG-1' } }, accountId: S.me.accountId }, payload: { text, expect } });
const notes = () => notesFromAdf(S.description).map((n) => n.text);
const fresh = (...ts) => { globalThis.KV.clear(); S.description = desc(...ts); S.putFail = false; };

test('addNote appends the next numbered note and records who wrote it', async () => {
  fresh('Zone D2: bore Ø25 to Ø25.5', 'Zone B1: chamfer added');
  const out = await add('Zone C3: datum A moved 2 mm');
  assert.equal(out.n, 3);
  assert.deepEqual(notes(), ['Zone D2: bore Ø25 to Ø25.5', 'Zone B1: chamfer added', 'Zone C3: datum A moved 2 mm']);
  assert.equal(globalThis.KV.get('written:100')[0].by, 'Alice');
  assert.equal(globalThis.KV.get('audit:100').at(-1).noteAdded.n, 3);
});

test('addNote refuses a description edited since the light table read it', async () => {
  fresh('n1', 'n2');
  const old = said();
  S.description = desc('n1 edited by Bob', 'n2');
  assert.equal((await add('n3', old)).stale, true);
  assert.deepEqual(notes(), ['n1 edited by Bob', 'n2']);
});

test('two adds at once: one writes the note, the other is told the notes changed', async () => {
  fresh('n1', 'n2');
  const e = said();
  const [a, b] = await Promise.all([add('first', e), add('second', e)]);
  assert.equal([a, b].filter((x) => x.stale).length, 1);
  assert.deepEqual(notes(), ['n1', 'n2', 'first']);
});

test('an edit made between the read and the write is never written over', async () => {
  fresh('n1', 'n2');
  const set = kvs.set;
  kvs.set = async (k, v, o) => { if (String(k).startsWith('note:')) S.description = desc('n1 edited by Bob', 'n2'); return set(k, v, o); };
  try { assert.equal((await add('n3')).stale, true); } finally { kvs.set = set; }
  assert.deepEqual(notes(), ['n1 edited by Bob', 'n2']);
});

test('a failed write frees the note number, so trying again works', async () => {
  fresh('n1');
  S.putFail = true;
  await assert.rejects(add('n2'), /500/);
  S.putFail = false;
  assert.equal((await add('n2')).n, 2);
  assert.deepEqual(notes(), ['n1', 'n2']);
});

test('note text that looks like a list stays one note', async () => {
  fresh('n1');
  await add('2. moved; 3) also this');
  assert.deepEqual(notes(), ['n1', '2. moved; 3) also this']);
});
