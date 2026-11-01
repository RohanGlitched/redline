import { createRoot } from 'react-dom/client';
import { getContext, enableTheme } from './bridge.js';
import LightTable from './LightTable.jsx';
import Panel from './Panel.jsx';
import Gadget from './Gadget.jsx';
import './styles.css';
import { Component } from 'react';

// If anything fails while drawing, say so plainly instead of leaving an empty frame.
class Boundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, font: '14px system-ui, sans-serif' }} role="alert">
        <p><b>{this.props.name} ran into a problem drawing this view.</b></p>
        <p>{String(this.state.error.message || this.state.error)}</p>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

// One bundle serves every surface: the issue panel, the full-screen light table modal and the dashboard gadget.
(async () => {
  await enableTheme().catch(() => {});
  const ctx = await getContext();
  const isTable = ctx.extension?.modal?.mode === 'lighttable' || ctx.moduleKey === 'redline-lighttable';
  const isGadget = ctx.moduleKey === 'redline-gadget';
  document.documentElement.dataset.surface = isTable ? 'table' : isGadget ? 'gadget' : 'panel';
  createRoot(document.getElementById('root')).render(<Boundary name="Redline">{isTable ? <LightTable /> : isGadget ? <Gadget /> : <Panel />}</Boundary>);
})();
