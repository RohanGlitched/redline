// The dashboard gadget: every change order whose drawing release Redline is holding, with the reason.
import { useEffect, useState } from 'react';
import { invoke, openPath } from './bridge.js';

// "held 3 h", "held 2 days": how long a change order has waited since its review was last saved
function held(iso) {
  const h = Math.max(0, (Date.now() - new Date(iso).getTime()) / 3600e3);
  return h < 1 ? 'held < 1 h' : h < 48 ? `held ${Math.round(h)} h` : `held ${Math.round(h / 24)} days`;
}

export default function Gadget() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { invoke('gadget').then(setD).catch((e) => setErr(e.message)); }, []);

  if (err) return <div className="rl-gadget"><p className="err">Redline could not search change orders: {err}</p></div>;
  if (!d) return <div className="rl-gadget"><div className="sk" /><div className="sk short" /></div>;
  if (d.error) return <div className="rl-gadget"><p className="err">{d.error}</p></div>;

  const total = (d.blocked || 0) + (d.clear || 0);
  return (
    <div className="rl-gadget">
      <div className="rl-gadget-head">
        <p><b className={d.blocked ? 'blocked' : ''}>{d.blocked ?? d.changeOrders.length}</b> held by Redline</p>
        <p><b className="clear">{d.clear ?? 0}</b> ready to release</p>
        {total > 0 && (
          <span className="rl-gadget-bar" aria-hidden="true">
            <span className="blocked" style={{ flex: `${d.blocked || 0} 1 0` }} />
            <span className="clear" style={{ flex: `${d.clear || 0} 1 0` }} />
          </span>
        )}
      </div>
      {d.changeOrders.length ? (
        <ul className="rl-gadget-list">
          {d.changeOrders.map((c) => (
            <li key={c.key}>
              <button onClick={() => openPath(`/browse/${c.key}`)}>
                <span className="key">{c.key}</span>
                {c.since && <span className="age">{held(c.since)}</span>}
                <span className="sum">{c.summary}</span>
                {c.reasons?.length
                  ? <span className="why pills" title={c.gate}>{c.reasons.map((r) => <span key={r.kind} className={`rl-reason ${r.kind}`}>{r.short}</span>)}</span>
                  : <span className="why"><span className="dot" aria-hidden="true" />{c.gate ? c.gate[0].toUpperCase() + c.gate.slice(1) : 'Release blocked'}</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="rl-gadget-none">No change order is held. Change orders appear here once their drawings have been compared in Redline.</p>}
      {d.changeOrders.length > 0 && (
        <button className="rl-goto" onClick={() => openPath(`/issues/?jql=${encodeURIComponent(`key in (${d.changeOrders.map((c) => c.key).join(',')}) ORDER BY updated DESC`)}`)}>Show them in search</button>
      )}
    </div>
  );
}
