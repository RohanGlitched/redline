# Set up the release gate

Redline adds a workflow validator called **Redline drawing release gate**. Put it on the transition that releases a drawing, for example *Approved → Released*. When someone tries that transition, Jira refuses it and shows the reason in the transition dialog until all of these hold:

- the newest two PDF revisions on the work item have been compared in Redline, every sheet of them;
- every change Redline found is declared in a numbered change note, or accepted as a correction;
- every declared change is signed off;
- every red-pen markup on a photographed print is raised as a work item, covered by a change, or dismissed.

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

The validator does not read anything a person can edit. Redline keeps each review in the app's own storage. When the transition runs, the validator does three things:

- reads that review;
- checks that it covers the newest PDF on the work item, so a new revision attached after the review blocks release again;
- works out the verdict again from the saved decisions.

Redline also writes a copy of the verdict to an issue property so JQL can search it, but the validator never reads that copy. Editing it through the REST API does not open the gate.

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
