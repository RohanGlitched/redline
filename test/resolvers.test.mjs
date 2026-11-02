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
const S = { me: { accountId: 'alice', displayName: 'Alice' }, description: null, putFail: false, attachments: [], down: false };
const desc = (...ts) => ({ type: 'doc', version: 1, content: [{ type: 'orderedList', attrs: { order: 1 }, content: ts.map((t) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })) }] });
globalThis.JIRA = async (path, init) => {
  if (S.down) return { __status: 503, body: {} };
  if (path.includes('/properties/')) return {};
  if (path.includes('mypermissions')) return { permissions: { EDIT_ISSUES: { havePermission: true } } };
  if (path.includes('/myself')) return S.me;
  if (init?.method === 'PUT') {
    if (S.putFail) return { __status: 500, body: { errorMessages: ['boom'] } };
    S.description = structuredClone(JSON.parse(init.body).fields.description);
    return {};
  }
  return { id: '100', key: 'ENG-1', fields: { summary: 's', description: structuredClone(S.description), attachment: S.attachments } };
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

// ---------- saving a review and the release gate ----------
const { ENGINE_VERSION } = await import('../shared/review.mjs');
const { releaseGate } = await import('../src/index.js');
const pdf = (id, filename, h) => ({ id: String(id), filename, mimeType: 'application/pdf', created: `2026-11-02T0${h}:00:00Z` });
const ctx = { context: { extension: { issue: { key: 'ENG-1' } }, accountId: 'alice' } };
const review = (over = {}) => ({ engine: ENGINE_VERSION, revA: { id: 1, filename: 'X_rev-C.pdf' }, revB: { id: 2, filename: 'X_rev-D.pdf' }, clouds: [{ id: 's1-c1', n: 1, zone: 'C3', kind: 'added', x0: 0, y0: 0, x1: 10, y1: 10 }], sheets: { count: 1, done: [1] }, setAside: [], print: null, marks: [], markDecisions: {}, decisions: {}, ...over });
const save = (r, signed = []) => defs.saveReview({ ...ctx, payload: { baseVersion: globalThis.KV.get('review:100')?.version || 0, review: r, signed, confirmed: [], shown: {}, pdfsShown: S.attachments.map((a) => +a.id) } });
const gate = () => releaseGate({ issue: { key: 'ENG-1', id: '100' } });
const fresh2 = () => { globalThis.KV.clear(); S.description = null; S.down = false; S.attachments = [pdf(1, 'X_rev-C.pdf', 1), pdf(2, 'X_rev-D.pdf', 2)]; };

test('the gate holds two revisions nobody compared, and fails closed when Jira cannot be read', async () => {
  fresh2();
  assert.equal((await gate()).result, false);
  S.down = true;
  assert.match((await gate()).errorMessage, /could not read|release waits/);
});

test('a review must name the pair the gate expects', async () => {
  fresh2();
  const out = await save(review({ revA: { id: 2 }, revB: { id: 1 } }));
  assert.equal(out.stale, true);
  assert.equal(globalThis.KV.get('review:100'), undefined);
});

test('the signer is the account Jira reports, never a name sent by the browser; then the gate clears', async () => {
  fresh2();
  S.me = { accountId: 'alice', displayName: 'Alice' };
  // a decision is saved first; a signature is on a decision the server already holds
  await save(review({ decisions: { 's1-c1': { status: 'accepted' } } }));
  await save(review({ decisions: { 's1-c1': { status: 'accepted', signedBy: 'Mallory', signedAt: '2026-11-02T06:00:00Z' } } }), ['s1-c1']);
  const stored = globalThis.KV.get('review:100');
  assert.equal(stored.decisions['s1-c1'].signedBy, 'Alice');
  assert.equal((await gate()).result, true);
  // an unsigned decision the browser marks as signed is not signed
  fresh2();
  await save(review({ decisions: { 's1-c1': { status: 'accepted' } } }));
  await save(review({ decisions: { 's1-c1': { status: 'accepted', signedBy: 'Mallory', signedAt: '2026-11-02T06:00:00Z' } } }), []);
  assert.ok(!globalThis.KV.get('review:100').decisions['s1-c1'].signedBy);
  assert.equal((await gate()).result, false);
});

test('a later save of the same pair never drops a change, and a PDF attached later holds until set aside', async () => {
  fresh2();
  await save(review({ decisions: { 's1-c1': { status: 'accepted' } } }));
  await save(review({ decisions: { 's1-c1': { status: 'accepted', signedAt: '2026-11-02T06:00:00Z' } } }), ['s1-c1']);
  await save(review({ clouds: [], decisions: globalThis.KV.get('review:100').decisions }));
  assert.deepEqual(globalThis.KV.get('review:100').clouds.map((c) => c.id), ['s1-c1']);
  assert.equal((await gate()).result, true);
  S.attachments = [...S.attachments, pdf(3, 'ECO form.pdf', 3)];
  assert.equal((await gate()).result, false);
  // saving again from a light table that was shown the new PDF does not clear it: only setting it aside by name does
  await save(review({ decisions: globalThis.KV.get('review:100').decisions }));
  assert.equal((await gate()).result, false);
});

test('an answer keeps its author only on the markup in the same place: nobody can sign a new markup in another name', async () => {
  fresh2();
  S.attachments = [...S.attachments, { id: '9', filename: 'print.jpg', mimeType: 'image/jpeg', created: '2026-11-02T03:00:00Z' }];
  const print = { id: 9, filename: 'print.jpg' };
  S.me = { accountId: 'alice', displayName: 'Alice' };
  await save(review({ print, marks: [{ id: 'p9-1', n: 1, zone: 'B2', box: [0, 0, 10, 10] }], markDecisions: { 'p9-1': { status: 'dismissed' } } }));
  const alice = globalThis.KV.get('review:100').markDecisions['p9-1'];
  assert.equal(alice.by, 'Alice');
  // Bob keeps Alice's answer on her markup, and sends a new markup elsewhere carrying a copy of her answer
  S.me = { accountId: 'bob', displayName: 'Bob' };
  await save(review({ print, marks: [{ id: 'p9-1', n: 1, zone: 'B2', box: [0, 0, 10, 10] }, { id: 'p9-2', n: 2, zone: 'D4', box: [50, 50, 60, 60] }],
    markDecisions: { 'p9-1': alice, 'p9-2': { ...alice } } }));
  const d = globalThis.KV.get('review:100').markDecisions;
  assert.equal(d['p9-1'].by, 'Alice');
  assert.equal(d['p9-2'].by, 'Bob');
  S.me = { accountId: 'alice', displayName: 'Alice' };
});
