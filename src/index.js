import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

// Redline keeps its review on the work item itself, as an issue property. The release-gate validator,
// JQL (through the indexed property) and the Rovo actions all read that one record.
const PROP = 'redline-review';

// ---------- reading a change order ----------

// Change notes are the numbered lines of the description: an ordered list, or paragraphs that start
// with "1." / "2)". Each becomes { n, text } so clouds can be declared against a line number.
export function notesFromAdf(doc) {
  const notes = [];
  const text = (node) => (node.type === 'text' ? node.text : (node.content || []).map(text).join(node.type === 'paragraph' ? '\n' : ''));
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'orderedList') {
      let n = node.attrs?.order || 1;
      for (const item of node.content || []) notes.push({ n: n++, text: text(item).trim() });
      return;
    }
    if (node.type === 'paragraph') {
      for (const line of text(node).split('\n')) {
        const m = line.match(/^\s*(\d{1,2})[.)]\s+(.+)/);
        if (m) notes.push({ n: +m[1], text: m[2].trim() });
      }
      return;
    }
    (node.content || []).forEach(walk);
  };
  walk(doc);
  return notes;
}

async function jira(path, init) {
  const res = await api.asUser().requestJira(path, init);
  if (!res.ok && res.status !== 404) throw new Error(`Jira answered ${res.status} for ${init?.method || 'GET'} request`);
  return res;
}

export async function loadChangeOrder(key) {
  const res = await jira(route`/rest/api/3/issue/${key}?fields=summary,status,description,attachment,project,issuetype`);
  if (res.status === 404) throw new Error(`Work item ${key} was not found or you cannot see it`);
  const issue = await res.json();
  const prop = await jira(route`/rest/api/3/issue/${key}/properties/${PROP}`);
  const review = prop.status === 404 ? null : (await prop.json()).value;
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
    project: issue.fields.project?.key,
    issuetype: issue.fields.issuetype?.id,
    images,
    summary: issue.fields.summary,
    status: issue.fields.status?.name,
    notes: notesFromAdf(issue.fields.description),
    attachments,
    review,
  };
}

// ---------- resolver for the panel and the light table ----------

const resolver = new Resolver();
const issueKey = (req) => req.context.extension.issue?.key || req.context.extension.modal?.issueKey;

resolver.define('getChangeOrder', async (req) => {
  const o = await loadChangeOrder(issueKey(req));
  const me = await (await jira(route`/rest/api/3/myself`)).json();
  return { ...o, user: { accountId: me.accountId, displayName: me.displayName } };
});

// The bridge cannot carry binary bodies, so the resolver fetches the PDF as the user (their
// permissions apply) and hands it over as base64. Drawings above ~3.5 MB need splitting (5 MB cap).
resolver.define('getAttachment', async (req) => {
  const res = await jira(route`/rest/api/3/attachment/content/${String(req.payload.id)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 3_600_000) throw new Error('This drawing is larger than 3.5 MB; Redline handles drawings up to 3.5 MB today');
  return { size: buf.length, data: buf.toString('base64') };
});

resolver.define('saveReview', async (req) => {
  const key = issueKey(req);
  const review = { ...req.payload.review, savedBy: req.context.accountId, savedAt: new Date().toISOString() };
  await jira(route`/rest/api/3/issue/${key}/properties/${PROP}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(review),
  });
  return { ok: true };
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

// ---------- Rovo actions ----------

function describe(o) {
  const r = o.review;
  const latest = o.attachments[o.attachments.length - 1];
  if (o.attachments.length < 2) return { key: o.key, state: 'no-revisions', message: 'Fewer than two PDF revisions are attached.' };
  if (!r) return { key: o.key, state: 'not-compared', message: `Revisions ${o.attachments.at(-2).filename} and ${latest.filename} have not been compared in Redline yet.` };
  const stale = r.revB?.id !== latest.id;
  return {
    key: o.key,
    state: stale ? 'stale' : r.gate?.status,
    gate: r.gate?.text,
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

export async function findBlockedChangeOrders(payload) {
  const project = payload.projectKey ? ` AND project = "${String(payload.projectKey).replace(/"/g, '')}"` : '';
  const jql = `redlineGate = "blocked"${project} ORDER BY updated DESC`;
  const res = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql, maxResults: 20, fields: ['summary', 'status'], properties: [PROP] }),
  });
  if (!res.ok) return { error: `Search failed (${res.status}).` };
  const data = await res.json();
  return {
    jql,
    changeOrders: (data.issues || []).map((i) => {
      const r = i.properties?.[PROP];
      return { key: i.key, summary: i.fields.summary, status: i.fields.status?.name, gate: r?.gate?.text };
    }),
  };
}
