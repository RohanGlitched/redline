// The issue panel: the release gate in one sentence, the changes by zone, and the way into the light table.
import { useEffect, useState } from 'react';
import { invoke, openLightTable } from './bridge.js';
import { gateOf, valueSlip, noteSlip, slipOf, valueOkFor, noteKey, revLabel } from '../../../shared/gate.mjs';
import { cloudPath } from './cloud.js';

export default function Panel() {
  const [o, setO] = useState(null);
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = () => invoke('getChangeOrder', { withThumbs: true }).then(setO).catch((e) => setErr(e.message));

  // Two public-domain NIST drawing revisions ship inside the app, so anyone can try Redline on an empty site.
  async function addSample() {
    setAdding(true);
    try {
      const files = await Promise.all(['BRKT-0142_rev-C.pdf', 'BRKT-0142_rev-D.pdf', 'BRKT-0142_rev-D_print-photo.jpg'].map(async (name) => {
        const buf = new Uint8Array(await (await fetch('./samples/' + name)).arrayBuffer());
        let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { name, data: btoa(s), mime: name.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf' };
      }));
      // one file per call: Forge caps what the panel can send to its backend at 500 KB per call
      const notes = [
        'Zone D2: bore callout Ø25 ±0.15 changes to Ø25.5 ±0.15 for the new bearing.',
        'Zone A7: add note "Break all sharp edges 0.2 max".',
      ];
      for (const f of files) await invoke('addSample', { files: [f], notes });
      await load();
    } catch (e) { setErr(e.message); } finally { setAdding(false); }
  }
  useEffect(() => { load(); }, []);

  async function open(focus = null) {
    await openLightTable(focus);
    load(); // the light table saved its review; refresh the summary
  }

  if (err) return <div className="rl-panel"><p className="err">Redline could not read this work item: {err}</p><button className="rl-btn" onClick={() => { setErr(null); load(); }}>Try again</button></div>;
  if (!o) return <div className="rl-panel"><div className="sk" /><div className="sk short" /></div>;

  const pdfs = o.attachments;
  const r = o.review && pdfs.length >= 2 && o.review.revB?.id === pdfs[pdfs.length - 1].id ? o.review : null;
  if (o.drawingConflict) {
    return (
      <div className="rl-panel">
        <div className="rl-panel-gate blocked">
          <span className="dot" aria-hidden="true" />
          <div>
            <p className="lead">Release blocked: {o.drawingConflict} different drawings are attached with revisions</p>
            <p className="sub">Redline compares one drawing per change order. Move each drawing's revisions to its own change order.</p>
          </div>
        </div>
      </div>
    );
  }
  if (pdfs.length < 2) {
    return (
      <div className="rl-panel">
        <div className="rl-panel-gate new">
          <span className="dot" aria-hidden="true" />
          <div>
            <p className="lead">Attach two PDF revisions of the drawing, the earlier one first</p>
            <p className="sub">Redline lines them up, clouds each change it finds, and checks each one against the numbered change notes in the description, such as "1. Zone D2: bore Ø25 to Ø25.5".</p>
          </div>
          {o.canEdit !== false && <button className="rl-btn" disabled={adding} onClick={addSample}>{adding ? 'Adding sample…' : 'Add a sample change order'}</button>}
        </div>
      </div>
    );
  }
  // the verdict the backend recomputed when the review was saved (the same one the release gate uses)
  // the backend's verdict covers what the saved gate cannot see: a newer revision or an unread photo
  const gate = r ? (o.verdict ? { ...o.verdict, blocked: !!o.verdict.blocked } : r.gate ? { ...r.gate, blocked: r.gate.status === 'blocked' } : gateOf(r.clouds, r.decisions))
    // reviewed before, but a newer revision (or photo) has arrived since: say exactly why release waits
    : o.review && o.verdict?.blocked ? { ...o.verdict, blocked: true } : null;
  const multi = (r?.sheets?.count || 1) > 1;
  const thumbs = o.thumbs || [];
  return (
    <div className="rl-panel">
      <div className={`rl-panel-gate ${!gate ? 'new' : gate.blocked ? 'blocked' : 'clear'}`}>
        <span className="dot" aria-hidden="true" />
        <div>
          <p className="lead">{!gate ? 'Not compared yet' : gate.blocked ? 'Release blocked' : 'Ready to release'}</p>
          {gate?.parts?.length > 1
            ? <ul className="sub rl-panel-reasons">{gate.parts.map((p) => <li key={p}>{cap(p)}</li>)}</ul>
            : <p className="sub">{!gate ? `${pdfs[pdfs.length - 2].filename} and ${pdfs[pdfs.length - 1].filename} are attached.` : cap(gate.text)}</p>}
        </div>
        <button className="rl-btn primary" onClick={() => open()}>{gate ? 'Open light table' : 'Compare revisions'}</button>
      </div>
      {r && (
        <div className={`rl-panel-body ${thumbs.length ? '' : 'solo'}`}>
          {thumbs.length > 0 && (
            <div className={`rl-thumbs n${Math.min(thumbs.length, 3)}`}>
              {thumbs.map((t) => (
                <Thumb key={t.sheet} t={t} label={multi ? `Sheet ${t.sheet}` : null} onOpen={() => open({ sheet: t.sheet })}
                  clouds={r.clouds.filter((c) => (c.sheet || 1) === t.sheet)} decisions={r.decisions} notes={o.notes} />
              ))}
            </div>
          )}
          {r.clouds.length > 0 ? (
            <ul className="rl-panel-list">
              {r.clouds.flatMap((c, i) => {
                const d = r.decisions[c.id] || {};
                const sh = c.sheet || 1;
                const head = multi && sh !== (r.clouds[i - 1]?.sheet || 1) || (multi && i === 0)
                  ? [<li key={`h${sh}`} className="sheet-head">Sheet {sh}</li>] : [];
                const slip = d.status === 'declared' && !valueOkFor(d, o.notes?.find((n) => n.n === d.note)) && slipOf(c, o.notes?.find((n) => n.n === d.note)?.text);
                const st = slip ? 'undeclared' : cloudStatus(d);
                const label = c.carried ? (d.status === 'accepted' ? `Fixed (left open on ${revLabel(c.carried.to)})` : d.status === 'rejected' ? 'Sent back again' : `Left open on ${revLabel(c.carried.to)}`) : d.status === 'rejected' ? 'Sent back' : slip ? valueLabel(c, d, o.notes?.find((n) => n.n === d.note)) : d.status === 'declared' ? `Note ${d.note}` : d.status === 'accepted' ? 'Accepted' : c.kind === 'titleBlock' ? 'Title block not updated' : c.housekeeping ? 'Housekeeping' : 'Not in notes';
                return [...head, (
                  <li key={c.id} className={st}>
                    <button onClick={() => open({ id: c.id, sheet: c.sheet || 1 })} aria-label={`Change ${c.n}, zone ${c.zone}: ${label}${d.signedBy ? `, signed off by ${d.signedBy}` : ''}. Open it in the light table`}>
                      <span className="delta">{c.n}</span>
                      <span className="zone">{c.zone}</span>
                      <span className="lab">{label}</span>
                      <span className="who">{d.signedBy && d.status === 'declared' && d.noteText != null && o.notes?.find((n) => n.n === d.note) && noteKey(o.notes.find((n) => n.n === d.note).text) !== d.noteText
                        ? 'Note edited since signed: sign again' : d.signedBy ? `Signed, ${d.signedBy}` : st === 'declared' ? 'Needs sign-off' : ''}</span>
                    </button>
                  </li>
                )];
              })}
            </ul>
          ) : <p className="rl-panel-none">No differences between the revisions.</p>}
        </div>
      )}
      {r?.savedAt && (
        <p className="rl-panel-foot">
          Last saved{o.savedBy ? ` by ${o.savedBy}` : ''} {ago(r.savedAt)}{multi ? `. ${r.sheets.done?.length || 0} of ${r.sheets.count} sheets compared.` : '.'}
        </p>
      )}
    </div>
  );
}

// a declared change whose drawing value its note does not state is drawn as needing attention
const shownStatus = (c, d, notes) => (d.status === 'declared' && !valueOkFor(d, notes?.find((n) => n.n === d.note)) && slipOf(c, notes?.find((n) => n.n === d.note)?.text) ? 'undeclared' : cloudStatus(d));
const cloudStatus = (d) => (d.status === 'rejected' ? 'rejected' : d.status === 'declared' || d.status === 'accepted' ? (d.signedBy ? 'signed' : 'declared') : 'undeclared');

// The same sentence as the light table: what the note says against what the drawing says.
const valueLabel = (c, d, note) => {
  const slip = valueSlip(c, note?.text), promised = noteSlip(c, note?.text);
  return slip.length && promised.length ? `Note ${d.note} says ${promised.join(', ')}; drawing says ${slip.join(', ')}`
    : slip.length ? `Drawing says ${slip.join(', ')}; note ${d.note} does not` : `Note ${d.note} says ${promised.join(', ')}; drawing does not`;
};

// Revision B of one sheet, as a diazo print, with every change clouded in the colour of its decision.
function Thumb({ t, clouds, decisions, notes, label, onOpen }) {
  const k = t.w / 560; // stroke widths in thumbnail pixels
  return (
    <figure className="rl-thumb">
      <button onClick={onOpen} aria-label={`Open ${label || 'the sheet'} in the light table, ${clouds.length} ${clouds.length === 1 ? 'change' : 'changes'}`}>
        <img src={`data:image/jpeg;base64,${t.data}`} alt="" />
        <svg viewBox={`0 0 ${t.w} ${t.h}`} aria-hidden="true">
          {clouds.map((c, i) => {
            const [x0, y0, x1, y1] = c.box;
            // the number tag stays inside the print, even for a change at its edge
            const tx = Math.min(x1 + 16 * k, t.w - 24 * k), ty = Math.max(y0 - 14 * k, 24 * k);
            return (
              <g key={c.id} className={`tc ${shownStatus(c, decisions[c.id] || {}, notes)}`} style={{ '--i': i }}>
                <path d={cloudPath(x0, y0, x1, y1, 14 * k, 12 * k)} strokeWidth={3 * k} pathLength="1" />
                <g transform={`translate(${tx} ${ty}) scale(${k * 1.5})`}>
                  <path d="M0,-15 L15,11 L-15,11 Z" />
                  <text y="6" textAnchor="middle">{c.n}</text>
                </g>
              </g>
            );
          })}
        </svg>
      </button>
      {label && <figcaption>{label}<span>{clouds.length ? `${clouds.length} ${clouds.length === 1 ? 'change' : 'changes'}` : 'No changes'}</span></figcaption>}
    </figure>
  );
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const [n, u] = s < 3600 ? [Math.round(s / 60), 'minute'] : s < 86400 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86400), 'day'];
  return `${n} ${u}${n === 1 ? '' : 's'} ago`;
}
