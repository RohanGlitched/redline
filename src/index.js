import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { gateOf, verdictOf, valueSlip, noteSlip, noteKey, drawingPdfs, pairOf, revLabel } from '../shared/gate.mjs';
import { notesFromAdf } from '../shared/notes.mjs';
import { ENGINE_VERSION, matchChanges, overlap, sameReview, settleSignatures, carriedChanges, notesDoneBefore } from '../shared/review.mjs';
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
  const attachments = pick.pdfs.map((a) => ({ id: +a.id, filename: a.filename, size: a.size, created: a.created, author: a.author?.displayName }));
  const images = (issue.fields.attachment || [])
    .filter((a) => /^image\/(jpeg|png|webp|heic|heif)$/.test(a.mimeType))
    .sort((x, y) => Date.parse(x.created) - Date.parse(y.created) || +x.id - +y.id)
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
    pair: pairOf(pick.pdfs, review).map((a) => +a.id),
    drawingConflict: pick.conflict || 0,
    // PDFs that are not this drawing's revisions (an ECO form, a test report): each can be set aside by name
    otherPdfs: (issue.fields.attachment || []).filter((a) => (a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename || '')) && !pairOf(pick.pdfs, review).some((p) => +p.id === +a.id))
      .map((a) => ({ id: +a.id, filename: a.filename, created: a.created })),
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
async function canEdit(key) {
  const res = await jira(route`/rest/api/3/mypermissions?issueKey=${key}&permissions=EDIT_ISSUES`);
  if (!res.ok) return false;
  return !!(await res.json()).permissions?.EDIT_ISSUES?.havePermission;
}

resolver.define('saveReview', async (req) => {
  const key = issueKey(req);
  if (!(await canEdit(key))) return { readOnly: true };
  const ires = await jira(route`/rest/api/3/issue/${key}?fields=summary,description,attachment`);
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
  if (sameRevs && !reread && !(req.payload.signed || []).length && !(req.payload.confirmed || []).length && sameReview(stored, r)) return { ok: true, unchanged: true, version: stored.version, gate: verdictOf(issue.fields.attachment, stored, notes), decisions: stored.decisions };
  const me = await (await jira(route`/rest/api/3/myself`)).json();
  const signed = [];
  // Signatures are never taken from the browser's copy of a decision (shared/review.mjs settleSignatures)
  const asideTotal = (r.setAside || []).length + (sameRevs && !reread ? (stored.setAside || []).filter((a) => !(r.setAside || []).some((b) => b.id === a.id)).length : 0);
  const staleNotes = [];
  signed.push(...settleSignatures(r.decisions || {}, { beforeOf, notes, signed: req.payload.signed, confirmed: req.payload.confirmed, shown: req.payload.shown || {}, me, now, asideTotal, stale: staleNotes }));
  // For the same pair of revisions, a save can add changes and compared sheets but never drop ones that
  // an earlier comparison found, and what was found about a change (its box, text and values) stays as
  // first recorded, so a review cannot be emptied or softened after the fact.
  // A re-read (above) replaces the old changes with the ones the current engine found, and the audit log says so.
  // what the previous pair of revisions left open comes along, whatever the browser sent
  if (!sameRevs && stored) {
    const mids = new Set((r.marks || []).map((m) => m.id));
    const photoOf = (m) => +(/^p(\d+)-/.exec(m.id)?.[1] || stored.print?.id);
    // (a stored markup the new read found again, in the same place, is the new one: it is not kept twice)
    const refound = (m) => (r.marks || []).some((x) => photoOf(x) === photoOf(m) && m.box && x.box && overlap(m.box, x.box) >= 0.3);
    // an answer follows its markup by place: when a new read numbers markups differently, an answer the browser carried
    // by number to a markup in another place is replaced by the answer given to the markup in this place
    r.markDecisions = { ...(r.markDecisions || {}) };
    for (const x of r.marks || []) {
      const here = (stored.marks || []).find((m) => photoOf(m) === photoOf(x) && m.box && x.box && overlap(m.box, x.box) >= 0.3);
      if (!here) continue;
      const sent = r.markDecisions[x.id], byNumber = stored.markDecisions?.[x.id], placed = stored.markDecisions?.[here.id];
      // nothing said in this session: the answer given before to the markup in this place stands (no second Raise)
      if (!sent || sent.status === 'open') { if (placed && placed.status !== 'open') r.markDecisions[x.id] = placed; continue; }
      if (here.id !== x.id && byNumber && sent.status === byNumber.status) r.markDecisions[x.id] = placed || { status: 'open' };
    }
    const open = (stored.marks || []).filter((m) => !mids.has(m.id) && stillAttached(photoOf(m)) && !refound(m));
    r.marks = [...(r.marks || []), ...open];
    // answers given before stand (a markup raised as ENG-7 is never offered for raising again)
    const answers = Object.fromEntries(open.map((m) => [m.id, stored.markDecisions?.[m.id]]).filter(([, v]) => v && v.status !== 'open'));
    r.markDecisions = { ...(r.markDecisions || {}), ...Object.fromEntries(Object.entries(answers).filter(([id]) => !r.markDecisions?.[id] || r.markDecisions[id].status === 'open')) };
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
    const mids = new Set((r.marks || []).map((m) => m.id));
    const answered = (m) => ['raised', 'covered', 'dismissed'].includes(stored.markDecisions?.[m.id]?.status);
    const photoOf = (m) => +(/^p(\d+)-/.exec(m.id)?.[1] || stored.print?.id);
    // each markup by its own photo: the current photo's, and earlier photos' unanswered ones while they are attached
    const keep = (stored.marks || []).filter((m) => !mids.has(m.id) && (photoOf(m) === +r.print?.id || (!answered(m) && stillAttached(photoOf(m)))));
    r.marks = [...(r.marks || []), ...keep];
    r.markDecisions = { ...Object.fromEntries(keep.map((m) => [m.id, stored.markDecisions?.[m.id]]).filter(([, v]) => v)), ...(r.markDecisions || {}) };
  }
  const gate = gateOf(r.clouds || [], r.decisions || {}, r.marks || [], r.markDecisions || {}, r.sheets, notes, { setAside: (r.setAside || []).length, notesDone: r.notesDone });
  // who answered each pen markup, and who set a photo aside, as Jira names them
  for (const [id, m] of Object.entries(r.markDecisions || {})) {
    if (m.status === 'raising') m.status = 'open';
    const was = stored?.markDecisions?.[id];
    if (m.status && m.status !== 'open' && was?.status === m.status) { m.by = was.by; m.byId = was.byId; m.at = was.at; }
    else if (m.status && m.status !== 'open') { m.by = me.displayName; m.byId = me.accountId; m.at = now; }
  }
  if (r.print?.setAside) r.print = +stored?.print?.id === +r.print.id && stored.print.setAside ? stored.print : { ...r.print, by: me.displayName, byId: me.accountId, at: now };
  // "held since": when this review's gate last went from clear (or new) to blocked
  const heldSince = gate.blocked ? (stored?.gate?.status === 'blocked' && stored.heldSince ? stored.heldSince : now) : null;
  const review = { ...r, gate, heldSince, version: (stored?.version || 0) + 1, savedById: req.context.accountId, savedAt: now };
  // app storage keeps values up to 240 KiB: drop the set-aside list (it can be found again) before refusing
  if (Buffer.byteLength(JSON.stringify(review)) > 230000) review.setAside = (review.setAside || []).slice(0, 20);
  if (Buffer.byteLength(JSON.stringify(review)) > 230000) return { stale: true, error: 'This review is too large to save. Split the drawing into fewer sheets per change order.' };
  // two reviewers saving from the same version at once: each save first claims its version number, and only
  // one claim can exist, so the second gets "someone else just saved" instead of silently overwriting
  const claim = `claim:${issue.id}:${review.version}`;
  try { await kvs.set(claim, now, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { value: 1, unit: 'HOURS' } }); }
  catch (e) {
    // only an existing claim means someone else saved this version; any other storage error is reported as such
    if (await kvs.get(claim).catch(() => null)) return { conflict: true, review: (await kvs.get(reviewKey(issue.id))) || stored || { version: 0, decisions: {} } };
    throw e;
  }
  try { await kvs.set(reviewKey(issue.id), review); } catch (e) { await kvs.delete(claim).catch(() => {}); throw e; }
  // the validator's verdict on the work item as it is now (a PDF attached since, an unread photo), for the JQL copy
  const verdict = verdictOf(issue.fields.attachment, review, notes);
  // every save is recorded: who, when, the verdict and which changes they signed (last 200 kept)
  try {
    const audit = (await kvs.get(auditKey(issue.id))) || [];
  audit.push({ at: now, by: me.accountId, name: me.displayName, version: review.version, status: gate.status, clouds: r.clouds?.length || 0, signed, ...(reread ? { reread: `${stored.engine} -> ${r.engine}, ${stored.clouds?.length || 0} -> ${r.clouds?.length || 0} changes` } : {}) });
    await kvs.set(auditKey(issue.id), audit.slice(-200));
  } catch (e) { console.warn('redline: review saved, audit entry not written'); }
  // searchable copy for JQL only; the validator, the gadget and Rovo recompute from app storage
  try {
  await api.asApp().requestJira(route`/rest/api/3/issue/${key}/properties/${PROP}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gate: { status: verdict.blocked ? 'blocked' : 'clear', text: verdict.text, open: verdict.open || 0 }, revB: r.revB, version: review.version }),
  });
  } catch (e) { console.warn('redline: review saved, search copy not written'); }
  return { ok: true, version: review.version, gate: verdict, decisions: review.decisions, staleNotes };
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
  const item = { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
  const lists = (doc.content || []).filter((x) => x.type === 'orderedList');
  const last = lists[lists.length - 1];
  if (last && (last.attrs?.order || 1) + (last.content || []).length === n) last.content.push(item);
  else {
    if (!before.length) doc.content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Change notes' }] });
    doc.content.push({ type: 'orderedList', attrs: { order: n }, content: [item] });
  }
  await jira(route`/rest/api/3/issue/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { description: doc } }) });
  // the audit log says who wrote the note from the light table
  const me = await (await jira(route`/rest/api/3/myself`)).json();
  const audit = (await kvs.get(auditKey(issue.id ?? (await (await jira(route`/rest/api/3/issue/${key}?fields=summary`)).json()).id))) || [];
  return { notes: notesFromAdf(doc), n, ...(await (async () => { try {
    audit.push({ at: new Date().toISOString(), by: me.accountId, name: me.displayName, noteAdded: { n, text } });
    await kvs.set(auditKey(issue.id), audit.slice(-200)); return {};
  } catch { return {}; } })()) };
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
    notes: o.notes,
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
async function reviewedChangeOrders(projectKey) {
  // every review Redline has stored, found by key in app storage (deleting or editing the issue property
  // cannot hide a change order from this list)
  const ids = [], stored = new Map();
  for (let cursor; ;) {
    let q = kvs.query().where('key', WhereConditions.beginsWith('review:')).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    for (const x of page.results) { const id = x.key.slice('review:'.length); ids.push(id); stored.set(id, x.value); }
    if (!page.nextCursor || ids.length >= 2000) break;
    cursor = page.nextCursor;
  }
  if (!ids.length) return { items: [] };
  const project = projectKey ? `${String(projectKey).toUpperCase()}-` : null;
  const items = [];
  for (let k = 0; k < ids.length; k += 100) {
    // bulk fetch answers for the ids it can see and lists the rest (deleted, or hidden from this user) as
    // errors, so one missing work item never costs a request per item
    const res = await api.asUser().requestJira(route`/rest/api/3/issue/bulkfetch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueIdsOrKeys: ids.slice(k, k + 100), fields: ['summary', 'status', 'attachment', 'description', 'updated'] }),
    });
    if (!res.ok) continue;
    const issues = ((await res.json()).issues || []).filter((i) => !project || i.key.startsWith(project));
    for (const i of issues) {
      const review = stored.get(String(i.id));
      const v = verdictOf(i.fields.attachment, review, notesFromAdf(i.fields.description));
      items.push({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name, blocked: !!v.blocked, gate: v.text, reasons: (v.reasons || []).map((r) => ({ kind: r.kind, short: r.short })), since: review?.heldSince || review?.savedAt, updated: i.fields.updated });
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
  const review = await kvs.get(reviewKey(id));
  // with no review, only a new or removed attachment can change anything
  if (!review && !fields.includes('attachment')) return;
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${id}?fields=attachment,description`);
  if (!res.ok) return;
  const issue = await res.json();
  // a work item that now carries two drawing revisions but was never compared is held too (the validator
  // already refuses its release); the JQL copy says so, so search and dashboards find it
  if (!review) {
    // (only PDFs named as drawing revisions, "BRKT-0142_rev-C.pdf": two invoices on a work item are not a change order)
    // (the validator's own reading: two PDFs named as revisions of one drawing, or any two PDFs when none is so named)
    const { pdfs, conflict, named } = drawingPdfs(issue.fields.attachment);
    // only PDFs named as one drawing's revisions mark a work item for search: two invoices on an HR ticket do not
    // (the validator still refuses an uncompared pair on a transition it guards); fewer than two drops the flag too
    if ((pdfs.length < 2 || !named) && !conflict) { await api.asApp().requestJira(route`/rest/api/3/issue/${id}/properties/${PROP}`, { method: 'DELETE' }).catch(() => {}); return; }
    await api.asApp().requestJira(route`/rest/api/3/issue/${id}/properties/${PROP}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gate: { status: 'blocked', text: conflict ? `${conflict} different drawings are attached with revisions` : 'the drawing revisions have not been compared yet', open: 0 } }),
    });
    return;
  }
  const v = verdictOf(issue.fields.attachment, review, notesFromAdf(issue.fields.description));
  await api.asApp().requestJira(route`/rest/api/3/issue/${id}/properties/${PROP}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gate: { status: v.blocked ? 'blocked' : 'clear', text: v.text, open: v.open || 0 }, revB: review.revB, version: review.version }),
  });
}
