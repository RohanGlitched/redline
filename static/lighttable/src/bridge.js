// One door to Forge. Inside Jira this is @forge/bridge; under `vite dev` it is a small stand-in that
// serves the bundled sample change order, so the light table can be built and tested in a plain browser.
const DEV = import.meta.env.DEV;
// @forge/bridge throws as soon as it loads outside Jira, so it is only loaded in the real app.
const forgeP = DEV ? null : import('@forge/bridge');

const SAMPLE = {
  key: 'ENG-1',
  summary: 'ECO-0142: Motor mount bracket, rev C to rev D',
  status: 'In review',
  notes: [
    { n: 1, text: 'Zone D2: bore callout Ø25 ±0.15 changes to Ø25.5 ±0.15 for the new bearing.' },
    { n: 2, text: 'Zone A7: add note "Break all sharp edges 0.2 max".' },
  ],
  attachments: [
    { id: 'c', filename: 'BRKT-0142_rev-C.pdf', created: '2026-10-28T09:12:00Z', url: './samples/BRKT-0142_rev-C.pdf' },
    { id: 'd', filename: 'BRKT-0142_rev-D.pdf', created: '2026-11-01T11:40:00Z', url: './samples/BRKT-0142_rev-D.pdf' },
  ],
  images: [{ id: 'p', filename: 'BRKT-0142_rev-D_print-photo.jpg', mimeType: 'image/jpeg', created: '2026-11-01T13:05:00Z', url: './samples/BRKT-0142_rev-D_print-photo.jpg' }],
  project: 'ENG', issuetype: '10001',
  user: { accountId: 'dev', displayName: 'Priya Nair' },
};

// ?sample=multi swaps in a three-sheet drawing set with a change on sheet 2
if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('sample') === 'multi') {
  SAMPLE.attachments = [
    { id: 'ma', filename: 'HSG-0207_rev-A.pdf', created: '2026-10-20T09:00:00Z', url: './samples/HSG-0207_rev-A.pdf' },
    { id: 'mb', filename: 'HSG-0207_rev-B.pdf', created: '2026-11-01T09:00:00Z', url: './samples/HSG-0207_rev-B.pdf' },
  ];
  SAMPLE.images = [];
  SAMPLE.key = 'ENG-4';
  SAMPLE.summary = 'ECO-0207: Gearbox housing, rev A to rev B (3 sheets)';
  SAMPLE.notes = [{ n: 1, text: 'Sheet 2, zone A7: add note 7 "Apply thread locker to all M6 screws".' }];
}
const REVIEW_KEY = `redline-review-${SAMPLE.key}`;

async function devInvoke(fn, payload = {}) {
  await new Promise((r) => setTimeout(r, 120));
  if (fn === 'getChangeOrder') {
    const review = JSON.parse(localStorage.getItem(REVIEW_KEY) || 'null');
    const thumbs = (review?.sheets?.done || [1]).map((n) => JSON.parse(localStorage.getItem(`${REVIEW_KEY}-thumb-${n}`) || 'null'))
      .filter((t) => t && t.revB === review?.revB?.id);
    const canEdit = new URLSearchParams(location.search).get('readonly') !== '1';
    return { ...SAMPLE, review, canEdit, ...(payload.withThumbs ? { thumbs, savedBy: review ? SAMPLE.user.displayName : null } : {}) };
  }
  if (fn === 'saveThumb') { localStorage.setItem(`${REVIEW_KEY}-thumb-${payload.sheet}`, JSON.stringify(payload)); return { ok: true }; }
  if (fn === 'getAttachment') {
    const a = [...SAMPLE.attachments, ...SAMPLE.images].find((x) => x.id === payload.id);
    const buf = new Uint8Array(await (await fetch(a.url)).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { size: buf.length, data: btoa(s) };
  }
  if (fn === 'gadget') return {
    jql: 'redlineGate = "blocked" ORDER BY updated DESC', blocked: 3, clear: 5,
    changeOrders: [
      { key: 'ENG-3', summary: 'ECO-0151: Motor mount bracket, release rev D', status: 'In review', gate: '2 changes on the drawing are not in the change notes' },
      { key: 'ENG-4', summary: 'ECO-0207: Gearbox housing, rev A to rev B (3 sheets)', status: 'In review', gate: '1 of 3 sheets is not compared yet' },
      { key: 'ENG-2', summary: 'ECO-0139: Cover plate, rev B', status: 'Approved', gate: '1 declared change needs a sign-off' },
    ],
  };
  if (fn === 'raiseMarkup') return { key: 'ENG-' + (10 + Math.floor(Math.random() * 80)) };
  if (fn === 'saveReview' && new URLSearchParams(location.search).get('readonly') === '1') return { readOnly: true };
  if (fn === 'saveReview') { localStorage.setItem(REVIEW_KEY, JSON.stringify({ ...payload.review, savedAt: new Date().toISOString() })); return { ok: true }; }
  throw new Error('no dev handler for ' + fn);
}

export const invoke = DEV ? devInvoke : async (fn, payload) => (await forgeP).invoke(fn, payload);

export async function getContext() {
  if (!DEV) return (await forgeP).view.getContext();
  const q = new URLSearchParams(location.search);
  const moduleKey = { panel: 'redline-panel', gadget: 'redline-gadget' }[q.get('view')] || 'redline-lighttable';
  return { moduleKey, extension: { issue: { key: 'ENG-1' } } };
}

export async function enableTheme() { if (!DEV) await (await forgeP).view.theme.enable(); }

export async function openLightTable() {
  if (DEV) { window.open('?view=table', '_blank'); return; }
  const { Modal, view } = await forgeP;
  const ctx = await view.getContext();
  // the modal reloads this same bundle; the context tells main.jsx to show the light table, and
  // carries the work item key because a modal has no issue of its own
  return new Promise((resolve) => new Modal({ resource: 'main', size: 'max', closeOnOverlayClick: false,
    context: { mode: 'lighttable', issueKey: ctx.extension.issue.key }, onClose: resolve }).open());
}

export async function closeModal() { if (!DEV) (await forgeP).view.close(); }

// Open a work item or a search in Jira (in the dev build, just log it).
export async function openPath(path) {
  if (DEV) { console.log('open', path); return; }
  await (await forgeP).router.navigate(path);
}
