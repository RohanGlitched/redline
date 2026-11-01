import { createRoot } from 'react-dom/client';
import { getContext, enableTheme } from './bridge.js';
import LightTable from './LightTable.jsx';
import Panel from './Panel.jsx';
import Gadget from './Gadget.jsx';
import './styles.css';

// One bundle serves every surface: the issue panel, the full-screen light table modal and the dashboard gadget.
(async () => {
  await enableTheme().catch(() => {});
  const ctx = await getContext();
  const isTable = ctx.extension?.modal?.mode === 'lighttable' || ctx.moduleKey === 'redline-lighttable';
  const isGadget = ctx.moduleKey === 'redline-gadget';
  document.documentElement.dataset.surface = isTable ? 'table' : isGadget ? 'gadget' : 'panel';
  createRoot(document.getElementById('root')).render(isTable ? <LightTable /> : isGadget ? <Gadget /> : <Panel />);
})();
