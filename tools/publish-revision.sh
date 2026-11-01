#!/usr/bin/env sh
# Attach a released drawing PDF to its change order, for a PDM or PLM release step to call.
# Usage: JIRA_EMAIL=you@example.com JIRA_API_TOKEN=... ./publish-revision.sh https://your-site.atlassian.net ENG-12 BRKT-0142_rev-E.pdf
# Name the file as a revision of the drawing (BRKT-0142_rev-E.pdf) so Redline compares it with the last reviewed one.
set -eu
site="$1"; key="$2"; file="$3"
: "${JIRA_EMAIL:?set JIRA_EMAIL}"; : "${JIRA_API_TOKEN:?set JIRA_API_TOKEN}"
curl --fail --silent --show-error -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -H "X-Atlassian-Token: no-check" \
  -F "file=@$file;type=application/pdf" "$site/rest/api/3/issue/$key/attachments" > /dev/null
echo "Attached $file to $key. Redline holds the release until the revisions are compared."
