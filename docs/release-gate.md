# Set up the release gate

Redline adds a workflow validator called **Redline drawing release gate**. Put it on the transition that releases a drawing, for example *Approved → Released*. When someone tries that transition, Jira refuses it and shows the reason in the transition dialog until all of these hold:

- the drawing's revisions have been compared in Redline (the last reviewed revision against the newest, in revision order; the first time, the oldest against the newest), every sheet of them;
- every change Redline found is declared in a numbered change note, or accepted as a correction;
- every declared change is signed off, and its note still reads as it did when it was signed (a rewritten or renumbered note needs signing again);
- every declared change's values agree with its note both ways, or someone has confirmed by name that the drawing is right;
- every numbered change note is carried out by a change on the drawing, or someone has said by name that it needs no drawing change;
- a review that found nothing, or that set line work aside as re-plot shifts, has been confirmed by name;
- the newest photo of a marked-up print has been read on the light table (or set aside as not a print), and every red-pen markup on it, and any still unanswered on an earlier photo that is still attached, is raised as a work item, covered by a change, or dismissed;
- any PDF attached after the reviewed revision that is not named as a revision of this drawing has been set aside by name (a real new revision should be named like the others, so Redline compares it);
- only one drawing's revisions are attached: two different drawings, each with revisions, belong on two change orders;
- when a further revision arrives (rev E after a review of C to D), every change that review sent back or left unanswered is carried into the next review (from the last reviewed revision to the newest, so two revisions attached at once are never skipped) and holds the release until someone says, by name, that the new revision fixes it.

## Add the validator (company-managed project)

1. Open the project, then **Project settings → Workflows**, and edit the workflow your change orders use.
2. Select the release transition.
3. Add a rule of the validator type and pick **Redline drawing release gate**. It has no settings.
4. Publish the workflow.

## Add the validator (team-managed project)

1. Open the project, then **Project settings → Work types**, pick the change-order type and select **Edit workflow**.
2. Select the release transition and add the rule **Redline drawing release gate**.
3. Save the workflow.

Try it on a test work item: attach two PDF revisions where the newer one has a change that the description does not mention, then try to release it. The transition dialog says, for example, *1 change on the drawing is not in the change notes*.

## What the validator trusts

Redline keeps each review in the app's own storage, which only Redline writes. When the transition runs, the validator:

- reads that review, never the issue property;
- checks that the review compared the last reviewed revision against the newest PDF revision on the work item, so a revision attached afterwards, or a reviewed revision deleted afterwards, blocks release again;
- works out the verdict again from the saved decisions;
- refuses the transition if Jira cannot tell it what is attached, rather than letting it through.

What goes into a review is guarded too:

- only someone who can edit the work item can save a review;
- the name on a sign-off is the account that signed, as Jira reports it, not text sent by the browser;
- for the same pair of revisions, a later save can add changes and compared sheets but cannot remove ones an earlier comparison found;
- every save is recorded with who, when, the verdict and which changes they signed.

The comparison itself runs in the reviewer's browser, so a reviewer who can edit the work item and is set on cheating could submit a false first comparison from the browser's developer tools. The audit trail is there to make that visible.

Redline also writes a copy of the verdict to an issue property so JQL can search it. That copy is only an index: the validator, the dashboard gadget and the Rovo agent recompute the verdict from app storage, so editing the property through the REST API changes nothing they report.

## Write the change notes so Redline can match them

Redline reads numbered lines in the work item description and links a change to a note when the note names the change's drawing zone:

```
1. Zone D2: bore Ø25 ±0.15 changes to Ø25.5 ±0.15 for the new bearing.
2. Sheet 2, zone A7: add note 7 "Apply thread locker to all M6 screws".
```

Zones follow the ASME drawing border: columns numbered from the right, rows lettered from the bottom. A note claims a change by itself only when that change is the only one in the named zone. If a zone holds two changes, or the change sits one zone over, Redline suggests the note and a person confirms it. That way an undeclared edit cannot hide behind a declared one beside it.

## Find blocked change orders

| JQL | Finds |
|---|---|
| `redlineGate = "blocked"` | change orders whose release is blocked |
| `redlineGate = "clear"` | change orders ready to release |
| `redlineUndeclared > 0` | change orders with changes that no note declares |

You can also ask the **Drawing change checker** agent in Rovo, for example *"Which change orders are blocked by undeclared drawing changes?"*

## Permissions

Redline reads the work item, its attachments and its description as the person using it, so nobody sees a drawing they could not open in Jira. People who can view a work item but not edit it can open the light table and see the review, but their decisions are not saved.

## When the drawings live in a PDM or PLM vault

Redline needs the released PDFs on the change order, named as revisions of one drawing (for example `BRKT-0142_rev-C.pdf` and `BRKT-0142_rev-D.pdf`; "Rev D", "rev-d" and "RevD1" read the same). Teams whose CAD lives in SolidWorks PDM, Autodesk Vault or a PLM usually already publish a PDF when a revision is released. Two ways to get it onto the change order without anyone downloading and re-uploading:

- **Email:** where the project accepts email (a Jira Service Management channel, or an incoming-mail handler if your site has one set up), the vault's release notification can mail the PDF with the change order's key in the subject so Jira adds it to that work item. Check this on your site first; the script below works everywhere.
- **A small publish script (works on any site):** the vault's release step calls Jira's REST attachments endpoint (`POST /rest/api/3/issue/{key}/attachments`) with the PDF and the change order's key. Jira Automation's built-in actions do not attach files, so a script or email is the dependable route.

Either way the update trigger notices the new revision, marks the change order "not compared yet" in search, and the gate holds the release until someone compares the revisions in the light table.
