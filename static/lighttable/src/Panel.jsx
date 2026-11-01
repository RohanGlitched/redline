// The issue panel: the release gate in one sentence, the changes by zone, and the way into the light table.
import { useEffect, useState } from 'react';
import { invoke, openLightTable, getContext } from './bridge.js';
import { gateOf } from './LightTable.jsx';

export default function Panel() {
  const [o, setO] = useState(null);
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = () => invoke('getChangeOrder').then(setO).catch((e) => setErr(e.message));

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

  async function open() {
    const ctx = await getContext();
    await openLightTable(ctx);
    load(); // the light table saved its review; refresh the summary
  }

  if (err) return <div className="rl-panel"><p className="err">Redline could not read this work item: {err}</p></div>;
  if (!o) return <div className="rl-panel"><div className="sk" /><div className="sk short" /></div>;

  const pdfs = o.attachments;
  const r = o.review && pdfs.length >= 2 && o.review.revB?.id === pdfs[pdfs.length - 1].id ? o.review : null;
  if (pdfs.length < 2) {
    return (
      <div className="rl-panel">
        <div className="rl-panel-gate new">
          <span className="dot" aria-hidden="true" />
          <div>
            <p className="lead">Attach two PDF revisions of the drawing, the earlier one first</p>
            <p className="sub">Redline lines them up, clouds every change, and checks each one against the numbered change notes in the description, such as "1. Zone D2: bore Ø25 to Ø25.5".</p>
          </div>
          <button className="rl-btn" disabled={adding} onClick={addSample}>{adding ? 'Adding sample…' : 'Add a sample change order'}</button>
        </div>
      </div>
    );
  }
  const gate = r ? gateOf(r.clouds, r.decisions) : null;
  return (
    <div className="rl-panel">
      <div className={`rl-panel-gate ${!gate ? 'new' : gate.blocked ? 'blocked' : 'clear'}`}>
        <span className="dot" aria-hidden="true" />
        <div>
          <p className="lead">{!gate ? 'Not compared yet' : gate.blocked ? 'Release blocked' : 'Ready to release'}</p>
          <p className="sub">{!gate ? `${pdfs[pdfs.length - 2].filename} and ${pdfs[pdfs.length - 1].filename} are attached.` : gate.text}</p>
        </div>
        <button className="rl-btn primary" onClick={open}>{gate ? 'Open light table' : 'Compare revisions'}</button>
      </div>
      {r && (
        <ul className="rl-panel-list">
          {r.clouds.map((c) => {
            const d = r.decisions[c.id] || {};
            const label = d.status === 'rejected' ? 'Sent back' : d.status === 'declared' ? `Note ${d.note}` : d.status === 'accepted' ? 'Accepted' : 'Not in notes';
            return (
              <li key={c.id} className={d.status === 'declared' || d.status === 'accepted' ? (d.signedBy ? 'signed' : 'declared') : d.status === 'rejected' ? 'rejected' : 'undeclared'}>
                <span className="delta">{c.n}</span><span>Zone {c.zone}</span><span className="lab">{label}</span><span className="who">{d.signedBy ? `Signed, ${d.signedBy}` : ''}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
