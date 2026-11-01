// The dashboard gadget: every change order whose drawing release Redline is holding, with the reason.
import { useEffect, useState } from 'react';
import { invoke, openPath } from './bridge.js';

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
                <span className="sum">{c.summary}</span>
                <span className="why"><span className="dot" aria-hidden="true" />{c.gate ? c.gate[0].toUpperCase() + c.gate.slice(1) : 'Release blocked'}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="rl-gadget-none">No change order is held. Every reviewed drawing change is declared and signed off.</p>}
      {d.changeOrders.length > 0 && (
        <button className="rl-goto" onClick={() => openPath(`/issues/?jql=${encodeURIComponent('redlineGate = "blocked" ORDER BY updated DESC')}`)}>Show all in search</button>
      )}
    </div>
  );
}
