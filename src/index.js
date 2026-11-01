import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { gateOf, verdictOf } from '../shared/gate.mjs';
import { notesFromAdf } from '../shared/notes.mjs';

export { verdictOf, notesFromAdf };

// The review of record lives in the app's own storage, which no user or REST call can edit; the backend
// recomputes the gate from the saved decisions and stamps every sign-off with the signer's account.
// A copy of the verdict is written to an issue property only so JQL can search it (`redlineGate`).
const PROP = 'redline-review';
const reviewKey = (issueId) => `review:${issueId}`;
const auditKey = (issueId) => `audit:${issueId}`;


// ---------- reading a change order ----------


async function jira(path, init) {
  const res = await api.asUser().requestJira(path, init);
  if (!res.ok && res.status !== 404) throw new Error(`Jira answered ${res.status} for ${init?.method || 'GET'} request`);
  return res;
}

export async function loadChangeOrder(key) {
  const res = await jira(route`/rest/api/3/issue/${key}?fields=summary,status,description,attachment,project,issuetype`);
  if (res.status === 404) throw new Error(`Work item ${key} was not found or you cannot see it`);
  const issue = await res.json();
  const review = (await kvs.get(reviewKey(issue.id))) || null;
  const attachments = (issue.fields.attachment || [])
    .filter((a) => a.mimeType === 'application/pdf')
    .sort((x, y) => x.created.localeCompare(y.created) || +x.id - +y.id)
    .map((a) => ({ id: +a.id, filename: a.filename, size: a.size, created: a.created, author: a.author?.displayName }));
  const images = (issue.fields.attachment || [])
    .filter((a) => /^image\/(jpeg|png|webp)$/.test(a.mimeType))
    .sort((x, y) => x.created.localeCompare(y.created))
    .map((a) => ({ id: +a.id, filename: a.filename, size: a.size, created: a.created, mimeType: a.mimeType, author: a.author?.displayName }));
  return {
    key: issue.key,
    id: issue.id,
    project: issue.fields.project?.key,
    issuetype: issue.fields.issuetype?.id,
    images,
    summary: issue.fields.summary,
    status: issue.fields.status?.name,
    notes: notesFromAdf(issue.fields.description),
    attachments,
    review,
    // the same verdict the release validator would give right now
    verdict: verdictOf(issue.fields.attachment, review, notesFromAdf(issue.fields.description)),
  };
}

// ---------- resolver for the panel and the light table ----------

const resolver = new Resolver();
const issueKey = (req) => req.context.extension.issue?.key || req.context.extension.modal?.issueKey;

resolver.define('getChangeOrder', async (req) => {
  const o = await loadChangeOrder(issueKey(req));
  const me = await (await jira(route`/rest/api/3/myself`)).json();
  const out = { ...o, user: { accountId: me.accountId, displayName: me.displayName }, canEdit: await canEdit(o.key) };
  const r = o.review;
  // the issue panel also shows who saved the review last and a small picture of each compared sheet
  if (req.payload?.withThumbs && r) {
    if (r.savedById) {
      const u = r.savedById === me.accountId ? me : await jira(route`/rest/api/3/user?accountId=${r.savedById}`).then((x) => x.json()).catch(() => null);
      out.savedBy = u?.displayName || null;
    }
    const done = (r.sheets?.done || [1]).slice(0, 6);
    const thumbs = await Promise.all(done.map((n) => kvs.get(thumbKey(o.id, n))));
    // a picture of an older revision B would put today's clouds on yesterday's drawing, so it is dropped
    out.thumbs = thumbs.map((t, i) => (t && t.revB === r.revB?.id ? { sheet: done[i], w: t.w, h: t.h, data: t.data } : null)).filter(Boolean);
  }
  return out;
});

// A small JPEG of revision B for one sheet, drawn by the light table after it compares that sheet.
const thumbKey = (issueId, sheet) => `thumb:${issueId}:${sheet}`;
resolver.define('saveThumb', async (req) => {
  const { revB, sheet, w, h, data } = req.payload || {};
  // KVS values are capped well under the bridge limit; a thumbnail is ~30 KB, so anything far bigger is refused
  if (typeof data !== 'string' || data.length > 180000 || !(sheet >= 1 && sheet <= 500)) return { ok: false };
  if (!(await canEdit(issueKey(req)))) return { ok: false };
  const issue = await (await jira(route`/rest/api/3/issue/${issueKey(req)}?fields=summary`)).json();
  if (!issue.id) return { ok: false };
  await kvs.set(thumbKey(issue.id, sheet), { revB, w, h, data });
  return { ok: true };
});

// The bridge cannot carry binary bodies, so the resolver fetches the PDF as the user (their permissions
// apply) and hands it over as base64, in slices that stay under Forge's 5 MB response cap.
const SLICE = 3_000_000, MAX = 40_000_000;
let lastFile = null; // { id, account, buf, at }: reused by the next slice while the function is warm
resolver.define('getAttachment', async (req) => {
  const id = String(req.payload.id), account = `${req.context.cloudId}:${req.context.accountId}`;
  let buf;
  if (lastFile && lastFile.id === id && lastFile.account === account && Date.now() - lastFile.at < 60000) buf = lastFile.buf;
  else {
    const res = await jira(route`/rest/api/3/attachment/content/${id}`);
    buf = Buffer.from(await res.arrayBuffer());
    lastFile = { id, account, buf, at: Date.now() };
  }
  if (buf.length > MAX) throw new Error(`This file is ${(buf.length / 1e6).toFixed(0)} MB; Redline reads drawings up to 40 MB`);
  const offset = req.payload.offset || 0;
  return { size: buf.length, offset, data: buf.subarray(offset, offset + SLICE).toString('base64') };
});

// Save a review. The browser sends what people decided; the backend checks nobody saved in between,
// recomputes the gate itself and records who signed each change.
// The review is kept in app storage, which the app writes with its own rights, so the user's right to
// edit the work item is checked first: someone who can only view it can read the review but not sign it.
async function canEdit(key) {
  const res = await jira(route`/rest/api/3/mypermissions?issueKey=${key}&permissions=EDIT_ISSUES`);
  if (!res.ok) return false;
  return !!(await res.json()).permissions?.EDIT_ISSUES?.havePermission;
}

resolver.define('saveReview', async (req) => {
  const key = issueKey(req);
  if (!(await canEdit(key))) return { readOnly: true };
  const issue = await (await jira(route`/rest/api/3/issue/${key}?fields=summary,description,attachment`)).json();
  const notes = notesFromAdf(issue.fields.description);
  const stored = await kvs.get(reviewKey(issue.id));
  const base = req.payload.baseVersion || 0;
  if (stored && (stored.version || 0) !== base) return { conflict: true, review: stored };
  const r = req.payload.review, now = new Date().toISOString();
  // a review is always of the two newest PDF revisions on the work item, named by id
  const pdfs = (issue.fields.attachment || []).filter((a) => a.mimeType === 'application/pdf')
    .sort((x, y) => x.created.localeCompare(y.created) || +x.id - +y.id);
  const [newA, newB] = pdfs.slice(-2);
  if (!newA || +r.revA?.id !== +newA.id || +r.revB?.id !== +newB.id) return { stale: true, error: 'This review is not of the two newest drawing revisions. Reopen the light table to compare them.' };
  const me = await (await jira(route`/rest/api/3/myself`)).json();
  const signed = [];
  for (const [id, d] of Object.entries(r.decisions || {})) {
    const before = stored?.decisions?.[id];
    // a signature stands only while the decision it signed (status and note) is unchanged
    const same = before && before.status === d.status && (before.note ?? null) === (d.note ?? null);
    if (d.signedAt && same && before.signedById) { d.signedAt = before.signedAt; d.signedById = before.signedById; d.signedBy = before.signedBy; }
    // the signer is whoever is calling, named by Jira, never a name the browser sent
    else if (d.signedAt) { d.signedById = me.accountId; d.signedBy = me.displayName; d.signedAt = now; signed.push(id); }
    if (!d.signedAt) { delete d.signedById; delete d.signedBy; }
    // "the drawing is right" on a value slip is a decision too: named by Jira, kept as first recorded
    if (d.valueOk) d.valueOk = (same && before?.valueOk) || { by: me.displayName, byId: me.accountId, at: now };
  }
  // For the same pair of revisions, a save can add changes and compared sheets but never drop ones that
  // an earlier comparison found, and what was found about a change (its box, text and values) stays as
  // first recorded, so a review cannot be emptied or softened after the fact.
  if (stored && +stored.revA?.id === +r.revA.id && +stored.revB?.id === +r.revB.id) {
    const was = new Map((stored.clouds || []).map((c) => [c.id, c]));
    const ids = new Set((r.clouds || []).map((c) => c.id));
    r.clouds = [...(r.clouds || []).map((c) => (was.has(c.id) ? { ...c, ...was.get(c.id) } : c)), ...(stored.clouds || []).filter((c) => !ids.has(c.id))];
    const done = new Set([...(r.sheets?.done || []), ...(stored.sheets?.done || [])]);
    r.sheets = { count: Math.max(r.sheets?.count || 1, stored.sheets?.count || 1), done: [...done].sort((x, y) => x - y) };
    const mids = new Set((r.marks || []).map((m) => m.id));
    r.marks = [...(r.marks || []), ...(stored.marks || []).filter((m) => !mids.has(m.id))];
  }
  const gate = gateOf(r.clouds || [], r.decisions || {}, r.marks || [], r.markDecisions || {}, r.sheets, notes);
  const review = { ...r, gate, version: (stored?.version || 0) + 1, savedById: req.context.accountId, savedAt: now };
  await kvs.set(reviewKey(issue.id), review);
  // every save is recorded: who, when, the verdict and which changes they signed (last 200 kept)
  const audit = (await kvs.get(auditKey(issue.id))) || [];
  audit.push({ at: now, by: me.accountId, name: me.displayName, version: review.version, status: gate.status, clouds: r.clouds?.length || 0, signed });
  await kvs.set(auditKey(issue.id), audit.slice(-200));
  // searchable copy for JQL only; the validator, the gadget and Rovo recompute from app storage
  await api.asApp().requestJira(route`/rest/api/3/issue/${key}/properties/${PROP}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gate: { status: gate.status, text: gate.text, open: gate.open }, revB: r.revB, version: review.version }),
  });
  return { ok: true, version: review.version, gate, decisions: review.decisions };
});

async function attach(key, name, mime, base64) {
  // multipart/form-data built by hand: one part named "file", CRLF line endings as the format requires
  const boundary = '----redline' + Math.random().toString(16).slice(2);
  const CRLF = String.fromCharCode(13, 10);
  const head = Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${name.replace(/"/g, '')}"${CRLF}Content-Type: ${mime}${CRLF}${CRLF}`);
  const body = Buffer.concat([head, Buffer.from(base64, 'base64'), Buffer.from(`${CRLF}--${boundary}--${CRLF}`)]);
  const res = await jira(route`/rest/api/3/issue/${key}/attachments`, {
    method: 'POST', headers: { 'X-Atlassian-Token': 'no-check', 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body,
  });
  return (await res.json())[0];
}

// A photo of a marked-up print, taken in the light table, is kept on the work item like any attachment.
resolver.define('uploadPhoto', async (req) => {
  const a = await attach(issueKey(req), req.payload.name, 'image/jpeg', req.payload.data);
  return { id: +a.id, filename: a.filename, mimeType: a.mimeType, created: a.created };
});

// Turn one pen markup into its own work item, linked to the change order, with the marked-up crop attached,
// so a question from the shop floor gets an owner instead of staying on paper.
resolver.define('raiseMarkup', async (req) => {
  const eco = issueKey(req), { zone, summary, project, issuetype, crop, photo } = req.payload;
  const text = `A marked-up print of ${summary} has a pen markup in zone ${zone}. Photo: ${photo}. Raised from Redline on ${eco}.`;
  const created = await (await jira(route`/rest/api/3/issue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { project: { key: project }, issuetype: { id: issuetype }, summary: `Drawing markup in zone ${zone}: ${summary}`.slice(0, 250),
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } } }),
  })).json();
  if (!created.key) throw new Error('Jira did not create the markup work item');
  await jira(route`/rest/api/3/issueLink`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: { name: 'Relates' }, inwardIssue: { key: created.key }, outwardIssue: { key: eco } }),
  });
  if (crop) await attach(created.key, `markup-zone-${zone}.jpg`, 'image/jpeg', crop);
  return { key: created.key };
});

// A judge or new user on an empty site can add the bundled sample change order (two public-domain
// NIST drawing revisions and two numbered change notes) to the work item they are looking at.
resolver.define('addSample', async (req) => {
  const key = issueKey(req);
  for (const f of req.payload.files) await attach(key, f.name, f.mime || 'application/pdf', f.data);
  const issue = await (await jira(route`/rest/api/3/issue/${key}?fields=description`)).json();
  if (!notesFromAdf(issue.fields.description).length) {
    const doc = issue.fields.description || { type: 'doc', version: 1, content: [] };
    const item = (t) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
    doc.content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Change notes' }] },
      { type: 'orderedList', attrs: { order: 1 }, content: req.payload.notes.map(item) });
    await jira(route`/rest/api/3/issue/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { description: doc } }) });
  }
  return { ok: true };
});

export const handler = resolver.getDefinitions();

// ---------- release gate (workflow validator) ----------

// Runs inside the transition. It reads the review from app storage (not the editable issue property),
// recomputes the verdict, and checks that the review covers the newest PDF revision on the work item.
export async function releaseGate(event) {
  const key = event.issue?.key, id = event.issue?.id;
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${key || id}?fields=attachment,description`);
  // fail closed: if Jira cannot tell us what is attached, the release waits
  if (!res.ok) return { result: false, errorMessage: `Redline could not read this work item's drawings (Jira answered ${res.status}). Try the transition again.` };
  const issue = await res.json();
  const v = verdictOf(issue.fields?.attachment, await kvs.get(reviewKey(issue.id)), notesFromAdf(issue.fields?.description));
  return v.blocked ? { result: false, errorMessage: `Redline: ${v.text}. Open the light table on this work item to resolve it before release.` } : { result: true };
}

// ---------- Rovo actions ----------

function describe(o) {
  const r = o.review;
  const latest = o.attachments[o.attachments.length - 1];
  if (o.attachments.length < 2) return { key: o.key, state: 'no-revisions', message: 'Fewer than two PDF revisions are attached.' };
  if (!r) return { key: o.key, state: 'not-compared', message: `Revisions ${o.attachments.at(-2).filename} and ${latest.filename} have not been compared in Redline yet.` };
  const stale = r.revB?.id !== latest.id;
  return {
    key: o.key,
    state: o.verdict ? (o.verdict.blocked ? 'blocked' : 'clear') : stale ? 'stale' : r.gate?.status,
    gate: o.verdict?.text || r.gate?.text,
    compared: `${r.revA?.filename} to ${r.revB?.filename}`,
    staleReason: stale ? `${latest.filename} was attached after the last review` : undefined,
    notes: o.notes,
    changes: (r.clouds || []).map((c) => {
      const d = r.decisions?.[c.id] || {};
      return {
        change: c.n, zone: c.zone, kind: c.kind,
        status: d.status === 'declared' ? `declared in note ${d.note}` : d.status === 'accepted' ? 'accepted as a drawing correction' : d.status === 'rejected' ? 'sent back to the drafter' : 'not in the change notes',
        signedOffBy: d.signedBy || null,
      };
    }),
  };
}

export async function getDrawingReview(payload) {
  const key = String(payload.issueKey || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) return { error: 'Give a work item key such as ENG-1.' };
  return describe(await loadChangeOrder(key));
}

// Change orders Redline has reviewed, each with its verdict recomputed from app storage. The issue
// property only narrows the search; a hand-edited property cannot make a held change order look clear.
async function reviewedChangeOrders(projectKey) {
  // every review Redline has stored, found by key in app storage (deleting or editing the issue property
  // cannot hide a change order from this list)
  const ids = [];
  for (let cursor; ;) {
    let q = kvs.query().where('key', WhereConditions.beginsWith('review:')).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    ids.push(...page.results.map((x) => x.key.slice('review:'.length)));
    if (!page.nextCursor || ids.length >= 500) break;
    cursor = page.nextCursor;
  }
  if (!ids.length) return { items: [] };
  const project = projectKey ? ` AND project = "${String(projectKey).replace(/"/g, '')}"` : '';
  const items = [];
  for (let k = 0; k < ids.length; k += 100) {
    const jql = `id in (${ids.slice(k, k + 100).join(',')})${project} ORDER BY updated DESC`;
    const res = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql, maxResults: 100, fields: ['summary', 'status', 'attachment', 'description'] }),
    });
    if (!res.ok) return { error: `Search failed (${res.status}).` };
    const issues = (await res.json()).issues || [];
    const reviews = await Promise.all(issues.map((i) => kvs.get(reviewKey(i.id))));
    issues.forEach((i, n) => {
      const v = verdictOf(i.fields.attachment, reviews[n], notesFromAdf(i.fields.description));
      items.push({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name, blocked: !!v.blocked, gate: v.text, since: reviews[n]?.savedAt });
    });
  }
  return { items };
}

// The dashboard gadget: change orders held by Redline with the reason, and how many are ready to release.
resolver.define('gadget', async () => {
  const r = await reviewedChangeOrders();
  if (r.error) return r;
  const held = r.items.filter((x) => x.blocked);
  return { changeOrders: held.slice(0, 20), blocked: held.length, clear: r.items.length - held.length };
});

export async function findBlockedChangeOrders(payload) {
  const r = await reviewedChangeOrders(payload?.projectKey);
  if (r.error) return r;
  return { changeOrders: r.items.filter((x) => x.blocked).slice(0, 20).map(({ blocked, ...x }) => x) };
}
