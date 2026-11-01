// Unit tests for the release verdict and change-note parsing. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { gateOf, verdictOf, valueSlip, numbersIn } from '../shared/gate.mjs';
import { notesFromAdf } from '../shared/notes.mjs';

const pdf = (id, created) => ({ id: String(id), mimeType: 'application/pdf', created });
const C = pdf(10, '2026-10-28T09:00:00Z'), D = pdf(11, '2026-11-01T09:00:00Z'), E = pdf(12, '2026-11-02T09:00:00Z');
const clouds = [{ id: 'c1' }, { id: 'c2' }];
const signed = (note) => ({ status: 'declared', note, signedBy: 'Priya Nair', signedAt: '2026-11-01T10:00:00Z' });

test('an undeclared change blocks release', () => {
  const g = gateOf(clouds, { c1: signed(1) });
  assert.equal(g.blocked, true);
  assert.equal(g.open, 1);
  assert.match(g.text, /1 change on the drawing is not in the change notes/);
});

test('declared but unsigned changes still block', () => {
  const g = gateOf(clouds, { c1: { status: 'declared', note: 1 }, c2: { status: 'accepted' } });
  assert.equal(g.blocked, true);
  assert.equal(g.unsigned, 2);
});

test('every change declared and signed clears the gate', () => {
  const g = gateOf(clouds, { c1: signed(1), c2: signed(2) });
  assert.equal(g.blocked, false);
  assert.equal(g.status, 'clear');
});

test('a sent-back change blocks', () => {
  assert.equal(gateOf(clouds, { c1: signed(1), c2: { status: 'rejected' } }).rejected, 1);
});

test('an unanswered pen markup blocks, an answered one does not', () => {
  const marks = [{ id: 'm1' }];
  assert.equal(gateOf([], {}, marks, {}).blocked, true);
  assert.equal(gateOf([], {}, marks, { m1: { status: 'dismissed' } }).blocked, false);
});

test('a multi-sheet drawing blocks until every sheet is compared', () => {
  const g = gateOf([], {}, [], {}, { count: 3, done: [1, 2] });
  assert.equal(g.unseen, 1);
  assert.match(g.text, /1 of 3 sheets is not compared yet/);
  assert.equal(gateOf([], {}, [], {}, { count: 3, done: [1, 2, 3] }).blocked, false);
});

test('a work item without two drawings is not a drawing change', () => {
  assert.equal(verdictOf([C], null).blocked, false);
});

test('two drawings with no review block release', () => {
  assert.equal(verdictOf([C, D], null).blocked, true);
});

test('a revision attached after the review blocks release', () => {
  const review = { revA: { id: 10 }, revB: { id: 11 }, clouds: [], decisions: {} };
  assert.equal(verdictOf([C, D], review).blocked, false);
  const v = verdictOf([C, D, E], review);
  assert.equal(v.blocked, true);
  assert.match(v.text, /newer drawing revision/);
});

test('removing a reviewed drawing blocks release', () => {
  const review = { revA: { id: 10 }, revB: { id: 11 }, clouds: [], decisions: {} };
  assert.match(verdictOf([D], review).text, /removed/);
});

test('the verdict comes from the stored review, not a property', () => {
  const review = { revA: { id: 10 }, revB: { id: 11 }, clouds, decisions: { c1: signed(1) }, gate: { status: 'clear' } };
  assert.equal(verdictOf([C, D], review).blocked, true); // the stale "clear" in the review is ignored
});

test('change notes come from ordered lists and numbered paragraphs', () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Change notes' }] },
    { type: 'orderedList', attrs: { order: 1 }, content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Zone D2: bore Ø25 to Ø25.5' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Zone A7: add note' }] }] },
    ] },
    { type: 'paragraph', content: [{ type: 'text', text: '3. Sheet 2, zone B4: move hole' }] },
  ] };
  assert.deepEqual(notesFromAdf(doc), [
    { n: 1, text: 'Zone D2: bore Ø25 to Ø25.5' },
    { n: 2, text: 'Zone A7: add note' },
    { n: 3, text: 'Sheet 2, zone B4: move hole' },
  ]);
});

test('a photo attached after the review blocks release until it is read or set aside', () => {
  const photo = { id: '20', mimeType: 'image/jpeg', created: '2026-11-02T10:00:00Z' };
  const review = { revA: { id: 10 }, revB: { id: 11 }, clouds: [], decisions: {} };
  assert.match(verdictOf([C, D, photo], review).text, /newest photo/);
  assert.equal(verdictOf([C, D, photo], { ...review, print: { id: 20 } }).blocked, false);
  assert.equal(verdictOf([C, D, photo], { ...review, print: { id: 20, setAside: true } }).blocked, false);
});

test('numbers are read from drawing text', () => {
  assert.deepEqual(numbersIn('Ø25.6 ±0.15'), [25.6, 0.15]);
});

test('a declared change whose drawing value the note does not state blocks release', () => {
  const notes = [{ n: 1, text: 'Zone D2: bore callout Ø25 ±0.15 changes to Ø25.5 ±0.15.' }];
  const c = [{ id: 'c1', values: [25.6, 0.15] }];
  assert.deepEqual(valueSlip(c[0], notes[0].text), [25.6]);
  const g = gateOf(c, { c1: signed(1) }, [], {}, null, notes);
  assert.equal(g.mismatched, 1);
  assert.match(g.text, /value its change note does not/);
  assert.equal(gateOf(c, { c1: { ...signed(1), valueOk: { by: 'Priya' } } }, [], {}, null, notes).blocked, false);
  assert.equal(gateOf([{ id: 'c1', values: [25.5] }], { c1: signed(1) }, [], {}, null, notes).blocked, false);
});

test('a change declared against a note that no longer exists counts as not declared', () => {
  const g = gateOf([{ id: 'c1' }], { c1: signed(3) }, [], {}, null, [{ n: 1, text: 'Zone D2: x' }]);
  assert.equal(g.open, 1);
});

test('zone and sheet labels in a note never vouch for a drawing value', () => {
  assert.deepEqual(valueSlip({ values: [2] }, 'Zone D2: change the radius'), [2]);
  assert.deepEqual(valueSlip({ values: [7] }, 'Sheet 2, zone A7: add note 7'), []);
});

test('the verdict lists every reason, most serious first', () => {
  const g = gateOf([{ id: 'c1' }, { id: 'c2' }], { c2: { status: 'declared', note: 1 } }, [{ id: 'm1' }], {}, null, [{ n: 1, text: 'x' }]);
  assert.match(g.text, /^1 change on the drawing is not in the change notes; 1 pen markup .* an answer; 1 declared change needs a sign-off$/);
});
