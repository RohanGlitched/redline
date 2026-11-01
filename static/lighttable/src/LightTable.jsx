// The light table: two drawing revisions registered on one sheet, every change clouded, every cloud
// tied to a change-note line or held as undeclared, and the release gate that follows from it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, closeModal, getFocus } from './bridge.js';
import { matchChanges, overlap } from '../../../shared/review.mjs';
import { analyse, noteSheet, composite, grayToImage, ENGINE_VERSION, ZONE_COLS, ZONE_ROWS, loadPhoto, readPrint, photoForUpload, quadMatrix } from './analysis.js';
import { cloudPath } from './cloud.js';
import { gateOf, valueSlip } from '../../../shared/gate.mjs';

const MODES = [
  { key: 'overlay', label: 'Overlay', hint: 'Shared lines in graphite, removed in red, added in blue' },
  { key: 'swipe', label: 'Swipe', hint: 'Drag the divider to wipe between revisions' },
  { key: 'blink', label: 'Blink', hint: 'Alternates the two revisions so changes flicker' },
  { key: 'a', label: 'Rev A', hint: 'The earlier revision only' },
  { key: 'b', label: 'Rev B', hint: 'The new revision only' },
];
const kindText = (c) => (c.countedBack ? 'Set aside by Redline as a re-plot shift, counted back in by the reviewer' : c.housekeeping === 'stamp' ? 'Plot stamp: date, file or tool version'
  : c.move ? `Moved ${c.move.mm} mm${c.move.dir ? ` ${c.move.dir}` : ''}${c.housekeeping ? ', otherwise unchanged' : ''}` : KIND_TEXT[c.kind]);
const KIND_TEXT = { added: 'New line work', removed: 'Line work removed', changed: 'Line work changed', sheetAdded: 'Whole sheet added in this revision', sheetRemoved: 'Whole sheet removed in this revision' };
const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function useCanvasImage(img) {
  return useMemo(() => {
    if (!img) return null;
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0); return c;
  }, [img]);
}

export default function LightTable() {
  const [order, setOrder] = useState(null);
  const [stage, setStage] = useState('Opening the change order');
  const [error, setError] = useState(null);
  const [res, setRes] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [mode, setMode] = useState('overlay');
  const [sel, setSel] = useState(null);
  const [phase, setPhase] = useState('dark'); // dark -> sweep -> clouds -> ready
  const [blinkOn, setBlinkOn] = useState(false);
  const [swipe, setSwipe] = useState(0.5);
  const [saved, setSaved] = useState('');
  const [cam, setCam] = useState({ s: 1, x: 0, y: 0 });
  const [print, setPrint] = useState(null); // { att, status, result, error }
  const [markDecisions, setMarkDecisions] = useState({});
  const [flatten, setFlatten] = useState(null); // { url, src, from, to, t } while the photo settles onto the sheet
  const stageRef = useRef(null), camRef = useRef(cam), versionRef = useRef(0);
  camRef.current = cam;

  // Load the change order and both revisions, then compare sheet 1 (other sheets on demand).
  const [sheet, setSheet] = useState(1);
  const [sheets, setSheets] = useState({ count: 1, compared: {} }); // compared: { [sheet]: clouds }
  const [turning, setTurning] = useState(null); // sheet being compared while the current one stays on the table
  const analysed = useRef({});
  const [aside, setAside] = useState({}); // { [sheet]: differences set aside as re-plot shifts }
  const loadedSheets = useRef(new Set()); // sheets whose saved decisions were carried over this session
  const sheetRef = useRef(1);
  const [showAside, setShowAside] = useState(false);
  const loadSheet = useCallback(async (o, n, revA, revB, keep = false) => {
    if (keep) setTurning(n); else setRes(null);
    let r;
    try { r = analysed.current[n] || (analysed.current[n] = await analyse(invoke, revA, revB, o.notes, setStage, n)); }
    finally { setTurning(null); }
    setPhase('dark'); setSel(null);
    // the photo of the print belongs to sheet 1: it stays read (and counted) while other sheets are
    // compared, but is only shown over sheet 1
    if (n !== 1) setMode((m) => (m === 'print' ? 'overlay' : m));
    // cloud ids carry the sheet so decisions on different sheets never collide
    const found = r.clouds.map((c) => ({ ...c, id: `s${n}-${c.id}`, sheet: n }));
    // differences a reviewer counted back in stay changes when the light table is opened again
    const sameRevB = o.review && o.review.revB?.id === revB.id;
    const back = sameRevB ? (o.review.clouds || []).filter((c) => c.countedBack && (c.sheet || 1) === n)
      .map((c) => ({ ...c, x0: c.box[0], y0: c.box[1], x1: c.box[2], y1: c.box[3] })) : [];
    const clouds = [...found, ...back.filter((b) => !found.some((c) => c.id === b.id))];
    // decisions saved earlier follow their change by where it is on the sheet, not by its number, so a
    // newer engine that finds the changes in another order (or drops one) never moves a signature
    const prior = o.review && o.review.revB?.id === revB.id ? priorDecisions(o.review, clouds, n) : { others: {}, mine: {} };
    setAside((x) => ({ ...x, [n]: (r.setAside || []).map((a) => ({ ...a, id: `s${n}-${a.id}`, sheet: n }))
      .filter((a) => !back.some((b) => overlap([a.x0, a.y0, a.x1, a.y1], b.box) >= 0.5)) }));
    sheetRef.current = n;
    const first = !loadedSheets.current.has(n), firstEver = !loadedSheets.current.size;
    loadedSheets.current.add(n);
    setDecisions((d) => {
      // the first time a sheet is compared this session, its saved decisions are carried over by position;
      // after that, what the reviewer decided stands
      let next = { ...d };
      if (first) {
        next = Object.fromEntries(Object.entries(d).filter(([id]) => !id.startsWith(`s${n}-`)));
        Object.assign(next, firstEver ? prior.others : {}, prior.mine);
      }
      for (const c of clouds) next[c.id] = next[c.id] || (c.note ? { status: 'declared', note: c.note } : { status: 'open' });
      return next;
    });
    const count = Math.max(r.pages[0], r.pages[1]); // a sheet only one revision has still needs a review
    setSheets((x) => ({ count, compared: { ...x.compared, [n]: clouds } }));
    setRes({ ...r, clouds, revA, revB, sheet: n });
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const o = await invoke('getChangeOrder');
        setOrder(o);
        const pdfs = o.attachments;
        if (pdfs.length < 2) { setError('Attach two PDF revisions of the drawing to this work item, oldest first.'); return; }
        const [revA, revB] = pdfs.slice(-2);
        if (o.review?.revB?.id === revB.id) {
          // sheets compared in an earlier session count as compared, with their saved changes
          const bySheet = {};
          for (const c of o.review.clouds || []) (bySheet[c.sheet || 1] ||= []).push(c);
          setSheets({ count: o.review.sheets?.count || 1, compared: Object.fromEntries((o.review.sheets?.done || []).map((n) => [n, bySheet[n] || []])) });
          if (o.review.markDecisions) setMarkDecisions(o.review.markDecisions);
        }
        versionRef.current = o.review?.version || 0;
        await loadSheet(o, 1, revA, revB);
      } catch (e) { setError(e.message || String(e)); }
    })();
  }, []);

  const goSheet = async (n) => {
    if (n === sheet || !res || turning) return;
    try { await loadSheet(order, n, res.revA, res.revB, true); setSheet(n); } catch (e) { setError(e.message || String(e)); }
  };

  const overlayCanvas = useCanvasImage(useMemo(() => res && composite(res.hiA, res.hiBw), [res]));
  const aCanvas = useCanvasImage(useMemo(() => res && grayToImage(res.hiA, [43, 47, 54]), [res]));
  const bCanvas = useCanvasImage(useMemo(() => res && grayToImage(res.hiBw, [44, 74, 154]), [res]));
  // After a sheet is compared, send the issue panel a small diazo-blue picture of revision B for it.
  const thumbsSent = useRef(new Set());
  useEffect(() => {
    if (!res || !bCanvas) return;
    const id = `${res.revB.id}:${res.sheet}`;
    if (thumbsSent.current.has(id)) return;
    thumbsSent.current.add(id);
    const w = 560, h = Math.round((w * bCanvas.height) / bCanvas.width);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high'; g.drawImage(bCanvas, 0, 0, w, h);
    const data = c.toDataURL('image/jpeg', 0.72).split(',')[1];
    // boxes are stored in analysis pixels, so the panel scales them by the analysis size
    invoke('saveThumb', { revB: res.revB.id, sheet: res.sheet, w: res.A.w, h: res.A.h, data }).catch(() => thumbsSent.current.delete(id));
  }, [res, bCanvas]);
  const printCanvas = useCanvasImage(useMemo(() => (print?.status === 'done' ? print.result.flat : null), [print]));

  // Fit the sheet to the stage, then play the one orchestrated moment: the table lights up, clouds draw.
  useEffect(() => {
    if (!res || !stageRef.current) return;
    const r = stageRef.current.getBoundingClientRect();
    const s = Math.min((r.width - 48) / res.A.w, (r.height - 48) / res.A.h);
    setCam({ s, x: (r.width - res.A.w * s) / 2, y: (r.height - res.A.h * s) / 2 });
    if (reduceMotion) { setPhase('ready'); return; }
    setPhase('sweep');
    const t1 = setTimeout(() => setPhase('clouds'), 1250);
    const t2 = setTimeout(() => setPhase('ready'), 1250 + stagger(res.clouds.length) * res.clouds.length + 600);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [res]);

  useEffect(() => {
    if (mode !== 'blink') return;
    const t = setInterval(() => setBlinkOn((v) => !v), 650);
    return () => clearInterval(t);
  }, [mode]);

  // Paper markups: read a photo of a marked-up print, play the photo settling flat onto the sheet,
  // then show each pen mark as a markup that needs an answer.
  const readPhoto = useCallback(async (att) => {
    setPrint({ att, status: 'reading' });
    try {
      const photo = await loadPhoto(invoke, att);
      const result = readPrint(photo, res);
      if (result.error) { setPrint({ att, status: 'error', error: result.error }); return; }
      // markups belong to this photo: a new photo's P1 never inherits the answer given to an old one's
      result.marks = result.marks.map((k) => ({ ...k, id: `p${att.id}-${k.id}` }));
      const url = photo.canvas.toDataURL('image/jpeg', 0.85);
      const r = stageRef.current.getBoundingClientRect(), c = camRef.current;
      const fitK = Math.min((r.width * 0.86) / photo.w, (r.height * 0.86) / photo.h);
      const ox = (r.width - photo.w * fitK) / 2, oy = (r.height - photo.h * fitK) / 2;
      const from = result.corners.map(([x, y]) => [ox + x * fitK, oy + y * fitK]);
      const to = [[c.x, c.y], [c.x + res.A.w * c.s, c.y], [c.x + res.A.w * c.s, c.y + res.A.h * c.s], [c.x, c.y + res.A.h * c.s]];
      setMarkDecisions((m) => Object.fromEntries(result.marks.map((k) => [k.id, m[k.id] || { status: 'open' }])));
      if (reduceMotion) { setPrint({ att, status: 'done', result }); setMode((m) => (sheetRef.current === 1 ? 'print' : m)); return; }
      // hold the photo as taken for a beat, then let it settle onto the sheet
      setFlatten({ url, src: result.corners, from, to, t: 0, w: photo.w, h: photo.h });
      await new Promise((ok) => setTimeout(ok, 700));
      const t0 = performance.now();
      await new Promise((ok) => {
        const step = (now) => {
          const t = Math.min(1, (now - t0) / 1100);
          setFlatten((f) => f && { ...f, t: 1 - Math.pow(1 - t, 3) });
          if (t < 1) requestAnimationFrame(step); else ok();
        };
        requestAnimationFrame(step);
      });
      setPrint({ att, status: 'done', result }); setMode((m) => (sheetRef.current === 1 ? 'print' : m));
      setTimeout(() => setFlatten(null), 450);
    } catch (e) { setPrint({ att, status: 'error', error: e.message || String(e) }); }
  }, [res]);

  useEffect(() => {
    // a photographed print is of the first sheet unless someone says otherwise
    if (phase === 'ready' && !print && res?.sheet === 1 && order?.images?.length) {
      const last = order.images[order.images.length - 1];
      // a photo someone already set aside as not a print stays set aside
      if (order.review?.print?.setAside && +order.review.print.id === +last.id) setPrint({ att: last, status: 'aside' });
      else readPhoto(last);
    }
  }, [phase]);

  async function addPhoto(file) {
    if (readOnly) return;
    setPrint({ status: 'reading' });
    try {
      const up = await photoForUpload(file);
      const att = await invoke('uploadPhoto', up);
      setOrder((o) => ({ ...o, images: [...(o.images || []), att] }));
      await readPhoto(att);
    } catch (e) { setPrint({ status: 'error', error: e.message || String(e) }); }
  }

  const marks = print?.status === 'done' ? print.result.marks : [];
  // someone who can view the work item but not edit it sees the review without the controls to change it
  const readOnly = order?.canEdit === false;
  const decideMark = (id, patch) => { if (!readOnly) setMarkDecisions((d) => ({ ...d, [id]: { ...d[id], ...patch } })); };
  async function raiseMark(m) {
    if (readOnly) return;
    decideMark(m.id, { status: 'raising' });
    try {
      const crop = cropJpeg(print.result.flat, m);
      const r = await invoke('raiseMarkup', { zone: m.zone, summary: order.summary, project: order.project, issuetype: order.issuetype, crop, photo: print.att?.filename });
      decideMark(m.id, { status: 'raised', key: r.key, by: order.user.displayName, at: new Date().toISOString() });
    } catch (e) { decideMark(m.id, { status: 'open', error: e.message }); }
  }

  // Autosave the review. The backend keeps it in app storage, which the release validator reads.
  const allClouds = useMemo(() => Object.values(sheets.compared).flat(), [sheets]);
  const sheetInfo = { count: sheets.count, done: Object.keys(sheets.compared).map(Number) };
  const gate = useMemo(() => gateOf(allClouds, decisions, marks, markDecisions, sheetInfo, order?.notes), [allClouds, decisions, marks, markDecisions, sheets, order]);
  // Saves go one at a time: a decision made while a save is on its way waits for it, then saves with
  // the new version, so two quick decisions never look like someone else saving in between.
  const saving = useRef(false), pending = useRef(false);
  const [saveTick, setSaveTick] = useState(0);
  useEffect(() => {
    // a comparison that found nothing is a review too: it is saved so the release can go ahead
    if (!res) return;
    if (readOnly) { setSaved('View only'); return; }
    if (saving.current) { pending.current = true; return; }
    const t = setTimeout(async () => {
      saving.current = true;
      setSaved('Saving');
      try {
        const out = await invoke('saveReview', { baseVersion: versionRef.current, review: {
          engine: ENGINE_VERSION, analysedAt: new Date().toISOString(),
          revA: { id: res.revA.id, filename: res.revA.filename }, revB: { id: res.revB.id, filename: res.revB.filename },
          clouds: allClouds.map(({ id, n, zone, kind, sheet: sh, x0, y0, x1, y1, box, before, after, values, move, housekeeping, countedBack }) => ({ id, n, zone, kind, sheet: sh || 1, box: box || [x0, y0, x1, y1], before, after, values, move, housekeeping, countedBack })),
          sheets: sheetInfo,
          setAside: Object.values(aside).flat().slice(0, 300).map(({ id, sheet: sh, zone, x0, y0, x1, y1, match }) => ({ id, sheet: sh, zone, box: [x0, y0, x1, y1], match })),
          decisions, gate: { status: gate.blocked ? 'blocked' : 'clear', text: gate.text, open: gate.open, unsigned: gate.unsigned, rejected: gate.rejected, markups: gate.markups },
          print: print?.status === 'done' ? { id: print.att.id, filename: print.att.filename }
            : print?.status === 'aside' ? { id: print.att.id, filename: print.att.filename, setAside: true } : null,
          marks: marks.map(({ id, n, zone, x0, y0, x1, y1 }) => ({ id, n, zone, box: [x0, y0, x1, y1] })), markDecisions,
        } });
        if (out?.readOnly) { setSaved('View only: you cannot edit ' + (order?.key || 'this work item')); return; }
        if (out?.conflict) {
          // someone else saved in between: take their decisions, then let this reviewer carry on
          versionRef.current = out.review.version || 0;
          setDecisions(out.review.decisions || {}); setMarkDecisions(out.review.markDecisions || {});
          setSaved('Someone else just saved this review; their decisions are loaded');
          return;
        }
        if (out?.stale) { setSaved(out.error); return; }
        versionRef.current = out?.version ?? versionRef.current;
        // take back what the server stamped (who signed, when), without disturbing decisions made since
        // (only when something actually changed: a new object here would trigger another save, forever)
        if (out?.decisions) setDecisions((cur) => {
          let changed = false;
          const next = { ...cur };
          for (const [id, d] of Object.entries(out.decisions)) {
            const c = cur[id];
            if (!(c && c.status === d.status && (c.note ?? null) === (d.note ?? null) && !!c.signedAt === !!d.signedAt)) continue;
            const valueOk = d.valueOk ?? c.valueOk;
            if (c.signedAt === d.signedAt && c.signedBy === d.signedBy && JSON.stringify(c.valueOk ?? null) === JSON.stringify(valueOk ?? null)) continue;
            next[id] = { ...c, signedAt: d.signedAt, signedBy: d.signedBy, valueOk };
            changed = true;
          }
          return changed ? next : cur;
        });
        setSaved(`Saved to ${order?.key || 'the work item'} at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      } catch (e) { setSaved('Not saved: ' + e.message); }
      finally {
        saving.current = false;
        if (pending.current) { pending.current = false; setSaveTick((x) => x + 1); }
      }
    }, 500);
    return () => clearTimeout(t);
  }, [decisions, res, markDecisions, print, sheets, aside, saveTick]);

  const flyTo = useCallback((c) => {
    if (!stageRef.current || !c) return;
    const r = stageRef.current.getBoundingClientRect();
    const bw = c.x1 - c.x0 + 160, bh = c.y1 - c.y0 + 160;
    const s = Math.min(3.2, Math.min(r.width / bw, r.height / bh));
    const target = { s, x: r.width / 2 - ((c.x0 + c.x1) / 2) * s, y: r.height / 2 - ((c.y0 + c.y1) / 2) * s };
    animateCam(camRef.current, target, setCam);
  }, []);

  const select = (c) => { setSel(c.id); flyTo(c); };

  // Opened from the issue panel on one change (or one sheet): turn to its sheet, then fly to it.
  const focusRef = useRef(undefined);
  useEffect(() => { getFocus().then((f) => { focusRef.current = f; }).catch(() => {}); }, []);
  useEffect(() => {
    const f = focusRef.current;
    if (!f || phase !== 'ready' || !res) return;
    if ((f.sheet || 1) !== res.sheet) { if (!turning && f.sheet <= sheets.count) goSheet(f.sheet); return; }
    focusRef.current = null;
    const c = f.id && res.clouds.find((x) => x.id === f.id);
    if (c) select(c);
  }, [phase, res]);
  const decide = (id, patch) => { if (!readOnly) setDecisions((d) => ({ ...d, [id]: { ...d[id], ...patch } })); };
  const signOff = (id) => decide(id, { signedBy: order.user.displayName, signedAt: new Date().toISOString() });
  // a reviewer who disagrees with the engine counts a set-aside difference back in: it becomes a change
  // like any other, open until it is declared or accepted and signed
  const countBack = (a) => {
    if (readOnly) return;
    const n = a.sheet, num = Math.max(0, ...(sheets.compared[n] || []).map((c) => c.n)) + 1;
    const c = { id: `s${n}-b${a.id.split('-a')[1]}`, n: num, sheet: n, x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1, zone: a.zone, kind: a.kind === 'added' || a.kind === 'removed' ? a.kind : 'changed', countedBack: true };
    setAside((x) => ({ ...x, [n]: (x[n] || []).filter((y) => y.id !== a.id) }));
    setSheets((x) => ({ ...x, compared: { ...x.compared, [n]: [...(x.compared[n] || []), c] } }));
    setRes((r) => (r.sheet === n ? { ...r, clouds: [...r.clouds, c] } : r));
    setDecisions((d) => ({ ...d, [c.id]: { status: 'open' } }));
    select(c);
  };

  // Keyboard: arrows walk the clouds, digits declare against a note line, S signs off, F fits the sheet.
  useEffect(() => {
    const onKey = (e) => {
      // shortcuts never fire with a modifier (Ctrl+S stays the browser's) or inside a form control
      if (!res || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('select, textarea, input')) return;
      const list = res.clouds, i = list.findIndex((c) => c.id === sel);
      if (list.length && (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'j')) { select(list[(i + 1) % list.length]); e.preventDefault(); }
      if (list.length && (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'k')) { select(list[i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length]); e.preventDefault(); }
      if (e.key.toLowerCase() === 'f') fit();
      // digits and S act on a change (never on a pen markup); declaring against another note clears a signature
      const c = sel && allClouds.find((x) => x.id === sel);
      if (!c) return;
      const d = decisions[sel] || {};
      if (/^[1-9]$/.test(e.key) && order.notes.some((n) => n.n === +e.key) && !(d.status === 'declared' && d.note === +e.key)) decide(sel, { status: 'declared', note: +e.key, signedBy: null, signedAt: null, valueOk: null });
      if (e.key.toLowerCase() === 's' && (d.status === 'declared' || d.status === 'accepted') && !d.signedBy) {
        if (!(d.status === 'declared' && !d.valueOk && valueSlip(c, order.notes.find((n) => n.n === d.note)?.text).length)) signOff(sel);
      }
    };
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey);
  });

  function fit() {
    const r = stageRef.current.getBoundingClientRect();
    const s = Math.min((r.width - 48) / res.A.w, (r.height - 48) / res.A.h);
    animateCam(camRef.current, { s, x: (r.width - res.A.w * s) / 2, y: (r.height - res.A.h * s) / 2 }, setCam);
  }

  // Pan with drag, zoom around the pointer with the wheel.
  const drag = useRef(null);
  const onPointerDown = (e) => { if (e.target.closest('.rl-swipe-handle')) return; drag.current = { x: e.clientX, y: e.clientY, cam: camRef.current }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onPointerMove = (e) => { const d = drag.current; if (!d) return; setCam({ ...d.cam, x: d.cam.x + e.clientX - d.x, y: d.cam.y + e.clientY - d.y }); };
  const onPointerUp = () => { drag.current = null; };
  const onWheel = (e) => {
    const r = stageRef.current.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const c = camRef.current, s = Math.max(0.15, Math.min(6, c.s * Math.exp(-e.deltaY * 0.0015)));
    setCam({ s, x: px - ((px - c.x) / c.s) * s, y: py - ((py - c.y) / c.s) * s });
  };

  if (error) return <Shell order={order}><div className="rl-empty"><h2>Redline can't compare this change order yet</h2><p>{error}</p></div></Shell>;
  if (!res) return <Shell order={order}><Warmup stage={stage} /></Shell>;

  const { A } = res;
  const shown = mode === 'blink' ? (blinkOn ? 'b' : 'a') : mode;
  const lit = phase !== 'dark';

  return (
    <Shell order={order} gate={gate} revs={[res.revA, res.revB]} saved={saved}>
      <div className="rl-body">
        <section className="rl-table" aria-label="Light table">
          <div className="rl-modes" role="tablist" aria-label="Compare mode">
            {[...MODES, ...(print?.status === 'done' && res.sheet === 1 ? [{ key: 'print', label: 'Marked-up print', hint: 'The phone photo, flattened onto the sheet' }] : [])].map((m) => (
              <button key={m.key} role="tab" aria-selected={mode === m.key} title={m.hint} className={mode === m.key ? 'on' : ''} onClick={() => setMode(m.key)}>{m.label}</button>
            ))}
            <span className="rl-legend" aria-hidden={mode !== 'overlay'} data-on={mode === 'overlay'}>
              <i className="sw g" />In both <i className="sw r" />Removed <i className="sw b" />Added
            </span>
            {sheets.count > 1 && (
              <span className="rl-sheets" role="tablist" aria-label="Sheets">
                {Array.from({ length: sheets.count }, (_, i) => i + 1).map((n) => {
                  const c = sheets.compared[n];
                  return <button key={n} role="tab" aria-selected={n === sheet} aria-busy={n === turning} className={`${n === sheet ? 'on' : ''} ${n === turning ? 'busy' : ''} ${c ? (c.length ? 'changed' : 'same') : 'todo'}`} onClick={() => goSheet(n)} aria-label={`Sheet ${n}, ${c ? `${c.length} ${c.length === 1 ? 'change' : 'changes'}` : 'not compared yet'}`}>Sheet {n}{c ? ` (${c.length})` : ''}</button>;
                })}
              </span>
            )}
            <button className="rl-fit" onClick={fit} title="Fit the sheet (F)">Fit sheet</button>
          </div>
          <div className={`rl-stage ${lit ? 'lit' : ''} phase-${phase}`} ref={stageRef}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel}>
            {turning && <div className="rl-turning" role="status"><span>Comparing sheet {turning}: {stage.toLowerCase()}…</span></div>}
            <div className="rl-sheet" style={{ width: A.w, height: A.h, transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})` }}>
              <Layer canvas={shown === 'overlay' ? overlayCanvas : shown === 'b' ? bCanvas : shown === 'print' ? printCanvas : aCanvas} />
              {mode === 'swipe' && (
                <>
                  <div className="rl-swipe-top" style={{ clipPath: `inset(0 0 0 ${swipe * 100}%)` }}><Layer canvas={bCanvas} /></div>
                  <SwipeHandle x={swipe} w={A.w} h={A.h} scale={cam.s} onChange={setSwipe} />
                </>
              )}
              <Zones w={A.w} h={A.h} s={cam.s} />
              <svg className="rl-clouds" width={A.w} height={A.h} viewBox={`0 0 ${A.w} ${A.h}`}>
                {res.clouds.map((c, i) => {
                  const d = decisions[c.id] || {}, state = cloudState(d);
                  return (
                    <g key={c.id} className={`rl-cloud ${state} ${sel === c.id ? 'sel' : ''}`}
                      style={{ '--delay': `${i * stagger(res.clouds.length)}ms` }} onClick={(e) => { e.stopPropagation(); select(c); }}>
                      {d.signedBy && <rect className="hl" x={c.x0 - 8} y={c.y0 - 8} width={c.x1 - c.x0 + 16} height={c.y1 - c.y0 + 16} rx="6" />}
                      <path d={cloudPath(c.x0, c.y0, c.x1, c.y1, Math.max(8, 9 / cam.s), Math.max(7, Math.min(40, 8 / cam.s)))} pathLength="1" />
                      <g className="tag" transform={`translate(${c.x1 + 9 / cam.s},${c.y0 - 9 / cam.s}) scale(${Math.min(2.5, 1 / cam.s)})`}>
                        <path d="M0,-15 L15,11 L-15,11 Z" />
                        <text y="7" textAnchor="middle">{c.n}</text>
                      </g>
                    </g>
                  );
                })}
                {showAside && (aside[res.sheet] || []).map((a) => (
                  <rect key={a.id} className="rl-aside" x={a.x0 - 6} y={a.y0 - 6} width={a.x1 - a.x0 + 12} height={a.y1 - a.y0 + 12} rx="4" />
                ))}
                {res.sheet === 1 && marks.map((m, i) => {
                  const d = markDecisions[m.id] || {};
                  return (
                    <g key={m.id} className={`rl-mark ${d.status || 'open'} ${sel === m.id ? 'sel' : ''}`} style={{ '--delay': `${i * 220}ms` }}
                      onClick={(e) => { e.stopPropagation(); select(m); }}>
                      <ellipse cx={(m.x0 + m.x1) / 2} cy={(m.y0 + m.y1) / 2} rx={(m.x1 - m.x0) / 2 + 14 / cam.s} ry={(m.y1 - m.y0) / 2 + 12 / cam.s} pathLength="1" />
                      <g className="tag" transform={`translate(${m.x0 - 6 / cam.s},${m.y0 - 6 / cam.s}) scale(${Math.min(2.5, 1 / cam.s)})`}>
                        <circle r="13" /><text y="5" textAnchor="middle">P{m.n}</text>
                      </g>
                    </g>
                  );
                })}
              </svg>
            </div>
            {flatten && (
              <img className="rl-flatten" src={flatten.url} alt="" aria-hidden="true" width={flatten.w} height={flatten.h}
                style={{ transform: quadMatrix(flatten.src, flatten.from.map((p, i) => [p[0] + (flatten.to[i][0] - p[0]) * flatten.t, p[1] + (flatten.to[i][1] - p[1]) * flatten.t])),
                  opacity: flatten.t >= 1 ? 0 : 1 }} />
            )}
            <div className="rl-sweep" aria-hidden="true" />
            <Zoom cam={cam} />
          </div>
        </section>
        <Ledger res={res} order={order} decisions={decisions} sel={sel} phase={phase} gate={gate}
          sheet={sheet} sheets={sheets} allClouds={allClouds} onSheet={goSheet}
          onSelect={select} onDecide={decide} onSign={signOff}
          print={print} marks={marks} markDecisions={markDecisions} onReadPhoto={readPhoto} onAddPhoto={addPhoto}
          onDecideMark={decideMark} onRaiseMark={raiseMark}
          onSetAside={(att) => { if (!readOnly) setPrint({ att, status: 'aside' }); }}
          aside={aside} showAside={showAside} onShowAside={setShowAside} onCountBack={countBack} />
      </div>
    </Shell>
  );
}

// Does the drawing say what the change note says? The numbers that are new in revision B's text must all
// appear in the note the change is declared in. A slip ("note says Ø25.5, drawing says Ø25.6") holds the
// release until someone confirms the drawing is right or sends it back.
function ValueCheck({ c, d, note, onDecide }) {
  if (!c.values?.length || !note) return null;
  const slip = valueSlip(c, note.text);
  if (!slip.length) return <p className="rl-value ok">Values match note {note.n}: {c.values.join(', ')}</p>;
  if (d.valueOk) return <p className="rl-value ok">Drawing value {slip.join(', ')} confirmed against note {note.n} by {d.valueOk.by}</p>;
  return (
    <div className="rl-value slip" role="alert">
      <p><b>Drawing says {slip.join(', ')}; note {note.n} does not.</b> Note {note.n}: “{note.text}”</p>
      <div className="rl-choices">
        <button className="rl-btn" onClick={() => onDecide(c.id, { valueOk: { by: 'you', at: new Date().toISOString() } })}>The drawing is right</button>
        <button className="rl-btn danger" onClick={() => onDecide(c.id, { status: 'rejected', note: null })}>Send back</button>
      </div>
    </div>
  );
}

function cloudState(d) {
  if (d.status === 'rejected') return 'rejected';
  if (d.status === 'declared' || d.status === 'accepted') return d.signedBy ? 'signed' : 'declared';
  return 'undeclared';
}

export { gateOf };

// A JPEG of one markup cut from the flattened photo, attached to the work item raised for it.
function cropJpeg(flat, m) {
  const pad = 40, x = Math.max(0, Math.floor(m.x0 - pad)), y = Math.max(0, Math.floor(m.y0 - pad));
  const w = Math.min(flat.width - x, Math.ceil(m.x1 - m.x0 + 2 * pad)), h = Math.min(flat.height - y, Math.ceil(m.y1 - m.y0 + 2 * pad));
  const c = document.createElement('canvas'); c.width = w * 2; c.height = h * 2;
  const src = document.createElement('canvas'); src.width = flat.width; src.height = flat.height; src.getContext('2d').putImageData(flat, 0, 0);
  c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w * 2, h * 2);
  return c.toDataURL('image/jpeg', 0.88).split(',')[1];
}

function Shell({ order, gate, revs, saved, children }) {
  return (
    <div className="rl-app">
      <header className="rl-head">
        <div className="rl-title">
          <span className="rl-key">{order?.key || ''}</span>
          <h1>{order?.summary || 'Redline'}</h1>
          {revs && !/\brev\b/i.test(order?.summary || '') && <span className="rl-revs"><b>{revName(revs[0])}</b><span aria-hidden="true"> to </span><b className="b">{revName(revs[1])}</b></span>}
        </div>
        {gate && (
          <div className={`rl-gate ${gate.blocked ? 'blocked' : 'clear'}`} role="status">
            <span className="dot" aria-hidden="true" />
            <span><b>{gate.blocked ? 'Release blocked' : 'Ready to release'}</b>
              {gate.reasons?.length ? (
                <span className="rl-reasons" title={gate.text}>{gate.reasons.map((r) => <span key={r.kind} className={`rl-reason ${r.kind}`}>{r.short}</span>)}</span>
              ) : gate.text}
            </span>
          </div>
        )}
        <span className="rl-saved" aria-live="polite">{saved}</span>
        <button className="rl-close" onClick={closeModal} aria-label="Close the light table">Close</button>
      </header>
      {children}
    </div>
  );
}

const revName = (a) => (a.filename.match(/rev[-_ ]?([A-Z0-9]+)/i)?.[1] ? 'Rev ' + a.filename.match(/rev[-_ ]?([A-Z0-9]+)/i)[1].toUpperCase() : a.filename);

function Warmup({ stage }) {
  return (
    <div className="rl-warm">
      <div className="rl-warm-sheet"><div className="rl-warm-bar" /></div>
      <p>{stage}…</p>
    </div>
  );
}

function Layer({ canvas }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current; if (!el || !canvas) return;
    el.width = canvas.width; el.height = canvas.height;
    el.getContext('2d').drawImage(canvas, 0, 0);
  }, [canvas]);
  return <canvas ref={ref} className="rl-layer" />;
}

function SwipeHandle({ x, w, h, scale, onChange }) {
  const onDown = (e) => {
    e.stopPropagation();
    const sheet = e.currentTarget.parentElement, rect = () => sheet.getBoundingClientRect();
    const move = (ev) => onChange(Math.max(0, Math.min(1, (ev.clientX - rect().left) / rect().width)));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  return (
    <div className="rl-swipe-handle" style={{ left: x * w, height: h, '--inv': 1 / scale }} onPointerDown={onDown}
      role="slider" aria-label="Swipe between revisions" aria-valuenow={Math.round(x * 100)} tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'ArrowLeft') onChange(Math.max(0, x - 0.05)); if (e.key === 'ArrowRight') onChange(Math.min(1, x + 0.05)); }}>
      <span>A</span><span>B</span>
    </div>
  );
}

// Zone ruler around the sheet, as printed in the border of a drawing: columns 8 to 1 from left to
// right, rows A upward from the bottom. Clouds and change notes both speak in these zones.
function Zones({ w, h, s }) {
  const k = 1 / s, cols = [...Array(ZONE_COLS)].map((_, i) => ZONE_COLS - i), rows = [...Array(ZONE_ROWS)].map((_, i) => String.fromCharCode(65 + ZONE_ROWS - 1 - i));
  return (
    <svg className="rl-zones" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {cols.map((c, i) => (
        <g key={c} style={{ fontSize: 12 * k }}>
          {i > 0 && <line x1={(i * w) / ZONE_COLS} x2={(i * w) / ZONE_COLS} y1={-14 * k} y2={-4 * k} />}
          {i > 0 && <line x1={(i * w) / ZONE_COLS} x2={(i * w) / ZONE_COLS} y1={h + 4 * k} y2={h + 14 * k} />}
          <text x={((i + 0.5) * w) / ZONE_COLS} y={-6 * k} textAnchor="middle">{c}</text>
          <text x={((i + 0.5) * w) / ZONE_COLS} y={h + 16 * k} textAnchor="middle">{c}</text>
        </g>
      ))}
      {rows.map((r, i) => (
        <g key={r} style={{ fontSize: 12 * k }}>
          {i > 0 && <line y1={(i * h) / ZONE_ROWS} y2={(i * h) / ZONE_ROWS} x1={-14 * k} x2={-4 * k} />}
          {i > 0 && <line y1={(i * h) / ZONE_ROWS} y2={(i * h) / ZONE_ROWS} x1={w + 4 * k} x2={w + 14 * k} />}
          <text x={-10 * k} y={((i + 0.5) * h) / ZONE_ROWS} textAnchor="middle" dominantBaseline="middle">{r}</text>
          <text x={w + 10 * k} y={((i + 0.5) * h) / ZONE_ROWS} textAnchor="middle" dominantBaseline="middle">{r}</text>
        </g>
      ))}
    </svg>
  );
}

function Zoom({ cam }) {
  return <div className="rl-zoom" aria-hidden="true">{Math.round(cam.s * 100)}%</div>;
}

function Ledger({ res, order, decisions, sel, phase, gate, sheet, sheets, allClouds, onSheet, onSelect, onDecide, onSign, print, marks, markDecisions, onReadPhoto, onAddPhoto, onDecideMark, onRaiseMark, onSetAside, aside, showAside, onShowAside, onCountBack }) {
  const shown = phase === 'ready' ? res.clouds.length : phase === 'clouds' ? res.clouds.length : 0;
  return (
    <aside className={`rl-ledger ${order.canEdit === false ? 'readonly' : ''}`} aria-label="Change ledger">
      {order.canEdit === false && <p className="rl-ro">You can view this review. Only people who can edit {order.key} can declare, accept or sign off changes.</p>}
      <section className="rl-notes">
        <h2>Change notes</h2>
        <ol>
          {order.notes.map((n) => {
            const linked = allClouds.filter((c) => decisions[c.id]?.note === n.n);
            const here = linked.filter((c) => (c.sheet || 1) === sheet);
            const elsewhere = [...new Set(linked.filter((c) => (c.sheet || 1) !== sheet).map((c) => c.sheet))];
            const named = noteSheet(n.text);
            const away = named && named !== sheet && named <= sheets.count && !elsewhere.includes(named);
            return (
              <li key={n.n}>
                <span className="num">{n.n}</span>
                <p>{n.text}</p>
                <span className="links">
                  {here.map((c) => <button key={c.id} className="delta" onClick={() => onSelect(c)} aria-label={`Show change ${c.n}`}>{c.n}</button>)}
                  {elsewhere.map((x) => <button key={x} className="rl-goto" onClick={() => onSheet(x)}>On sheet {x}</button>)}
                  {away && <button className="rl-goto" onClick={() => onSheet(named)}>{sheets.compared[named] ? `Nothing found on sheet ${named}` : `On sheet ${named}, not compared yet`}</button>}
                  {!linked.length && !away && <em>{sheets.count > 1 ? 'No change found on this sheet' : 'No change on the sheet'}</em>}
                </span>
              </li>
            );
          })}
          {!order.notes.length && <li className="none">The work item has no numbered change notes. Number each change in the description, for example "1. Zone D3: bore Ø25 to Ø25.5".</li>}
        </ol>
      </section>
      <NeedsYou res={res} decisions={decisions} marks={marks} markDecisions={markDecisions} sel={sel} onSelect={onSelect} readOnly={order.canEdit === false} />
      <section className="rl-found">
        <h2>Found on the sheet <span>{res.clouds.length}</span></h2>
        <ul>
          {res.clouds.filter((c) => !c.housekeeping).map((c, i) => (
            <CloudRow key={c.id} c={c} i={i} d={decisions[c.id] || {}} notes={order.notes} res={res}
              visible={i < shown} active={sel === c.id} onSelect={onSelect} onDecide={onDecide} onSign={onSign} />
          ))}
        </ul>
        <Housekeeping res={res} decisions={decisions} sel={sel} shown={shown} notes={order.notes} onSelect={onSelect} onDecide={onDecide} onSign={onSign} readOnly={order.canEdit === false} />
        <SetAside list={aside[res.sheet] || []} showing={showAside} onShow={onShowAside} onCountBack={onCountBack} readOnly={order.canEdit === false} />
      </section>
      <PrintSection order={order} res={res} print={print} marks={marks} markDecisions={markDecisions} sel={sel}
        onSelect={onSelect} onReadPhoto={onReadPhoto} onAddPhoto={onAddPhoto} onDecideMark={onDecideMark} onRaiseMark={onRaiseMark} onSetAside={onSetAside} />
      <footer className="rl-foot">
        <p>Compared {res.revA.filename} with {res.revB.filename} in {(res.ms / 1000).toFixed(2)} s: drawn at {res.displayDpi} dpi, compared at {res.dpi} dpi, in your browser. Nothing left Atlassian.</p>
        <p className="keys">Arrows step through changes, 1 to 9 declare against a note, S signs off, F fits the sheet.</p>
      </footer>
    </aside>
  );
}

// Photos of printed sheets marked up in pen on the shop floor. A photo attached from the Jira mobile app
// is read automatically; one can also be taken or chosen here.
function PrintSection({ order, res, print, marks, markDecisions, sel, onSelect, onReadPhoto, onAddPhoto, onDecideMark, onRaiseMark, onSetAside }) {
  const images = order.images || [];
  const fileRef = useRef(null);
  return (
    <section className="rl-prints">
      <h2>Marked-up prints <span>{images.length || ''}</span></h2>
      {print?.status === 'reading' && <p className="rl-reading">Lining the photo up with {revName(res.revB)}…</p>}
      {print?.status === 'error' && (
        <>
          <p className="rl-print-err">{print.error}</p>
          {print.att && <button className="rl-btn rl-print-add" onClick={() => onSetAside(print.att)}>This photo is not a print of the drawing</button>}
        </>
      )}
      {print?.status === 'aside' && <p className="rl-print-meta">{print.att.filename} was set aside: not a print of this drawing.</p>}
      {print?.status === 'done' && (
        <p className="rl-print-meta">{print.att.filename}: {marks.length ? `${marks.length} pen ${marks.length === 1 ? 'markup' : 'markups'} found` : 'no pen markups found'}, lined up with {revName(res.revB)} in {(print.result.ms / 1000).toFixed(1)} s.</p>
      )}
      <ul>
        {marks.map((m, i) => {
          const d = markDecisions[m.id] || {};
          return (
            <li key={m.id} className={`rl-row rl-mrow in ${d.status || 'open'} ${sel === m.id ? 'active' : ''}`} style={{ '--delay': `${i * 220}ms` }}>
              <button className="rl-row-main" onClick={() => onSelect(m)}>
                <span className="pen">P{m.n}</span>
                <span className="what"><b>Zone {m.zone}</b>Pen markup on the print</span>
                <MarkCrop flat={print.result.flat} m={m} />
              </button>
              <div className="rl-row-act">
                {d.status === 'raised' ? <p className="st">Raised as <b>{d.key}</b> by {d.by}. <button className="link" onClick={() => onDecideMark(m.id, { status: 'open' })}>Undo</button></p>
                  : d.status === 'covered' ? <p className="st">Covered by change {d.cloud}. <button className="link" onClick={() => onDecideMark(m.id, { status: 'open' })}>Undo</button></p>
                  : d.status === 'dismissed' ? <p className="st">Dismissed: not a drawing change. <button className="link" onClick={() => onDecideMark(m.id, { status: 'open' })}>Undo</button></p>
                  : (
                    <>
                      <p className="st warn">Needs an answer{d.error ? `: ${d.error}` : ''}</p>
                      {(() => {
                        const hit = res.clouds.find((c) => c.x0 <= m.x1 && m.x0 <= c.x1 && c.y0 <= m.y1 && m.y0 <= c.y1);
                        return hit && <p className="suggest">Drawn on change {hit.n}. <button className="link" onClick={() => onDecideMark(m.id, { status: 'covered', cloud: hit.n })}>Mark as covered by change {hit.n}</button></p>;
                      })()}
                      <div className="rl-choices">
                        <button className="rl-btn primary" disabled={d.status === 'raising'} onClick={() => onRaiseMark(m)}>{d.status === 'raising' ? 'Raising…' : 'Raise as work item'}</button>
                        {res.clouds.length > 0 && (
                          <select aria-label={`Markup P${m.n} is covered by a change`} value="" onChange={(e) => e.target.value && onDecideMark(m.id, { status: 'covered', cloud: +e.target.value })}>
                            <option value="">Covered by change…</option>
                            {res.clouds.map((c) => <option key={c.id} value={c.n}>Change {c.n}, zone {c.zone}</option>)}
                          </select>
                        )}
                        <button className="rl-btn" onClick={() => onDecideMark(m.id, { status: 'dismissed' })}>Dismiss</button>
                      </div>
                    </>
                  )}
              </div>
            </li>
          );
        })}
      </ul>
      {images.length > 1 && (
        <div className="rl-photos">
          {images.map((a) => <button key={a.id} className={`rl-btn ${print?.att?.id === a.id ? 'on' : ''}`} onClick={() => onReadPhoto(a)}>{a.filename}</button>)}
        </div>
      )}
      {!images.length && <p className="rl-hint">Photograph the printed sheet with its pen markups and attach the photo to this work item from the Jira mobile app, or add it here. Redline lines it up with {revName(res.revB)} and lists every markup.</p>}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => e.target.files[0] && onAddPhoto(e.target.files[0])} />
      <button className="rl-btn rl-print-add" onClick={() => fileRef.current.click()}>Add a photo of a marked-up print</button>
    </section>
  );
}

function MarkCrop({ flat, m }) {
  const ref = useRef(null);
  useEffect(() => {
    const pad = 16, x = Math.max(0, Math.floor(m.x0 - pad)), y = Math.max(0, Math.floor(m.y0 - pad));
    const w = Math.min(flat.width - x, Math.ceil(m.x1 - m.x0 + 2 * pad)), h = Math.min(flat.height - y, Math.ceil(m.y1 - m.y0 + 2 * pad));
    const el = ref.current, H = 46, W = Math.max(40, Math.min(160, Math.round((w / h) * H)));
    el.width = W; el.height = H;
    const src = document.createElement('canvas'); src.width = flat.width; src.height = flat.height; src.getContext('2d').putImageData(flat, 0, 0);
    el.getContext('2d').drawImage(src, x, y, w, h, 0, 0, W, H);
  }, [flat, m]);
  return <canvas ref={ref} className="rl-crop" role="img" aria-label="The markup on the print" />;
}

// Sticky at the top of the ledger: how many things still need a person, and a button to the next one.
// "3 changes, 1 pen markup": what the outstanding items are, so the count is never a mystery
function whatOf(todo, marks) {
  const m = todo.filter((x) => marks.includes(x)).length, c = todo.length - m;
  return [c && `${c} ${c === 1 ? 'change' : 'changes'}`, m && `${m} pen ${m === 1 ? 'markup' : 'markups'}`].filter(Boolean).join(', ');
}

function NeedsYou({ res, decisions, marks, markDecisions, sel, onSelect, readOnly }) {
  const todo = [
    ...res.clouds.filter((c) => { const d = decisions[c.id] || {}; return d.status === 'rejected' ? false : !(d.status === 'declared' || d.status === 'accepted') || !d.signedBy; }),
    ...marks.filter((m) => !['raised', 'covered', 'dismissed'].includes(markDecisions[m.id]?.status)),
  ];
  const total = res.clouds.length + marks.length;
  if (!total) return null;
  const i = todo.findIndex((x) => x.id === sel);
  const next = todo[(i + 1) % todo.length];
  return (
    <div className={`rl-needs ${todo.length ? '' : 'done'}`}>
      <p>{todo.length ? <><b>{todo.length} of {total}</b> {readOnly ? (todo.length === 1 ? 'needs a decision' : 'need a decision') : 'need you'}<span className="what">{whatOf(todo, marks)}</span></> : <><b>All {total}</b> answered</>}</p>
      {todo.length > 0 && <button className="rl-btn primary" onClick={() => onSelect(next)}>{readOnly ? (i === -1 ? 'Step through' : 'Next') : (i === -1 ? 'Start' : 'Next')}</button>}
    </div>
  );
}

// the clouds draw in one after another, but the whole sequence never takes more than about two seconds
const stagger = (n) => Math.min(260, Math.round(2000 / Math.max(1, n)));

// Earlier decisions for this sheet, matched to today's changes by where they are (shared/review.mjs: at
// least half of the smaller box, each earlier change used once). Decisions on other sheets are kept as
// they are; ones whose change is gone are dropped. The backend applies the same rule when it saves.
function priorDecisions(review, clouds, sheetNo) {
  const others = {}, out = {}, saved = review.decisions || {};
  for (const [id, d] of Object.entries(saved)) if (!id.startsWith(`s${sheetNo}-`)) others[id] = d;
  const old = (review.clouds || []).filter((c) => (c.sheet || 1) === sheetNo && saved[c.id]).map((c) => ({ ...c, sheet: sheetNo, box: c.box || [c.x0, c.y0, c.x1, c.y1] }));
  const match = matchChanges(old, clouds.map((c) => ({ id: c.id, sheet: sheetNo, box: [c.x0, c.y0, c.x1, c.y1] })));
  for (const [nid, oid] of Object.entries(match)) out[nid] = saved[oid];
  return { others, mine: out };
}

// What the engine set aside: line work that a re-export nudged by under 0.7 mm and that matches once
// shifted. Not counted as changes, but never hidden: each one can be shown on the sheet and counted back in.
function SetAside({ list, showing, onShow, onCountBack, readOnly }) {
  const [open, setOpen] = useState(false);
  if (!list.length) return null;
  return (
    <div className="rl-house aside">
      <button className="rl-house-head" onClick={() => { setOpen(!open); onShow(!open); }} aria-expanded={open}>
        <span><b>Set aside</b> {list.length} re-plot {list.length === 1 ? 'shift' : 'shifts'}: line work nudged by under 0.7 mm, the same once lined up</span>
        <span className="rl-house-state">{showing ? 'Shown on the sheet' : 'Show'}</span>
      </button>
      {open && (
        <ul>
          {list.map((a) => (
            <li key={a.id} className="rl-aside-row">
              <span>Zone {a.zone}<em>matches at {(a.match * 100).toFixed(1)}%</em></span>
              {!readOnly && <button className="rl-btn quiet" onClick={() => onCountBack(a)}>Count it as a change</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Housekeeping: labels nudged without changing and plot stamps (date, file, tool version) from a re-export.
// Real differences, so they still need an answer, but one click accepts and signs them all.
function Housekeeping({ res, decisions, sel, shown, notes, onSelect, onDecide, onSign, readOnly }) {
  const list = res.clouds.filter((c) => c.housekeeping);
  const [open, setOpen] = useState(false);
  if (!list.length) return null;
  // bulk accept only touches changes nobody has answered yet (never one sent back or declared), and only
  // once the list has been opened, so nothing is signed unseen
  const todo = list.filter((c) => { const d = decisions[c.id] || {}; return !d.signedBy && (!d.status || d.status === 'open'); });
  const unanswered = list.filter((c) => !(decisions[c.id]?.signedBy)).length;
  return (
    <div className="rl-house">
      <button className="rl-house-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span><b>Housekeeping</b> {list.length} {list.length === 1 ? 'difference' : 'differences'}: {list.filter((c) => c.housekeeping === 'stamp').length} plot stamp, {list.filter((c) => c.housekeeping === 'textMove').length} moved labels</span>
        <span className="rl-house-state">{unanswered ? `${unanswered} to answer` : 'All answered'}</span>
      </button>
      {todo.length > 0 && !readOnly && (open
        ? <button className="rl-btn" onClick={() => { for (const c of todo) { onDecide(c.id, { status: 'accepted', note: null }); onSign(c.id); } }}>Accept and sign off the {todo.length} still open</button>
        : <button className="rl-btn" onClick={() => setOpen(true)}>Look them over to sign them together</button>)}
      {open && (
        <ul>
          {list.map((c, i) => (
            <CloudRow key={c.id} c={c} i={i} d={decisions[c.id] || {}} notes={notes} res={res}
              visible={true} active={sel === c.id} onSelect={onSelect} onDecide={onDecide} onSign={onSign} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CloudRow({ c, i, d, notes, res, visible, active, onSelect, onDecide, onSign }) {
  const state = cloudState(d);
  // the selected change scrolls into view in the ledger, wherever it was selected from
  const rowRef = useRef(null);
  // (after layout, and again once the row has faded in, so opening the light table on a change lands on it)
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => rowRef.current?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' }), 60);
    return () => clearTimeout(t);
  }, [active, visible]);
  if (state === 'signed' && !active) {
    return (
      <li ref={rowRef} className={`rl-row signed compact ${visible ? 'in' : ''}`} style={{ '--delay': `${i * stagger(res.clouds.length)}ms` }}>
        <button className="rl-row-main" onClick={() => onSelect(c)}>
          <span className="delta">{c.n}</span>
          <span className="what"><b>{c.kind?.startsWith("sheet") ? "Whole sheet" : `Zone ${c.zone}`}</b>{d.status === 'declared' ? `Note ${d.note}` : 'Accepted'}, signed by {d.signedBy}</span>
        </button>
      </li>
    );
  }
  return (
    <li ref={rowRef} className={`rl-row ${state} ${active ? 'active' : ''} ${visible ? 'in' : ''}`} style={{ '--delay': `${i * stagger(res.clouds.length)}ms` }}>
      <button className="rl-row-main" onClick={() => onSelect(c)}>
        <span className="delta">{c.n}</span>
        <span className="what"><b>{c.kind?.startsWith("sheet") ? "Whole sheet" : `Zone ${c.zone}`}</b>{kindText(c)}</span>
        <Crop res={res} c={c} />
      </button>
      {(c.before || c.after) && (
        <p className="rl-text">
          {!c.before ? <>New text <span className="new">{c.after}</span></>
            : !c.after ? <>Text removed <span className="old">{c.before}</span></>
            : <><span className="old">{c.before}</span><span aria-hidden="true"> → </span><span className="sr">changes to </span><span className="new">{c.after}</span></>}
        </p>
      )}
      <div className="rl-row-act">
        {state === 'rejected' ? (
          <p className="st">Sent back to the drafter. <button className="link" onClick={() => onDecide(c.id, { status: 'open', note: null })}>Undo</button></p>
        ) : d.status === 'declared' || d.status === 'accepted' ? (
          <>
            <p className="st">{d.status === 'declared' ? (notes.some((n) => n.n === d.note) ? <>Declared in note {d.note}</> : <>Declared in note {d.note}, which is no longer in the change notes. Declare it again.</>) : <>Accepted as a drawing correction</>}
              {' '}<button className="link" onClick={() => onDecide(c.id, { status: 'open', note: null, signedBy: null, signedAt: null, valueOk: null })}>Change</button></p>
            {d.status === 'declared' && <ValueCheck c={c} d={d} note={notes.find((n) => n.n === d.note)} onDecide={onDecide} />}
            {d.signedBy ? <p className="signed">Signed off by {d.signedBy}, {new Date(d.signedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
              : (d.status === 'declared' && (!notes.some((n) => n.n === d.note) || (!d.valueOk && valueSlip(c, notes.find((n) => n.n === d.note)?.text).length))) ? null
              : <button className="rl-btn primary" onClick={() => onSign(c.id)}>Sign off</button>}
          </>
        ) : (
          <>
            <p className="st warn">Not in the change notes</p>
            {c.suggest && <p className="suggest">Near note {c.suggest}. <button className="link" onClick={() => onDecide(c.id, { status: 'declared', note: c.suggest })}>Declare in note {c.suggest}</button></p>}
            <div className="rl-choices">
              <select aria-label={`Declare change ${c.n} in a note`} value="" onChange={(e) => e.target.value && onDecide(c.id, { status: 'declared', note: +e.target.value })}>
                <option value="">Declare in note…</option>
                {notes.map((n) => <option key={n.n} value={n.n}>Note {n.n}</option>)}
              </select>
              <button className="rl-btn" onClick={() => onDecide(c.id, { status: 'accepted', note: null })}>Accept as correction</button>
              <button className="rl-btn danger" onClick={() => onDecide(c.id, { status: 'rejected', note: null })}>Send back</button>
            </div>
          </>
        )}
      </div>
    </li>
  );
}

// Before/after crops of one change, so a reviewer can decide from the ledger without hunting the sheet.
function Crop({ res, c }) {
  const ref = useRef(null);
  useEffect(() => {
    const pad = 24, x = Math.max(0, c.x0 - pad), y = Math.max(0, c.y0 - pad);
    const w = Math.min(res.A.w - x, c.x1 - c.x0 + 2 * pad), h = Math.min(res.A.h - y, c.y1 - c.y0 + 2 * pad);
    const el = ref.current, H = 46, W = Math.max(40, Math.min(92, Math.round((w / h) * H)));
    el.width = W * 2 + 6; el.height = H;
    const ctx = el.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, el.width, H);
    for (const [img, ox, tint] of [[res.A, 0, [43, 47, 54]], [res.Bw, W + 6, [44, 74, 154]]]) {
      const sub = new ImageData(w, h);
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const k = 1 - img.data[(y + yy) * img.w + x + xx] / 255, j = (yy * w + xx) * 4;
        sub.data[j] = 255 - k * (255 - tint[0]); sub.data[j + 1] = 255 - k * (255 - tint[1]); sub.data[j + 2] = 255 - k * (255 - tint[2]); sub.data[j + 3] = 255;
      }
      const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h; tmp.getContext('2d').putImageData(sub, 0, 0);
      ctx.drawImage(tmp, ox, 0, W, H);
    }
  }, [res, c]);
  return <canvas ref={ref} className="rl-crop" aria-label="Before and after" role="img" />;
}

function animateCam(from, to, set) {
  if (reduceMotion) { set(to); return; }
  const t0 = performance.now(), dur = 520;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const step = (now) => {
    const t = Math.min(1, (now - t0) / dur), k = ease(t);
    const s = Math.exp(Math.log(from.s) + (Math.log(to.s) - Math.log(from.s)) * k);
    set({ s, x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
