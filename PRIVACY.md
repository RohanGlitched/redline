# Redline privacy policy

Last updated: November 2, 2026

Redline is an Atlassian Forge app. It runs on Atlassian's own infrastructure ("Runs on Atlassian"). It has no backend of its own, makes no calls outside Atlassian, and uses no AI service, analytics or tracking.

## What Redline reads

When someone opens Redline on a work item, it reads that work item's summary, description, status and attachments. It reads them as that person, through Jira's REST API, so it sees only what that person can see.

Drawing PDFs and photos are compared in that person's browser. They are never sent anywhere outside Atlassian.

## What Redline stores

Redline keeps its records in Forge app storage. That storage belongs to your Jira site and is kept in Atlassian's cloud. Only Redline can read it. The records are:

- **The review of each change order:**
  - the changes found, with their zone and position;
  - the decision on each change, and who signed it off (Jira account ID and display name), with the time;
  - the pen markups read from a photo, and who answered each one;
  - which PDFs the review covered.
- **An audit log for each work item:** who saved the review, when, and what they signed. It keeps the most recent 200 entries.
- **A small summary of each change order's release verdict,** used by the dashboard gadget and the Rovo agent.
- **Which change notes were written from Redline, and by whom.**
- **Small thumbnails of each compared sheet,** for the issue panel.

Redline also writes one entity property, `redline-review`, on the work item: a copy of the verdict for JQL search. It also adds attachments and work items only when someone asks it to: the sample change order, a photo taken in the light table, a pen markup raised as a work item, or a change note added to the description.

## What Redline does not do

- It sends no data outside Atlassian.
- It uses no cookies, analytics or third-party services.
- It does not sell or share data.

## Retention and deletion

When a work item is deleted, Redline deletes everything it stored about it. That covers the review, the audit log, the verdict summary, the note authors and the thumbnails.

When Redline is uninstalled, Forge removes all of its app storage.

Attachments, work items and description text that Redline added at someone's request are ordinary Jira content. They stay until someone removes them in Jira.

## Contact

Questions or requests: open an issue at https://github.com/RohanGlitched/redline/issues.
