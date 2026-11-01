// Unit tests for the release verdict and change-note parsing. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { gateOf, verdictOf, valueSlip, numbersIn, drawingOf, noteSlip, valueOkFor, drawingPdfs } from '../shared/gate.mjs';
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
  assert.equal(gateOf([], { __ack: { status: 'ack', signedBy: 'Asha' } }, marks, { m1: { status: 'dismissed' } }).blocked, false);
});

test('a multi-sheet drawing blocks until every sheet is compared', () => {
  const g = gateOf([], {}, [], {}, { count: 3, done: [1, 2] });
  assert.equal(g.unseen, 1);
  assert.match(g.text, /1 of 3 sheets is not compared yet/);
  assert.equal(gateOf([], { __ack: { status: 'ack', signedBy: 'Asha' } }, [], {}, { count: 3, done: [1, 2, 3] }).blocked, false);
});

test('a work item without two drawings is not a drawing change', () => {
  assert.equal(verdictOf([C], null).blocked, false);
});

test('two drawings with no review block release', () => {
  assert.equal(verdictOf([C, D], null).blocked, true);
});

test('a revision attached after the review blocks release', () => {
  const review = { revA: { id: 10 }, revB: { id: 11 }, clouds: [], decisions: { __ack: { status: 'ack', signedBy: 'Asha' } } };
  assert.equal(verdictOf([C, D], review).blocked, false);
  const v = verdictOf([C, D, E], review);
  assert.equal(v.blocked, true);
  assert.match(v.text, /newer drawing revision/);
});

test('removing a reviewed drawing blocks release', () => {
  const review = { revA: { id: 10 }, revB: { id: 11 }, clouds: [], decisions: { __ack: { status: 'ack', signedBy: 'Asha' } } };
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
  const review = { revA: { id: 10 }, revB: { id: 11 }, clouds: [], decisions: { __ack: { status: 'ack', signedBy: 'Asha' } } };
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

// ---------- housekeeping: what may be signed together ----------
import { isStamp, withHousekeeping } from '../static/lighttable/src/engine/housekeeping.mjs';

test('plot stamps are only stamp tokens and title-block words', () => {
  assert.equal(isStamp('Date: 2024-01-12', 'Date: 2025-03-02'), true);
  assert.equal(isStamp('KiCad E.D.A. 8.0.4', 'KiCad E.D.A. 9.0.1'), true);
  assert.equal(isStamp('File: C:/work/board/main.kicad_sch 10:31:22', 'File: D:/new/board/main.kicad_sch 09:02:11'), true);
});

test('engineering changes that look like dates or versions are never plot stamps', () => {
  for (const [a, b] of [
    ['1/4-20 UNC-2B', '5/16-18 UNC-2B'], ['SCALE 1:20', 'SCALE 1:50'], ['1:20', '1:50'],
    ['12.70-12.75', '12.80-12.85'], ['Ø6.35-6.40', 'Ø6.50-6.55'],
    ['Rev 2024-01-01', 'Rev 2024-02-01 ECO-1234 HOLE MOVED'], ['Date: 2024-01-12', 'Date: 2024-02-12 SEE NOTE 4'],
  ]) assert.equal(isStamp(a, b), false, `${a} -> ${b}`);
});

test('a move is housekeeping only when the changed ink is text', () => {
  const label = { move: { mm: 1 }, sameText: true, textShare: 0.95 };
  assert.equal(withHousekeeping(label).housekeeping, 'textMove');
  assert.equal(withHousekeeping({ ...label, textShare: 0.4 }).housekeeping, undefined); // a hole moved with its callout
  assert.equal(withHousekeeping({ before: 'Date: 2024-01-12', after: 'Date: 2025-01-12', textShare: 0.5 }).housekeeping, undefined);
});

// ---------- saving a review: re-reads and repeats ----------
import { ENGINE_VERSION, matchChanges, sameReview } from '../shared/review.mjs';

test('after a re-read, each earlier change is matched once, to the new change in the same place', () => {
  const old = [{ id: 's1-c1', sheet: 1, box: [0, 0, 10, 10] }, { id: 's1-c2', sheet: 1, box: [100, 100, 120, 120] }, { id: 's2-c1', sheet: 2, box: [0, 0, 10, 10] }];
  const now = [{ id: 's1-c1', sheet: 1, box: [101, 101, 119, 119] }, { id: 's1-c2', sheet: 1, box: [1, 1, 9, 9] }, { id: 's1-c3', sheet: 1, box: [2, 2, 8, 8] }, { id: 's1-c4', sheet: 1, box: [500, 500, 510, 510] }];
  const m = matchChanges(old, now);
  assert.equal(m['s1-c1'], 's1-c2'); // renumbered: follows its place, not its number
  assert.equal(Object.values(m).filter((o) => o === 's1-c1').length, 1); // never handed to two changes
  assert.equal(m['s1-c4'], undefined); // a new change starts open
  assert.ok(!Object.values(m).includes('s2-c1')); // other sheets are never matched
  assert.equal(ENGINE_VERSION, 'redline-core 0.6');
});

test('a save that changes nothing is recognised; any decision or finding change is not', () => {
  const base = { revA: { id: 1 }, revB: { id: 2 }, engine: ENGINE_VERSION, clouds: [{ id: 's1-c1' }], decisions: { 's1-c1': { status: 'declared', note: 1, signedAt: 't1', signedBy: 'A' } } };
  assert.equal(sameReview(base, { ...base, analysedAt: 'later', decisions: { 's1-c1': { status: 'declared', note: 1, signedAt: 't1' } } }), true);
  assert.equal(sameReview(base, { ...base, decisions: { 's1-c1': { status: 'declared', note: 2, signedAt: 't1' } } }), false);
  assert.equal(sameReview(base, { ...base, clouds: [] }), false);
});

// ---------- the title block's revision letter ----------
import { revisionOfName, titleBlockRevision } from '../static/lighttable/src/engine/titleblock.mjs';

test('the revision a file name gives', () => {
  assert.equal(revisionOfName('BRKT-0142_rev-D.pdf'), 'D');
  assert.equal(revisionOfName('bracket REV C.pdf'), 'C');
  assert.equal(revisionOfName('preview.pdf'), null);
  assert.equal(revisionOfName('revised layout.pdf'), null);
  assert.equal(revisionOfName('bracket_review.pdf'), null);
  assert.equal(revisionOfName('BRKT_revD.pdf'), 'D');
  assert.equal(revisionOfName('housing rev-10.pdf'), '10');
  assert.equal(revisionOfName('plate_REV_AB.pdf'), 'AB');
});

test('the title block letter: split or joined words, lowest label wins, nothing outside the corner', () => {
  const w = 1000, h = 800;
  assert.deepEqual(titleBlockRevision([{ str: 'Rev', x0: 900, y0: 760, x1: 925, y1: 775 }, { str: 'D', x0: 930, y0: 760, x1: 938, y1: 775 }], w, h).letter, 'D');
  assert.equal(titleBlockRevision([{ str: 'REV: C', x0: 900, y0: 760, x1: 950, y1: 775 }], w, h).letter, 'C');
  assert.equal(titleBlockRevision([{ str: 'Rev', x0: 900, y0: 700, x1: 925, y1: 715 }, { str: 'B', x0: 930, y0: 700, x1: 938, y1: 715 },
    { str: 'Rev', x0: 900, y0: 760, x1: 925, y1: 775 }, { str: 'C', x0: 930, y0: 760, x1: 938, y1: 775 }], w, h).letter, 'C');
  assert.equal(titleBlockRevision([{ str: 'Rev', x0: 100, y0: 100, x1: 125, y1: 115 }, { str: 'D', x0: 130, y0: 100, x1: 138, y1: 115 }], w, h), null);
});

test('file names that only look like revisions are not read as one', () => {
  for (const f of ['drawing_rev.pdf', 'bracket review.pdf', 'plate_revs.pdf', 'previous.pdf']) assert.equal(revisionOfName(f), null, f);
  assert.equal(revisionOfName('part_rev_03.pdf'), '3');
});

test('a title block letter in the cell below the REV label is read', () => {
  assert.equal(titleBlockRevision([{ str: 'REV', x0: 900, y0: 740, x1: 930, y1: 752 }, { str: 'D', x0: 908, y0: 758, x1: 918, y1: 772 }], 1000, 800).letter, 'D');
  assert.equal(titleBlockRevision([{ str: 'REV', x0: 900, y0: 740, x1: 930, y1: 752 }, { str: '03', x0: 908, y0: 758, x1: 922, y1: 772 }], 1000, 800).letter, '3');
});

// ---------- text the pixels can miss ----------
import { textChanges, bothReadable } from '../static/lighttable/src/engine/textdiff.mjs';

test('a one-letter or one-digit text edit is a change; the same words split differently are not', () => {
  const a = [{ str: 'Rev A', x0: 100, y0: 100, x1: 150, y1: 112 }, { str: 'Ø25.5 ±0.15', x0: 300, y0: 300, x1: 380, y1: 312 }, { str: 'BREAK ALL EDGES', x0: 500, y0: 500, x1: 600, y1: 512 }];
  const b = [{ str: 'Rev', x0: 100, y0: 100, x1: 128, y1: 112 }, { str: 'B', x0: 132, y0: 100, x1: 142, y1: 112 },
    { str: 'Ø25.6 ±0.15', x0: 301, y0: 300, x1: 381, y1: 312 }, { str: 'BREAK ALL', x0: 500, y0: 500, x1: 560, y1: 512 }, { str: 'EDGES', x0: 564, y0: 500, x1: 600, y1: 512 }];
  const ch = textChanges(a, b);
  assert.deepEqual(ch.map((c) => [c.before, c.after]), [['Rev A', 'Rev B'], ['Ø25.5 ±0.15', 'Ø25.6 ±0.15']]);
  assert.deepEqual(textChanges([{ str: 'NOTE 4', x0: 0, y0: 0, x1: 40, y1: 10 }], []).map((c) => [c.before, c.after]), [['NOTE 4', '']]);
});

// ---------- what a changed callout means ----------
import { meaningOf } from '../static/lighttable/src/engine/meaning.mjs';

test('a changed callout is described in engineering terms', () => {
  assert.deepEqual(meaningOf('Ø25 ±0.15', 'Ø25.5 ±0.15').map((m) => m.text), ['Diameter 25 to 25.5 (+0.5)']);
  assert.deepEqual(meaningOf('Ø25.5 ±0.15', 'Ø25.5 ±0.05').map((m) => m.text), ['Tolerance tightened: ±0.15 to ±0.05']);
  assert.deepEqual(meaningOf('R3', 'R5').map((m) => m.text), ['Radius 3 to 5 (+2)']);
  assert.deepEqual(meaningOf('1/4-20 UNC-2B', '5/16-18 UNC-2B').map((m) => m.text), ['Thread changed: 1/4-20 UNC to 5/16-18 UNC']);
  assert.deepEqual(meaningOf('60° ±0.5', '45° ±0.5').map((m) => m.text), ['Angle 60 to 45 (-15)']);
  assert.deepEqual(meaningOf('NOTE 4', 'NOTE 5'), []);
});

test('words are only compared when both revisions keep readable text, and read line by line', () => {
  const a = [{ str: 'BORE', x0: 0, y0: 0, x1: 30, y1: 10 }, { str: 'DEPTH', x0: 40, y0: 0, x1: 70, y1: 10 }, { str: 'NOTE', x0: 0, y0: 50, x1: 30, y1: 60 }];
  assert.equal(bothReadable(a, []), false); // a scan
  assert.equal(bothReadable(a, [{ str: 'x', x0: 0, y0: 0, x1: 1, y1: 1 }, { str: 'y', x0: 0, y0: 0, x1: 1, y1: 1 }, { str: 'z', x0: 0, y0: 0, x1: 1, y1: 1 }]), false); // outlined text, other words
  assert.equal(bothReadable(a, a), true);
  // a taller word on the same line does not reorder the line
  assert.deepEqual(textChanges([{ str: 'Ø25', x0: 0, y0: 2, x1: 20, y1: 10 }, { str: 'THRU', x0: 22, y0: 0, x1: 50, y1: 12 }],
    [{ str: 'Ø25 THRU', x0: 0, y0: 1, x1: 50, y1: 11 }]), []);
});

test('symbol and ligature variants read the same', () => {
  assert.deepEqual(textChanges([{ str: '2× ∅6.5 ﬁt', x0: 0, y0: 0, x1: 60, y1: 10 }], [{ str: '2x Ø6.5 fit', x0: 0, y0: 0, x1: 60, y1: 10 }]), []);
});

test('numbered screw threads are threads too', () => {
  assert.deepEqual(meaningOf('#10-32 UNF', '#8-32 UNC').map((m) => m.text), ['Thread changed: #10-32 UNF to #8-32 UNC']);
});

test('a sign-off is for the note as it read: a rewritten note needs signing again', () => {
  const c = [{ id: 'c1', values: [] }];
  const d = { c1: { status: 'declared', note: 1, signedBy: 'Asha', noteText: 'Zone D2: bore Ø25 becomes Ø25.5' } };
  assert.equal(gateOf(c, d, [], {}, null, [{ n: 1, text: 'Zone D2:  bore Ø25 becomes Ø25.5' }]).blocked, false); // spacing only
  const g = gateOf(c, d, [], {}, null, [{ n: 1, text: 'Zone B5: delete the weld symbol' }]);
  assert.equal(g.blocked, true);
  assert.equal(g.noteChanged, 1);
});

test('a review that found nothing, or set line work aside, clears only once someone confirms it by name', () => {
  assert.equal(gateOf([], {}).blocked, true);
  assert.equal(gateOf([], { __ack: { status: 'ack', signedBy: 'Asha' } }).blocked, false);
  const c = [{ id: 'c1' }], d = { c1: { status: 'accepted', signedBy: 'Asha' } };
  assert.equal(gateOf(c, d).blocked, false);
  assert.equal(gateOf(c, d, [], {}, null, null, { setAside: 3 }).blocked, true);
  assert.equal(gateOf(c, { ...d, __ack: { status: 'ack', signedBy: 'Asha' } }, [], {}, null, null, { setAside: 3 }).blocked, false);
});

test('inch values read the same with or without a leading zero', () => {
  assert.deepEqual(valueSlip({ values: [0.257] }, 'Hole .257 becomes 0.257 DIA'), []);
  assert.deepEqual(numbersIn('.257'), [0.257]);
});

test('two different drawings on one change order block release', () => {
  const pdf = (id, filename) => ({ id, filename, mimeType: 'application/pdf', created: `2026-11-02T0${id % 10}:00:00Z` });
  assert.equal(drawingOf('BRKT-0142_rev-D.pdf'), 'brkt-0142');
  assert.equal(drawingOf('invoice.pdf'), null);
  const v = verdictOf([pdf(1, 'BRKT-0142_rev-C.pdf'), pdf(2, 'BRKT-0142_rev-D.pdf'), pdf(3, 'HSG-0207_rev-A.pdf'), pdf(4, 'HSG-0207_rev-B.pdf')], null);
  assert.equal(v.blocked, true);
  assert.match(v.text, /2 different drawings/);
});

test('text split into different runs is still compared', () => {
  const a = [{ str: 'BORE Ø25 ±0.15 THRU', x0: 0, y0: 0, x1: 90, y1: 10 }];
  const b = [{ str: 'BORE', x0: 0, y0: 0, x1: 20, y1: 10 }, { str: 'Ø25', x0: 22, y0: 0, x1: 40, y1: 10 }, { str: '±0.16', x0: 42, y0: 0, x1: 66, y1: 10 }, { str: 'THRU', x0: 68, y0: 0, x1: 90, y1: 10 }];
  assert.equal(bothReadable(a, b), true);
});

test('a review document is not a drawing revision', () => {
  assert.equal(drawingOf('design-review.pdf'), null);
  assert.equal(drawingOf('HSG-0207 Rev 3.pdf'), 'hsg-0207');
});

test('a value the note promises but the drawing does not show holds the release', () => {
  const note = [{ n: 1, text: 'Zone D2: bore Ø25 ±0.15 becomes Ø25.5 ±0.1' }];
  const c = [{ id: 'c1', before: 'Ø25 ±0.15', after: 'Ø25 ±0.1', values: [0.1] }]; // only the tolerance was changed
  assert.deepEqual(noteSlip(c[0], note[0].text), [25.5]);
  assert.equal(gateOf(c, { c1: { status: 'declared', note: 1, signedBy: 'Asha' } }, [], {}, null, note).mismatched, 1);
  // the drawing does what the note says: no slip either way
  assert.deepEqual(noteSlip({ before: 'Ø25 ±0.15', after: 'Ø25.5 ±0.1' }, note[0].text), []);
  // a note about something else is not read against this text
  assert.deepEqual(noteSlip({ before: 'R3', after: 'R4' }, note[0].text), []);
});

test('"the drawing is right" is for the note as it read: a rewritten note asks again', () => {
  const c = [{ id: 'c1', values: [25.6] }];
  const said = { status: 'declared', note: 1, signedBy: 'Asha', noteText: 'Zone D2: bore Ø25 becomes Ø25.5', valueOk: { by: 'Asha', noteText: 'Zone D2: bore Ø25 becomes Ø25.5' } };
  assert.equal(gateOf(c, { c1: said }, [], {}, null, [{ n: 1, text: 'Zone D2: bore Ø25 becomes Ø25.5' }]).mismatched, 0);
  const g = gateOf(c, { c1: { ...said, noteText: 'Zone D2: bore Ø25 becomes Ø25.7', signedBy: 'Asha' } }, [], {}, null, [{ n: 1, text: 'Zone D2: bore Ø25 becomes Ø25.7' }]);
  assert.equal(g.mismatched, 1);
  assert.equal(valueOkFor(said, { text: 'Zone D2: bore Ø25 becomes Ø25.7' }), false);
});

test('note numbers that are not dimensions are not read as promised values', () => {
  const c = { before: 'Ø25 ±0.15', after: 'Ø25.5 ±0.15' };
  assert.deepEqual(noteSlip(c, 'Zone D2: bore Ø25 becomes Ø25.5 for bearing 6205, per ECR 1043, 2 places'), []);
  assert.deepEqual(noteSlip({ before: 'Ø25 ±0.15', after: 'Ø25 ±0.15' }, 'bore Ø25 becomes Ø25.5'), [25.5]);
});

test('a confirmation of what was set aside covers that list; a longer list asks again', () => {
  const ack = { __ack: { status: 'ack', signedBy: 'Asha', asideCount: 2 } };
  assert.equal(gateOf([], ack, [], {}, null, null, { setAside: 2 }).blocked, false);
  assert.equal(gateOf([], ack, [], {}, null, null, { setAside: 3 }).blocked, true);
});

test('a new signature is a change to save, even when the decision reads the same', () => {
  const base = { revA: { id: 1 }, revB: { id: 2 }, engine: 'e', clouds: [], decisions: { c1: { status: 'declared', note: 1, signedAt: '2026-11-02T01:00:00Z' } } };
  assert.equal(sameReview(base, { ...base, decisions: { c1: { status: 'declared', note: 1, signedAt: '2026-11-02T02:00:00Z' } } }), false);
  assert.equal(sameReview(base, JSON.parse(JSON.stringify(base))), true);
});

test('the drawing revisions are the PDFs named as revisions of one drawing; forms and reports are left alone', () => {
  const pdf = (id, filename) => ({ id, filename, mimeType: 'application/pdf', created: `2026-11-02T0${id}:00:00Z` });
  const { pdfs } = drawingPdfs([pdf(1, 'BRKT-0142_rev-C.pdf'), pdf(2, 'ECO-1043_rev-B.pdf'), pdf(3, 'BRKT0142 Rev D.pdf'), pdf(4, 'FAI-report.pdf')]);
  assert.deepEqual(pdfs.map((a) => a.id), [1, 3]);
  // no revision names at all: every PDF counts, as before
  assert.deepEqual(drawingPdfs([pdf(1, 'a.pdf'), pdf(2, 'b.pdf')]).pdfs.map((a) => a.id), [1, 2]);
});

test('a change note nothing on the drawing carries out holds the release until someone says it needs no drawing change', () => {
  const notes = [{ n: 1, text: 'Zone D2: bore Ø25 becomes Ø25.5' }, { n: 2, text: 'Zone A7: add a note' }];
  const c = [{ id: 'c1' }];
  const d = { c1: { status: 'declared', note: 1, signedBy: 'Asha' } };
  const g = gateOf(c, d, [], {}, null, notes);
  assert.equal(g.unmet, 1);
  assert.equal(g.blocked, true);
  assert.equal(gateOf(c, { ...d, note2: { status: 'nochange', signedBy: 'Asha' } }, [], {}, null, notes).blocked, false);
});

test('no change on the drawing: notes still have to be carried out, and someone confirms by name, whatever the photo shows', () => {
  const notes = [{ n: 1, text: 'Zone D2: bore Ø25 becomes Ø25.5' }];
  const marks = [{ id: 'm1' }], md = { m1: { status: 'dismissed' } };
  const g = gateOf([], {}, marks, md, null, notes);
  assert.equal(g.blocked, true);
  assert.equal(g.unmet, 1);
  assert.equal(g.unconfirmed, 1);
  const ok = gateOf([], { __ack: { status: 'ack', signedBy: 'Asha' }, note1: { status: 'nochange', signedBy: 'Asha' } }, marks, md, null, notes);
  assert.equal(ok.blocked, false);
  assert.match(ok.text, /confirmed by Asha/);
});

test('revision names may carry a short suffix', () => {
  assert.equal(drawingOf('BRKT-0142 rev D-signed.pdf'), 'brkt-0142');
});

test('a PDF attached after the reviewed revision that Redline cannot place holds the release until set aside by name', () => {
  const pdf = (id, filename) => ({ id, filename, mimeType: 'application/pdf', created: `2026-11-02T0${id}:00:00Z` });
  const review = { revA: { id: 1 }, revB: { id: 2 }, clouds: [], decisions: { __ack: { status: 'ack', signedBy: 'Asha' } } };
  const atts = [pdf(1, 'BRKT-0142_rev-C.pdf'), pdf(2, 'BRKT-0142_rev-D.pdf'), pdf(3, 'BRKT-0142-E.pdf')];
  assert.match(verdictOf(atts, review).text, /not compared/);
  assert.equal(verdictOf(atts, { ...review, decisions: { ...review.decisions, pdf3: { status: 'aside', signedBy: 'Asha' } } }).blocked, false);
  assert.equal(drawingOf('BRKT-0142 Rev E (released).pdf'), 'brkt-0142');
});

// ---------- who signed what (the server's rules) ----------
import { settleSignatures, carriedChanges } from '../shared/review.mjs';
const alice = { accountId: 'a', displayName: 'Alice' }, bob = { accountId: 'b', displayName: 'Bob' };
const notesV1 = [{ n: 1, text: 'Zone D2: bore Ø25 becomes Ø25.5' }], notesV2 = [{ n: 1, text: 'Zone D2: bore Ø25 becomes Ø25.7' }];

test('only what the caller signed in this save is stamped, in the caller\'s name', () => {
  const stored = { c1: { status: 'declared', note: 1, signedAt: 't1', signedById: 'a', signedBy: 'Alice', noteText: 'Zone D2: bore Ø25 becomes Ø25.5' } };
  // Bob's save carries Alice's signature back (as the browser holds it) and signs nothing himself
  const d = { c1: { status: 'declared', note: 1, signedAt: 't1', signedBy: 'Alice' }, c2: { status: 'accepted', signedAt: 'forged', signedBy: 'Mallory' } };
  const stamped = settleSignatures(d, { beforeOf: (id) => stored[id], notes: notesV1, signed: [], me: bob, now: 't2' });
  assert.deepEqual(stamped, []);
  assert.equal(d.c1.signedBy, 'Alice'); // kept: nothing changed
  assert.equal(d.c2.signedBy, undefined); // a signature the server never stamped is dropped
});

test('a rewritten note drops the signature and the value confirmation, and never re-stamps them in the next saver\'s name', () => {
  const stored = { c1: { status: 'declared', note: 1, signedAt: 't1', signedById: 'a', signedBy: 'Alice', noteText: 'Zone D2: bore Ø25 becomes Ø25.5', valueOk: { by: 'Alice', at: 't1', noteText: 'Zone D2: bore Ø25 becomes Ø25.5' } } };
  const d = { c1: { status: 'declared', note: 1, signedAt: 't1', signedBy: 'Alice', valueOk: { by: 'Alice', at: 't1' } } };
  settleSignatures(d, { beforeOf: (id) => stored[id], notes: notesV2, signed: [], confirmed: [], me: bob, now: 't2' });
  assert.equal(d.c1.signedBy, undefined);
  assert.equal(d.c1.valueOk, undefined);
  // Bob signs it for the new words
  const d2 = { c1: { status: 'declared', note: 1, signedAt: 't3' } };
  settleSignatures(d2, { beforeOf: () => d.c1, notes: notesV2, signed: ['c1'], me: bob, now: 't3' });
  assert.equal(d2.c1.signedBy, 'Bob');
  assert.equal(d2.c1.noteText, 'Zone D2: bore Ø25 becomes Ø25.7');
});

test('Confirm again stamps a fresh confirmation covering the current set-aside list', () => {
  const stored = { __ack: { status: 'ack', signedAt: 't1', signedById: 'a', signedBy: 'Alice', asideCount: 2 } };
  const d = { __ack: { status: 'ack', signedAt: 't2' } };
  settleSignatures(d, { beforeOf: (id) => stored[id], signed: ['__ack'], me: bob, now: 't2', asideTotal: 5 });
  assert.equal(d.__ack.signedBy, 'Bob');
  assert.equal(d.__ack.asideCount, 5);
});

test('a note that does not read for a moment keeps the words its signature was given against', () => {
  const stored = { c1: { status: 'declared', note: 1, signedAt: 't1', signedById: 'a', signedBy: 'Alice', noteText: 'Zone D2: bore Ø25 becomes Ø25.5' } };
  const d = { c1: { status: 'declared', note: 1, signedAt: 't1' } };
  settleSignatures(d, { beforeOf: (id) => stored[id], notes: [], me: bob, now: 't2' });
  assert.equal(d.c1.signedBy, 'Alice');
  assert.equal(d.c1.noteText, 'Zone D2: bore Ø25 becomes Ø25.5');
  // and once it reads again with other words, the signature is gone
  const d2 = { c1: { ...d.c1 } };
  settleSignatures(d2, { beforeOf: () => d.c1, notes: notesV2, me: bob, now: 't3' });
  assert.equal(d2.c1.signedBy, undefined);
});

test('a signature for note words the reviewer never saw is not taken, and the note is named', () => {
  const stored = { c1: { status: 'declared', note: 1 } };
  const d = { c1: { status: 'declared', note: 1, signedAt: 't2' } };
  const stale = [];
  settleSignatures(d, { beforeOf: (id) => stored[id], notes: notesV2, signed: ['c1'], shown: { c1: 'Zone D2: bore Ø25 becomes Ø25.5' }, me: alice, now: 't2', stale });
  assert.equal(d.c1.signedBy, undefined);
  assert.deepEqual(stale, [1]);
  const d2 = { note2: { status: 'nochange', signedAt: 't2' } };
  const notes = [{ n: 2, text: 'Zone B4: add hole Ø8 thru' }];
  settleSignatures(d2, { beforeOf: () => undefined, notes, signed: ['note2'], shown: { note2: 'Update the parts list supplier' }, me: alice, now: 't2', stale: [] });
  assert.equal(d2.note2.signedBy, undefined);
});

test('a change sent back on C to D still holds when revision E arrives, until someone says E fixes it', () => {
  const previous = { revA: { id: 1, filename: 'BRKT_rev-C.pdf' }, revB: { id: 2, filename: 'BRKT_rev-D.pdf' },
    clouds: [{ id: 's1-c1', zone: 'D2' }, { id: 's1-c2', zone: 'C3' }],
    decisions: { 's1-c1': { status: 'declared', note: 1, signedBy: 'Asha' }, 's1-c2': { status: 'rejected' } } };
  const carried = carriedChanges(previous, { id: 2 });
  assert.deepEqual(carried.map((c) => c.id), ['k-s1-c2']);
  assert.equal(carried[0].carried.was, 'sent back');
  // the D to E review found nothing new, but the carried change holds
  assert.equal(gateOf(carried, { __ack: { status: 'ack', signedBy: 'Asha' } }).blocked, true);
  assert.equal(gateOf(carried, { 'k-s1-c2': { status: 'accepted', signedBy: 'Asha' } }).blocked, false);
  // nothing is carried into a pair that does not continue the previous one
  assert.deepEqual(carriedChanges(previous, { id: 9 }), []);
});
