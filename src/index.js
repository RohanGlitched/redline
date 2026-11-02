import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { gateOf, verdictOf, valueSlip, noteSlip, noteKey, drawingPdfs, pairOf, revLabel, unplacedPdfs } from '../shared/gate.mjs';
import { notesFromAdf } from '../shared/notes.mjs';
import { ENGINE_VERSION, matchChanges, overlap, sameReview, settleSignatures, carriedChanges, notesDoneBefore, uniqueMarks, keepEarlierMarks } from '../shared/review.mjs';
import { meaningOf } from '../static/lighttable/src/engine/meaning.mjs';

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
  if (!res.ok && res.status !== 404) {
    // Jira's own reason (a required field, a missing permission) is the useful part of the message
    let why = '';
    try { const b = await res.json(); why = [...(b.errorMessages || []), ...Object.values(b.errors || {})].join(' '); } catch { /* not JSON */ }
    throw new Error(`Jira answered ${res.status}${why ? `: ${why.slice(0, 200)}` : ''}`);
  }
  return res;
}

export async function loadChangeOrder(key) {
  const res = await jira(route`/rest/api/3/issue/${key}?fields=summary,status,description,attachment,project,issuetype`);
  if (res.status === 404) throw new Error(`Work item ${key} was not found or you cannot see it`);
  const issue = await res.json();
  const review = (await kvs.get(reviewKey(issue.id))) || null;
  const pick = drawingPdfs(issue.fields.attachment);
  const attachments = pick.pdfs.map((a) => ({ id: +a.id, filename: a.filename, size: a.size, created: a.created, author: a.author?.displayName, authorId: a.author?.accountId }));
  const images = (issue.fields.attachment || [])
    .filter((a) => /^image\/(jpeg|png|webp|heic|heif)$/.test(a.mimeType))
    .sort((x, y) => Date.parse(x.created) - Date.parse(y.created) || +x.id - +y.id)
    .map((a) => ({ id: +a.id, filename: a.filename, size: a.size, created: a.created, mimeType: a.mimeType, author: a.author?.displayName }));
  return {
    key: issue.key,
    id: issue.id,
    project: issue.fields.project?.key,
    projectId: issue.fields.project?.id,
    issuetype: issue.fields.issuetype?.id,
    images,
    summary: issue.fields.summary,
    status: issue.fields.status?.name,
    notes: notesFromAdf(issue.fields.description),
    attachments,
    pair: pairOf(pick.pdfs, review).map((a) => +a.id),
    drawingConflict: pick.conflict || 0,
    // PDFs that are not this drawing's revisions (an ECO form, a test report): each can be set aside by name
    pdfIds: (issue.fields.attachment || []).filter((a) => a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename || '')).map((a) => +a.id),
    otherPdfs: review ? unplacedPdfs(issue.fields.attachment, review).map((a) => ({ id: +a.id, filename: a.filename, created: a.created, why: a.why })) : [],
    notesWritten: (await kvs.get(`written:${issue.id}`).catch(() => null)) || [],
    review,
    // the same verdict the release validator would give right now
    verdict: verdictOf(issue.fields.attachment, review, notesFromAdf(issue.fields.description)),
  };
}

// an audit log keeps its newest 200 entries, and fewer if they would not fit in one storage value (240 KiB)
function fitAudit(audit) {
  let a = audit.slice(-200);
  while (a.length > 1 && Buffer.byteLength(JSON.stringify(a)) > 200000) a = a.slice(Math.ceil(a.length / 10));
  return a;
}

// A small, app-only record of each change order's verdict (gate:<issueId>), written whenever the review is saved or the
// work item's drawings, photos or notes change. The gadget and the Rovo search read these instead of every full review.
async function indexGate(issueId, review, v) {
  try { await kvs.set(`gate:${issueId}`, { blocked: !!v.blocked, text: v.text || null, reasons: (v.reasons || []).map((x) => ({ kind: x.kind, short: x.short })), since: review?.heldSince || review?.savedAt || null }); }
  catch (e) { await kvs.delete('gate-index:v1').catch(() => {}); } // a lost write: the next gadget view indexes every review again
}

// ---------- resolver for the panel and the light table ----------

const resolver = new Resolver();
const issueKey = (req) => req.context.extension.issue?.key || req.context.extension.modal?.issueKey;

resolver.define('getChangeOrder', async (req) => {
  const o = await loadChangeOrder(issueKey(req));
  const me = await (await jira(route`/rest/api/3/myself`)).json();
  const out = { ...o, user: { accountId: me.accountId, displayName: me.displayName }, canEdit: await canEdit(o.key) };
  // who may sign off here, and whether this person may change that (project administrators)
  const newest = o.attachments.find((a) => a.id === o.pair[1]);
  const may = await signCheck(o.projectId, me, { author: { accountId: newest?.authorId } });
  out.signRule = may.rule; out.canSign = may.ok; out.cannotSignWhy = may.why || null;
  out.canAdmin = await isProjectAdmin(o.project);
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
    // the size first, so a huge attachment is refused before it is downloaded
    const meta = await jira(route`/rest/api/3/attachment/${id}`);
    if (meta.status === 404) throw new Error('This attachment was removed or you cannot see it');
    const size = (await meta.json()).size || 0;
    if (size > MAX) throw new Error(`This file is ${(size / 1e6).toFixed(0)} MB; Redline reads drawings up to 40 MB`);
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
// Who may sign off a project's change orders: anyone who can edit the work item, unless a project administrator has
// limited it to a Jira group, kept the person who attached a revision from signing off its changes, or both.
const signRuleKey = (projectId) => `signers:${projectId}`;
export async function signCheck(projectId, me, newestPdf) {
  const rule = projectId ? await kvs.get(signRuleKey(projectId)).catch(() => null) : null;
  if (!rule || (!rule.group && !rule.notUploader)) return { ok: true, rule: null };
  if (rule.group) {
    const u = await (await jira(route`/rest/api/3/myself?expand=groups`)).json();
    if (!(u.groups?.items || []).some((g) => g.name === rule.group)) return { ok: false, rule, why: `Only members of ${rule.group} can sign off this project's change orders.` };
  }
  if (rule.notUploader && newestPdf?.author?.accountId && newestPdf.author.accountId === me.accountId) return { ok: false, rule, why: 'You attached this revision, so someone else signs off its changes.' };
  return { ok: true, rule };
}

async function isProjectAdmin(projectKey) {
  if (!projectKey) return false;
  // a project administrator, or a Jira administrator (who administers every project)
  const res = await jira(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=ADMINISTER_PROJECTS,ADMINISTER`);
  const p = (await res.json().catch(() => null))?.permissions || {};
  return !!(p.ADMINISTER_PROJECTS?.havePermission || p.ADMINISTER?.havePermission);
}

resolver.define('setSignRule', async (req) => {
  const ires = await jira(route`/rest/api/3/issue/${issueKey(req)}?fields=project`);
  if (!ires.ok) return { ok: false, error: 'This work item was not found or you cannot see it.' };
  const project = (await ires.json()).fields?.project;
  if (!(await isProjectAdmin(project?.key))) return { ok: false, error: 'Only a project administrator can change who signs off.' };
  const group = String(req.payload?.group || '').trim().slice(0, 255) || null;
  if (group) {
    const g = await (await jira(route`/rest/api/3/group/bulk?groupName=${group}`)).json().catch(() => null);
    if (!g?.values?.some((x) => x.name === group)) return { ok: false, error: `There is no Jira group called "${group}".` };
  }
  const me = await (await jira(route`/rest/api/3/myself`)).json();
  const rule = { group, notUploader: !!req.payload?.notUploader, by: me.displayName, byId: me.accountId, at: new Date().toISOString() };
  await kvs.set(signRuleKey(project.id), rule);
  return { ok: true, rule };
});

async function canEdit(key) {
  const res = await jira(route`/rest/api/3/mypermissions?issueKey=${key}&permissions=EDIT_ISSUES`);
  if (!res.ok) return false;
  return !!(await res.json()).permissions?.EDIT_ISSUES?.havePermission;
}

resolver.define('saveReview', async (req) => {
  const key = issueKey(req);
  if (!(await canEdit(key))) return { readOnly: true };
  const ires = await jira(route`/rest/api/3/issue/${key}?fields=summary,description,attachment,project`);
  if (ires.status === 404) return { stale: true, error: `${key} was not found or you cannot see it any more.` };
  const issue = await ires.json();
  const notes = notesFromAdf(issue.fields.description);
  const stored = await kvs.get(reviewKey(issue.id));
  const base = req.payload.baseVersion || 0;
  if (stored && (stored.version || 0) !== base) return { conflict: true, review: stored };
  const r = req.payload.review, now = new Date().toISOString();
  // a review is always of the pair the gate expects (the last reviewed revision against the newest), named by id
  const { pdfs } = drawingPdfs(issue.fields.attachment);
  const [newA, newB] = pairOf(pdfs, stored);
  if (!newA || !newB || +r.revA?.id !== +newA.id || +r.revB?.id !== +newB.id) return { stale: true, error: 'A newer drawing revision has arrived since this light table opened. Reopen it to compare the revisions Redline now expects.' };
  if (r.engine !== ENGINE_VERSION) return { stale: true, error: 'This light table is out of date. Close it and open it again to load the current version of Redline.' };
  // A re-read is a review from this exact engine version replacing one from an older version: its changes
  // are found afresh, and each earlier decision belongs to the new change in the same place on the sheet.
  const sameRevs = stored && +stored.revA?.id === +r.revA.id && +stored.revB?.id === +r.revB.id;
  const reread = !!(sameRevs && stored.engine && stored.engine !== ENGINE_VERSION && r.engine === ENGINE_VERSION);
  const carried = reread ? matchChanges(stored.clouds, r.clouds) : {};
  const storedCloud = new Map((stored?.clouds || []).map((c) => [c.id, c])), newCloud = new Map((r.clouds || []).map((c) => [c.id, c]));
  const readsSame = (a, b) => !!a && !!b && a.kind === b.kind && (a.before ?? null) === (b.before ?? null) && (a.after ?? null) === (b.after ?? null) && JSON.stringify(a.values || []) === JSON.stringify(b.values || []);
  // after a re-read, a decision (and its signature) follows its change only if the change still reads the same
  const beforeOf = (id) => (!sameRevs ? undefined : reread ? (readsSame(storedCloud.get(carried[id]), newCloud.get(id)) ? stored.decisions?.[carried[id]] : (id === '__ack' ? stored.decisions?.[id] : undefined)) : stored?.decisions?.[id]);
  // the light table can save before it has read the photo again: the stored photo and its markups stand
  const stillAttached = (id) => (issue.fields.attachment || []).some((a) => +a.id === +id);
  if (sameRevs && !r.print && stored.print && stillAttached(stored.print.id)) { r.print = stored.print; r.marks = stored.marks || []; r.markDecisions = { ...(stored.markDecisions || {}), ...(r.markDecisions || {}) }; }
  // nothing changed since the last save (the light table saves once when it opens): no write, no audit entry
  if (sameRevs && !reread && !(req.payload.signed || []).length && !(req.payload.confirmed || []).length && sameReview(stored, r)
    && !Object.values(stored.markDecisions || {}).some((d) => d?.unchecked)) return { ok: true, unchanged: true, version: stored.version, gate: verdictOf(issue.fields.attachment, stored, notes), decisions: stored.decisions };
  const me = await (await jira(route`/rest/api/3/myself`)).json();
  const signed = [];
  // Signatures are never taken from the browser's copy of a decision (shared/review.mjs settleSignatures)
  const asideTotal = (r.setAside || []).length + (sameRevs && !reread ? (stored.setAside || []).filter((a) => !(r.setAside || []).some((b) => b.id === a.id)).length : 0);
  const staleNotes = [];
  // a project can limit who signs off; a refused signer's save still records every other answer
  const may = await signCheck(issue.fields.project?.id, me, newB);
  const asked = (req.payload.signed || []).length + (req.payload.confirmed || []).length;
  signed.push(...settleSignatures(r.decisions || {}, { beforeOf, notes, signed: may.ok ? req.payload.signed : [], confirmed: may.ok ? req.payload.confirmed : [], shown: req.payload.shown || {}, me, now, asideTotal, stale: staleNotes }));
  // For the same pair of revisions, a save can add changes and compared sheets but never drop ones that
  // an earlier comparison found, and what was found about a change (its box, text and values) stays as
  // first recorded, so a review cannot be emptied or softened after the fact.
  // A re-read (above) replaces the old changes with the ones the current engine found, and the audit log says so.
  // what the previous pair of revisions left open comes along, whatever the browser sent
  // pen markups: one id each, and on a new pair every earlier markup kept by place with its answer (shared/review.mjs)
  Object.assign(r, uniqueMarks(r.marks, r.markDecisions));
  if (!sameRevs && stored) {
    Object.assign(r, keepEarlierMarks(stored, r.marks, r.markDecisions, stillAttached));
    const ids = new Set((r.clouds || []).map((c) => c.id));
    r.clouds = [...(r.clouds || []), ...carriedChanges(stored, r.revA, notes).filter((c) => !ids.has(c.id))];
    // notes done before count only when this pair continues the last one (a deleted revision undoes them)
    r.notesDone = +stored.revB?.id === +r.revA?.id ? notesDoneBefore(stored, r.revA, notes) : [];
  } else if (sameRevs) r.notesDone = stored.notesDone || [];
  else r.notesDone = [];
  if (reread) {
    const ids = new Set((r.clouds || []).map((c) => c.id));
    r.clouds = [...(r.clouds || []), ...(stored.clouds || []).filter((c) => c.carried && !ids.has(c.id))];
    r.notesDone = stored.notesDone || [];
  }
  if (sameRevs && !reread) {
    const was = new Map((stored.clouds || []).map((c) => [c.id, c]));
    const ids = new Set((r.clouds || []).map((c) => c.id));
    r.clouds = [...(r.clouds || []).map((c) => (was.has(c.id) ? { ...c, ...was.get(c.id) } : c)), ...(stored.clouds || []).filter((c) => !ids.has(c.id))];
    const asideIds = new Set((r.setAside || []).map((a) => a.id));
    r.setAside = [...(r.setAside || []), ...(stored.setAside || []).filter((a) => !asideIds.has(a.id))];
    const done = new Set([...(r.sheets?.done || []), ...(stored.sheets?.done || [])]);
    r.sheets = { count: Math.max(r.sheets?.count || 1, stored.sheets?.count || 1), done: [...done].sort((x, y) => x - y) };
    // pen markups found earlier stay: those of the same photo, and those of an earlier photo nobody answered
    // (a newer photo never wipes a machinist's open question); answered ones of an earlier photo are history
    // each kept by place, never by its number in a read (a re-read can number them differently): the current photo's
    // markups, and earlier photos' unanswered ones while they are attached
    const answered = (m) => ['raised', 'covered', 'dismissed'].includes(stored.markDecisions?.[m.id]?.status);
    const photoOf = (m) => +(/^p(\d+)-/.exec(m.id)?.[1] || stored.print?.id);
    const kept = (stored.marks || []).filter((m) => photoOf(m) === +r.print?.id || !answered(m));
    Object.assign(r, keepEarlierMarks({ ...stored, marks: kept }, r.marks, r.markDecisions, stillAttached));
  }
  // a markup newly answered as raised names a work item this person can see, or it is not raised: one bulk lookup;
  // only a malformed key or one Jira does not find is refused (a busy or failing Jira never undoes a real answer)
  r.markDecisions = Object.fromEntries(Object.entries(r.markDecisions || {}).filter(([, m]) => m && typeof m === 'object'));
  // (an answer whose lookup could not be made is checked again on the next save, never trusted for good)
  for (const m of Object.values(r.markDecisions)) if (m.status === 'raised' && typeof m.key === 'string') m.key = m.key.trim().toUpperCase();
  const newlyRaised = Object.entries(r.markDecisions).filter(([id, m]) => m.status === 'raised' && (m.unchecked || !(stored?.markDecisions?.[id]?.status === 'raised' && !stored.markDecisions[id].unchecked && stored.markDecisions[id].key === m.key)));
  const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
  for (const [id, m] of newlyRaised) if (!KEY.test(String(m.key || ''))) r.markDecisions[id] = { status: 'open' };
  const toLook = [...new Set(newlyRaised.map(([, m]) => m.key).filter((k) => KEY.test(String(k || ''))))];
  const missing = new Set(), unchecked = new Set();
  for (let k = 0; k < toLook.length; k += 100) {
    const batch = toLook.slice(k, k + 100);
    const body = await jira(route`/rest/api/3/issue/bulkfetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueIdsOrKeys: batch, fields: ['summary'] }) })
      .then((x) => x.json()).catch(() => null);
    if (!body) { batch.forEach((x) => unchecked.add(x)); continue; }
    // Jira leaves out keys it does not find (issueErrors lists only errors worth retrying): each key left out is asked
    // for on its own, so a work item moved since (it answers under its new key) still counts, a 404 is refused, and
    // anything else is checked again on the next save
    const found = new Set((body.issues || []).map((x) => x.key));
    const retry = (body.issueErrors || []).length > 0;
    for (const x of batch.filter((x) => !found.has(x))) {
      if (retry) { unchecked.add(x); continue; }
      const one = await jira(route`/rest/api/3/issue/${x}?fields=summary`).then((res) => res.status).catch(() => 0);
      if (one === 404) missing.add(x); else if (!one) unchecked.add(x);
    }
  }
  for (const [id, m] of newlyRaised) {
    if (missing.has(m.key)) r.markDecisions[id] = { status: 'open' };
    else if (unchecked.has(m.key)) r.markDecisions[id] = { ...m, unchecked: true };
    else if (r.markDecisions[id]?.unchecked) { const { unchecked: _, ...rest } = r.markDecisions[id]; r.markDecisions[id] = rest; }
  }
  const gate = gateOf(r.clouds || [], r.decisions || {}, r.marks || [], r.markDecisions || {}, r.sheets, notes, { setAside: (r.setAside || []).length, notesDone: r.notesDone });
  // who answered each pen markup, and who set a photo aside, as Jira names them
  for (const [id, m] of Object.entries(r.markDecisions || {})) {
    if (m.status === 'raising') m.status = 'open';
    // an answer carried from an earlier markup (a re-read numbers them differently) keeps the name of whoever gave it
    const here = (r.marks || []).find((x) => x.id === id);
    const samePlace = (x) => here?.box && x.box && /^p(\d+)-/.exec(x.id)?.[1] === /^p(\d+)-/.exec(id)?.[1] && overlap(x.box, here.box) >= 0.3;
    const carried = (stored?.marks || []).filter(samePlace).map((x) => stored.markDecisions?.[x.id]).find((d) => d && d.byId && d.status === m.status && d.byId === m.byId && d.at === m.at);
    // (by id only when the stored markup with that id is in the same place: a renumbered read never inherits a name)
    const was = carried || ((stored?.marks || []).some((x) => x.id === id && samePlace(x)) ? stored?.markDecisions?.[id] : null);
    // the whole answer is kept with its author (a raised markup keeps the work item that author raised)
    if (m.status && m.status !== 'open' && was?.status === m.status && (was.key ?? null) === (m.key ?? null)) { m.by = was.by; m.byId = was.byId; m.at = was.at; }
    else if (m.status && m.status !== 'open') { m.by = me.displayName; m.byId = me.accountId; m.at = now; }
  }
  if (r.print?.setAside) r.print = +stored?.print?.id === +r.print.id && stored.print.setAside ? stored.print : { ...r.print, by: me.displayName, byId: me.accountId, at: now };
  // "held since": when this review's gate last went from clear (or new) to blocked
  const heldSince = gate.blocked ? (stored?.gate?.status === 'blocked' && stored.heldSince ? stored.heldSince : now) : null;
  // the PDFs this review has seen: for the same pair, what was seen before; for a new pair, the PDFs the light table was
  // shown when it opened. A PDF attached later is never seen by a save: it holds until set aside by name.
  const attachedPdfs = new Set((issue.fields.attachment || []).filter((a) => a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename || '')).map((a) => +a.id));
  const revBAt = Date.parse((issue.fields.attachment || []).find((a) => +a.id === +r.revB.id)?.created || 0);
  const shownPdfs = (sameRevs && stored.pdfsSeen ? stored.pdfsSeen : (Array.isArray(req.payload.pdfsShown) ? req.payload.pdfsShown : null)
    || (issue.fields.attachment || []).filter((a) => Date.parse(a.created) <= revBAt).map((a) => a.id)).map(Number);
  const pdfsSeen = [...new Set([...shownPdfs.filter((id) => attachedPdfs.has(id)), +r.revA.id, +r.revB.id])];
  const review = { ...r, gate, heldSince, pdfsSeen, version: (stored?.version || 0) + 1, savedById: req.context.accountId, savedAt: now };
  // app storage keeps values up to 240 KiB: drop the set-aside list (it can be found again) before refusing
  if (Buffer.byteLength(JSON.stringify(review)) > 230000) review.setAside = (review.setAside || []).slice(0, 20);
  if (Buffer.byteLength(JSON.stringify(review)) > 230000) return { stale: true, error: 'This review is too large to save. Split the drawing into fewer sheets per change order.' };
  // two reviewers saving from the same version at once: each save first claims its version number, and only
  // one claim can exist, so the second gets "someone else just saved" instead of silently overwriting
  const claim = `claim:${issue.id}:${review.version}`;
  try { await kvs.set(claim, now, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { value: 2, unit: 'MINUTES' } }); }
  catch (e) {
    // only an existing claim means someone else saved this version; any other storage error is reported as such
    if (await kvs.get(claim).catch(() => null)) return { conflict: true, review: (await kvs.get(reviewKey(issue.id))) || stored || { version: 0, decisions: {} } };
    throw e;
  }
  try { await kvs.set(reviewKey(issue.id), review); } catch (e) { await kvs.delete(claim).catch(() => {}); throw e; }
  // the validator's verdict on the work item as it is now (a PDF attached since, an unread photo), for the JQL copy
  const verdict = verdictOf(issue.fields.attachment, review, notes);
  await indexGate(issue.id, review, verdict);
  // every save is recorded: who, when, the verdict and which changes they signed (last 200 kept)
  try {
    const audit = (await kvs.get(auditKey(issue.id))) || [];
  audit.push({ at: now, by: me.accountId, name: me.displayName, version: review.version, status: gate.status, clouds: r.clouds?.length || 0, signed, ...(!sameRevs ? { pdfsSeen } : {}), ...(reread ? { reread: `${stored.engine} -> ${r.engine}, ${stored.clouds?.length || 0} -> ${r.clouds?.length || 0} changes` } : {}) });
    await kvs.set(auditKey(issue.id), fitAudit(audit));
  } catch (e) { console.warn('redline: review saved, audit entry not written'); }
  // searchable copy for JQL only; the validator, the gadget and Rovo recompute from app storage
  try {
  await api.asApp().requestJira(route`/rest/api/3/issue/${key}/properties/${PROP}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gate: { status: verdict.blocked ? 'blocked' : 'clear', text: verdict.text, open: verdict.open || 0 }, revB: r.revB, version: review.version }),
  });
  } catch (e) { console.warn('redline: review saved, search copy not written'); }
  return { ok: true, version: review.version, gate: verdict, decisions: review.decisions, staleNotes, ...(!may.ok && asked ? { signRefused: may.why } : {}) };
});

async function attach(key, name, mime, base64) {
  // multipart/form-data built by hand: one part named "file", CRLF line endings as the format requires
  const boundary = '----redline' + Math.random().toString(16).slice(2);
  const CRLF = String.fromCharCode(13, 10);
  const head = Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${name.replace(/["\r\n]/g, '')}"${CRLF}Content-Type: ${mime}${CRLF}${CRLF}`);
  const body = Buffer.concat([head, Buffer.from(base64, 'base64'), Buffer.from(`${CRLF}--${boundary}--${CRLF}`)]);
  const res = await jira(route`/rest/api/3/issue/${key}/attachments`, {
    method: 'POST', headers: { 'X-Atlassian-Token': 'no-check', 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body,
  });
  return (await res.json())[0];
}

// A photo of a marked-up print, taken in the light table, is kept on the work item like any attachment.
resolver.define('uploadPhoto', async (req) => {
  const a = await attach(issueKey(req), req.payload.name, 'image/jpeg', req.payload.data);
  // the new photo holds the release until it is read: the gadget and search say so at once
  const issue = await (await jira(route`/rest/api/3/issue/${issueKey(req)}?fields=summary`)).json();
  await refreshVerdict(issue.id).catch(() => {});
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
  // the work item exists now: a link or crop that fails is reported, never retried into a duplicate
  const linked = await jira(route`/rest/api/3/issueLink`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: { name: 'Relates' }, inwardIssue: { key: created.key }, outwardIssue: { key: eco } }),
  }).then(() => true).catch(() => false);
  const cropAttached = crop ? await attach(created.key, `markup-zone-${zone}.jpg`, 'image/jpeg', crop).then(() => true).catch(() => false) : null;
  return { key: created.key, linked, cropAttached };
});

// A change no note describes can be written up as the next numbered note, from what Redline read (zone, what moved,
// the values). The description is the change order: the note goes into its numbered list, and the change is then
// declared against it and signed like any other.
resolver.define('addNote', async (req) => {
  const key = issueKey(req);
  if (!(await canEdit(key))) return { readOnly: true };
  const text = String(req.payload?.text || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 400);
  if (!text) throw new Error('The note is empty.');
  const issue = await (await jira(route`/rest/api/3/issue/${key}?fields=description`)).json();
  const doc = issue.fields.description || { type: 'doc', version: 1, content: [] };
  const before = notesFromAdf(doc), n = before.length ? Math.max(...before.map((x) => x.n)) + 1 : 1;
  // the description must read as the light table showed it: someone else's edit since is never written over
  const said = (list) => list.map((x) => `${x.n}:${noteKey(x.text)}`).join('|');
  if (req.payload?.expect != null && said(before) !== req.payload.expect) return { stale: true, notes: before };
  // claim the note number first: two adds at once can never both write note n
  try { await kvs.set(`note:${issue.id}:${n}`, new Date().toISOString(), { keyPolicy: 'FAIL_IF_EXISTS', ttl: { value: 2, unit: 'MINUTES' } }); }
  catch (e) { return { stale: true, notes: before }; }
  const item = { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
  const lists = (doc.content || []).filter((x) => x.type === 'orderedList');
  const last = lists[lists.length - 1];
  if (last && (last.attrs?.order || 1) + (last.content || []).length === n) last.content.push(item);
  else {
    if (!before.length) doc.content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Change notes' }] });
    doc.content.push({ type: 'orderedList', attrs: { order: n }, content: [item] });
  }
  // read again just before writing: an edit made since the first read is never written over
  const now2 = notesFromAdf((await (await jira(route`/rest/api/3/issue/${key}?fields=description`)).json()).fields.description);
  if (said(now2) !== said(before)) { await kvs.delete(`note:${issue.id}:${n}`).catch(() => {}); return { stale: true, notes: now2 }; }
  try { await jira(route`/rest/api/3/issue/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { description: doc } }) }); }
  catch (e) { await kvs.delete(`note:${issue.id}:${n}`).catch(() => {}); throw e; } // nothing written: the number is free again
  // read it back: note n must be the words written here (an edit made in the same moment is reported, not hidden)
  const after = notesFromAdf((await (await jira(route`/rest/api/3/issue/${key}?fields=description`)).json()).fields.description);
  // every note must read as before plus the new one: an edit made in the same moment is reported, never silently undone
  if (said(after) !== said([...before, { n, text }])) return { stale: true, notes: after };
  // who wrote which note in Redline, shown next to the note and to Rovo; and the audit log (a failure never undoes it)
  try {
    const me = await (await jira(route`/rest/api/3/myself`)).json();
    const audit = (await kvs.get(auditKey(issue.id))) || [];
    audit.push({ at: new Date().toISOString(), by: me.accountId, name: me.displayName, noteAdded: { n, text } });
    await kvs.set(auditKey(issue.id), fitAudit(audit));
    const written = (await kvs.get(`written:${issue.id}`)) || [];
    written.push({ n, text, by: me.displayName, byId: me.accountId, at: new Date().toISOString() });
    await kvs.set(`written:${issue.id}`, written.slice(-50));
  } catch (e) { console.warn('redline: note added, audit entry not written'); }
  await refreshVerdict(issue.id).catch(() => {});
  return { notes: after, n, writtenBy: true };
});

// A judge or new user on an empty site can add the bundled sample change order (two public-domain
// NIST drawing revisions and two numbered change notes) to the work item they are looking at.
resolver.define('addSample', async (req) => {
  const key = issueKey(req);
  // the notes go in first and files already attached are skipped, so trying again never duplicates anything
  const issue = await (await jira(route`/rest/api/3/issue/${key}?fields=description,attachment`)).json();
  const have = new Set((issue.fields.attachment || []).map((a) => a.filename));
  if (!notesFromAdf(issue.fields.description).length) {
    const doc = issue.fields.description || { type: 'doc', version: 1, content: [] };
    const item = (t) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
    doc.content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Change notes' }] },
      { type: 'orderedList', attrs: { order: 1 }, content: req.payload.notes.map(item) });
    await jira(route`/rest/api/3/issue/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { description: doc } }) });
  }
  for (const f of req.payload.files) if (!have.has(f.name)) await attach(key, f.name, f.mime || 'application/pdf', f.data);
  await refreshVerdict(issue.id).catch(() => {}); // held until compared: the gadget and search say so at once
  return { ok: true };
});

export const handler = resolver.getDefinitions();

// ---------- release gate (workflow validator) ----------

// Runs inside the transition. It reads the review from app storage (not the editable issue property),
// recomputes the verdict, and checks that the review covers the newest PDF revision on the work item.
export async function releaseGate(event) {
  // fail closed: if anything cannot be read or checked, the release waits and says so
  try {
    const key = event.issue?.key, id = event.issue?.id;
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${key || id}?fields=attachment,description`);
    if (!res.ok) return { result: false, errorMessage: `Redline could not read this work item's drawings (Jira answered ${res.status}). Try the transition again.` };
    const issue = await res.json();
    const v = verdictOf(issue.fields?.attachment, await kvs.get(reviewKey(issue.id)), notesFromAdf(issue.fields?.description));
    return v.blocked ? { result: false, errorMessage: `Redline: ${v.text}. Open the light table on this work item to resolve it before release.` } : { result: true };
  } catch (e) {
    return { result: false, errorMessage: 'Redline could not check the drawing review just now, so the release waits. Try the transition again in a minute.' };
  }
}

// ---------- Rovo actions ----------

function describe(o) {
  const r = o.review;
  const latest = o.attachments[o.attachments.length - 1];
  if (o.drawingConflict) return { key: o.key, state: 'blocked', gate: o.verdict?.text, message: `${o.drawingConflict} different drawings are attached with revisions; Redline compares one drawing per change order, so release is blocked.` };
  if (o.attachments.length < 2) return o.review
    ? { key: o.key, state: 'blocked', gate: o.verdict?.text, message: 'A reviewed drawing revision was removed from the work item, so release is blocked.' }
    : { key: o.key, state: 'no-revisions', message: 'Fewer than two PDF revisions are attached.' };
  if (!r) return { key: o.key, state: 'not-compared', message: `Revisions ${(o.attachments.find((a) => +a.id === +o.pair?.[0]) || o.attachments.at(-2)).filename} and ${latest.filename} have not been compared in Redline yet.` };
  const stale = r.revB?.id !== latest.id;
  return {
    key: o.key,
    state: o.verdict ? (o.verdict.blocked ? 'blocked' : 'clear') : stale ? 'stale' : r.gate?.status,
    gate: o.verdict?.text || r.gate?.text,
    compared: `${r.revA?.filename} to ${r.revB?.filename}`,
    staleReason: stale ? `${latest.filename} was attached after the last review` : undefined,
    // a note written from Redline's light table says so, and who wrote it
    notes: o.notes.map((n) => { const w = (o.notesWritten || []).find((x) => x.n === n.n && noteKey(x.text) === noteKey(n.text)); return w ? { ...n, writtenInRedlineBy: w.by } : n; }),
    otherPdfs: o.otherPdfs?.length ? o.otherPdfs.map((a) => `${a.filename} ${a.why}`) : undefined,
    changes: (r.clouds || []).map((c) => {
      const d = r.decisions?.[c.id] || {};
      const note = o.notes.find((n) => n.n === d.note);
      const slip = d.status === 'declared' ? valueSlip(c, note?.text) : [];
      const promised = d.status === 'declared' ? noteSlip(c, note?.text) : [];
      return {
        change: c.n, zone: c.zone, kind: c.kind,
        drawingTextBefore: c.before || undefined, drawingTextAfter: c.after || undefined,
        whatChanged: meaningOf(c.before, c.after).map((m) => m.text).join('; ') || undefined,
        status: c.carried ? (d.status === 'accepted' ? `left open on ${revLabel(c.carried.from)} to ${revLabel(c.carried.to)}, fixed in this revision${d.signedBy ? `, signed by ${d.signedBy}` : ', not signed yet'}` : d.status === 'rejected' ? `left open on ${revLabel(c.carried.from)} to ${revLabel(c.carried.to)}, sent back again` : `left open on ${revLabel(c.carried.from)} to ${revLabel(c.carried.to)} (${c.carried.was}), not confirmed fixed`)
          : d.status === 'declared' ? (note ? `declared in note ${d.note}` : `declared in note ${d.note}, which is no longer in the description`) : d.status === 'accepted' ? 'accepted as a drawing correction' : d.status === 'rejected' ? 'sent back to the drafter' : 'not in the change notes',
        valueCheck: slip.length ? (d.valueOk ? `drawing value ${slip.join(', ')} differs from the note; confirmed as right by ${d.valueOk.by}` : `drawing value ${slip.join(', ')} is not what note ${d.note} says`)
          : promised.length ? (d.valueOk ? `note ${d.note} says ${promised.join(', ')}, which the drawing does not show; confirmed as right by ${d.valueOk.by}` : `note ${d.note} says ${promised.join(', ')}, which the drawing does not show`) : undefined,
        signedOffBy: d.signedBy || null,
      };
    }),
    penMarkups: (r.marks || []).map((m) => {
      const md = r.markDecisions?.[m.id] || {};
      return { markup: `P${m.n}`, zone: m.zone, answer: md.status && md.status !== 'open' ? `${md.status}${md.key ? ` as ${md.key}` : ''}${md.by ? ` by ${md.by}` : ''}` : 'not answered' };
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
async function keysWith(prefix, max = 5000) { // every key and value under a prefix, a page at a time
  const out = [];
  for (let cursor; ;) {
    let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    out.push(...page.results);
    if (!page.nextCursor || out.length >= max) return out;
    cursor = page.nextCursor;
  }
}

// Reviews saved before the index existed are indexed once, as the app (so none is missed for want of permission).
async function backfillIndex() {
  if (await kvs.get('gate-index:v1').catch(() => null)) return;
  const reviews = await keysWith('review:', 2000);
  for (let k = 0; k < reviews.length; k += 100) {
    const batch = reviews.slice(k, k + 100);
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/bulkfetch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueIdsOrKeys: batch.map((x) => x.key.slice('review:'.length)), fields: ['attachment', 'description'] }),
    });
    if (!res.ok) return;
    for (const i of (await res.json()).issues || []) {
      const review = batch.find((x) => x.key === `review:${i.id}`)?.value;
      let v;
      try { v = verdictOf(i.fields.attachment, review, notesFromAdf(i.fields.description)); }
      catch (e) { v = { blocked: true, text: 'Redline could not read this review; open the light table to compare again' }; }
      await indexGate(i.id, review, v);
    }
  }
  await kvs.set('gate-index:v1', new Date().toISOString());
}

async function reviewedChangeOrders(projectKey) {
  // every change order Redline has a verdict for, found by key in app storage (deleting or editing the issue
  // property cannot hide one from this list); only the work items this person can see are listed
  await backfillIndex();
  const gates = new Map((await keysWith('gate:')).map((x) => [x.key.slice('gate:'.length), x.value]));
  if (!gates.size) return { items: [] };
  const ids = [...gates.keys()];
  const project = projectKey ? `${String(projectKey).toUpperCase()}-` : null;
  const items = [];
  for (let k = 0; k < ids.length; k += 100) {
    // bulk fetch answers for the ids it can see and lists the rest (deleted, or hidden from this user) as errors
    const res = await api.asUser().requestJira(route`/rest/api/3/issue/bulkfetch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueIdsOrKeys: ids.slice(k, k + 100), fields: ['summary', 'status', 'updated'] }),
    });
    if (!res.ok) continue;
    for (const i of ((await res.json()).issues || []).filter((x) => !project || x.key.startsWith(project))) {
      const g = gates.get(String(i.id));
      items.push({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name, blocked: !!g.blocked, gate: g.text, reasons: g.reasons || [], since: g.since, updated: i.fields.updated });
    }
  }
  items.sort((x, y) => Date.parse(y.updated || 0) - Date.parse(x.updated || 0));
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

// When a drawing, a photo or the change notes change on a reviewed work item, refresh the searchable copy
// of the verdict, so JQL never shows "clear" for a change order the validator would refuse.
// When a work item is deleted, Redline's own records about it (review, audit log, sheet thumbnails) go too.
export async function onIssueDeleted(event) {
  const id = event.issue?.id;
  if (!id) return;
  await kvs.delete(reviewKey(id)).catch(() => {});
  await kvs.delete(auditKey(id)).catch(() => {});
  await kvs.delete(`gate:${id}`).catch(() => {});
  await kvs.delete(`written:${id}`).catch(() => {});
  // every sheet's thumbnail, however many sheets the drawing had
  for (let cursor; ;) {
    let q = kvs.query().where('key', WhereConditions.beginsWith(`thumb:${id}:`)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    for (const x of page.results) await kvs.delete(x.key).catch(() => {});
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
}

export async function onIssueUpdated(event) {
  const fields = (event.changelog?.items || []).map((i) => String(i.field || '').toLowerCase());
  if (!fields.some((f) => f === 'attachment' || f === 'description')) return;
  const id = event.issue?.id;
  if (!id) return;
  // with no review, only a new or removed PDF can change anything
  if (!(await kvs.get(reviewKey(id))) && !(event.changelog?.items || []).some((i) => String(i.field || '').toLowerCase() === 'attachment' && /\.pdf$/i.test(`${i.fromString || ''}${i.toString || ''}`.trim()))) return;
  await refreshVerdict(id);
}

// The verdict as the validator would give it now, written to the app-only index (gadget, Rovo) and the JQL copy. Run by
// the trigger, and by Redline itself after it attaches a photo or writes a note (Jira may not send the app its own events).
async function refreshVerdict(id, again = true) {
  const review = await kvs.get(reviewKey(id));
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${id}?fields=attachment,description`);
  if (!res.ok) return;
  const issue = await res.json();
  const put = (gate, extra = {}) => api.asApp().requestJira(route`/rest/api/3/issue/${id}/properties/${PROP}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gate, ...extra }) });
  // a work item that now carries two drawing revisions but was never compared is held too (the validator
  // already refuses its release); the JQL copy and the index say so, so search, dashboards and Rovo find it
  if (!review) {
    // (only PDFs named as one drawing's revisions, "BRKT-0142_rev-C.pdf": two invoices on an HR ticket are not a change
    // order, though the validator still refuses an uncompared pair on a transition it guards); fewer than two drops it
    const { pdfs, conflict, named } = drawingPdfs(issue.fields.attachment);
    if ((pdfs.length < 2 || !named) && !conflict) {
      await api.asApp().requestJira(route`/rest/api/3/issue/${id}/properties/${PROP}`, { method: 'DELETE' }).catch(() => {});
      await kvs.delete(`gate:${id}`).catch(() => {});
      return;
    }
    if (await kvs.get(reviewKey(id))) return; // a first review was saved meanwhile: it wrote its own verdict
    const text = conflict ? `${conflict} different drawings are attached with revisions` : 'the drawing revisions have not been compared yet';
    await indexGate(id, null, { blocked: true, text, reasons: [{ kind: 'uncompared', short: 'not compared yet' }] });
    await put({ status: 'blocked', text, open: 0 });
    // a first review saved while this was written: refresh once more so the review's own verdict stands
    if (again && (await kvs.get(reviewKey(id)))) await refreshVerdict(id, false);
    return;
  }
  const v = verdictOf(issue.fields.attachment, review, notesFromAdf(issue.fields.description));
  // a save made while this ran wrote its own, newer verdict: an older one is never written over it
  // (a newer save landed meanwhile: work its verdict out again from the work item as it is now)
  if (((await kvs.get(reviewKey(id)))?.version || 0) !== (review.version || 0)) return again ? refreshVerdict(id, false) : undefined;
  await indexGate(id, review, v);
  await put({ status: v.blocked ? 'blocked' : 'clear', text: v.text, open: v.open || 0 }, { revB: review.revB, version: review.version });
  if (again && ((await kvs.get(reviewKey(id)))?.version || 0) !== (review.version || 0)) await refreshVerdict(id, false);
}
