![Redline: catches the drawing changes nobody wrote down](docs/cover.png)

# Redline

An engineering change order says what changed on a drawing: *"bore Ø25 becomes Ø25.5"*. The drawing that comes back from the drafter often changes more than that. A hole moves 3 mm, a note disappears, a tolerance tightens. Nobody writes it down, a checker comparing two prints by eye misses it, and the part gets made wrong.

Redline is a Forge app for Jira that compares the two newest PDF revisions attached to a change order and does four things:

- clouds every change between them, the way a drafter marks a revision;
- matches each change to the numbered change notes in the description;
- holds the release transition until every change is declared and signed off;
- reads a phone photo of a marked-up print and lists every red-pen markup on it, so comments from the shop floor need an answer too.

The comparison runs in the browser inside Jira. Drawings never leave Atlassian, and Redline calls no AI service.

## What it does in Jira

**Issue panel.** On the change order, the release verdict in one sentence: *Release blocked: 1 change on the drawing is not in the change notes.* Below it, each sheet as a small diazo print with its changes clouded in the colour of their decision, and the list of changes with who signed each one.

**Light table.** A full-screen review. The sheets light up and the clouds draw themselves where the revisions differ. You can compare the revisions as:

- an overlay, with removed ink in red and added ink in blue;
- a swipe or a blink between them;
- either revision on its own.

The ledger lists each change with before-and-after crops. Arrow keys step through the changes, number keys declare one against a change note, and S signs it off. Multi-sheet drawings are compared sheet by sheet, and the release stays blocked until every sheet has been compared.

**Marked-up prints.** Attach a phone photo of the printed sheet. Redline finds the sheet in the photo, flattens it onto revision B, separates pen red from red printed on the drawing, and lists each markup. Every markup must be raised as a work item, covered by a change, or dismissed before release.

**Release gate.** A workflow validator that refuses the release transition until the review is complete. It reads the review from Redline's own app storage rather than from an issue property, re-checks that the review covers the two newest PDFs, and fails closed if Jira cannot say what is attached. See [Set up the release gate](docs/release-gate.md).

**Search and Rovo.** `redlineGate = "blocked"` in JQL finds blocked change orders. The *Drawing change checker* Rovo agent answers questions such as *"What changed on ENG-1, and is it declared?"*

## How the comparison works

1. pdf.js renders both revisions in the browser at up to 300 dpi.
2. The engine registers revision B onto revision A: first moment-based alignment, then pyramid Lucas-Kanade on the line work, which also absorbs the skew and scale of a rescan.
3. It diffs ink darkness with a small positional tolerance, so anti-aliasing and rescan blur are not counted as changes.
4. It groups changed ink into blobs. On noisy scans it takes a second, contrast-blind look at each blob.
5. It merges edits within about 7 mm into one cloud and names its zone from the ASME drawing border (columns from the right, rows from the bottom), so *"Zone D2"* in a change note links to the change in D2.

A note claims a change outright only when that change is the only one in the zone it names. Anything less certain is shown as a suggestion that a person confirms. That way an undeclared edit can never hide behind a declared one next to it.

The engine is plain JavaScript with no dependencies: [`static/lighttable/src/engine/`](static/lighttable/src/engine/).

## Measured, not claimed

On 352 revision pairs built from public-domain NIST test drawings, with edits planted at the PDF level:

| | Result |
|---|---|
| Digital revisions | 431 of 432 visible edits found, no false clouds on unchanged sheets, about 0.4 s a sheet |
| Rescanned revision B (rotated, scaled, blurred, noisy, JPEG) | 396 of 432 edits found (91.7%), 2.7 false clouds a sheet |
| Phone photos of marked-up prints (60 photos, 160 pen marks) | 160 of 160 marks found, no false marks |

The scripts and the method are in [`bench/`](bench/). Anyone with the NIST drawings can run them again.

## Try it

On a change order with no drawings, the panel offers **Add a sample change order**. It attaches revisions C and D of a sample bracket drawing (from the NIST test set, edited by us), a photo of a marked-up print, and two change notes. Two of the changes on the sheet are deliberately not in the notes.

To build and deploy it yourself:

```bash
npm install
cd static/lighttable && npm install && npm run build && cd ../..
forge deploy
forge install
```

`npm run dev` in `static/lighttable` runs the light table in a plain browser against the bundled sample (`?view=table`, `?view=panel`, `?sample=multi` for a three-sheet set, `?readonly=1` to play a viewer).

## Permissions

| Scope | Why |
|---|---|
| `read:jira-work` | read the change order, its description and its PDF and photo attachments, as the person using Redline |
| `write:jira-work` | attach the sample, the print photo and markup work items; write the searchable copy of the verdict |
| `read:jira-user` | show who signed off and who saved the review |
| `storage:app` | keep each review where only Redline can change it |

Saving a review needs permission to edit the work item. People who can only view it see the review without the controls to change it.

## Layout

```
manifest.yml                    issue panel, workflow validator, entity property, Rovo agent and actions
src/index.js                    resolvers, release gate, Rovo actions
shared/gate.mjs                 the release verdict, shared by the browser and the validator
static/lighttable/src/          the panel and light table (React), pdf.js rendering, the engine
bench/                          benchmark generator and scorers
docs/                           release gate guide, cover
```

The sample drawings come from the NIST MBE PMI Validation and Conformance Testing project, which is in the public domain. Redline is not affiliated with NIST.
