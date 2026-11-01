# Attach a released drawing PDF to its change order, for a PDM or PLM release step to call.
# Usage: $env:JIRA_EMAIL='you@example.com'; $env:JIRA_API_TOKEN='...'; ./publish-revision.ps1 https://your-site.atlassian.net ENG-12 .\BRKT-0142_rev-E.pdf
# Name the file as a revision of the drawing (BRKT-0142_rev-E.pdf) so Redline compares it with the last reviewed one.
param([Parameter(Mandatory)][string]$Site, [Parameter(Mandatory)][string]$Key, [Parameter(Mandatory)][string]$File)
if (-not $env:JIRA_EMAIL -or -not $env:JIRA_API_TOKEN) { throw 'Set JIRA_EMAIL and JIRA_API_TOKEN first.' }
$auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($env:JIRA_EMAIL):$($env:JIRA_API_TOKEN)"))
$form = @{ file = Get-Item -LiteralPath $File }
Invoke-RestMethod -Method Post -Uri "$Site/rest/api/3/issue/$Key/attachments" -Headers @{ Authorization = "Basic $auth"; 'X-Atlassian-Token' = 'no-check' } -Form $form | Out-Null
Write-Output "Attached $File to $Key. Redline holds the release until the revisions are compared."
