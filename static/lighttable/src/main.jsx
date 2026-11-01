import { createRoot } from 'react-dom/client';
import { getContext, enableTheme } from './bridge.js';
import LightTable from './LightTable.jsx';
import Panel from './Panel.jsx';
import './styles.css';

// One bundle serves both surfaces: the compact issue panel and the full-screen light table modal.
(async () => {
  await enableTheme().catch(() => {});
  const ctx = await getContext();
  const isTable = ctx.extension?.modal?.mode === 'lighttable' || ctx.moduleKey === 'redline-lighttable';
  document.documentElement.dataset.surface = isTable ? 'table' : 'panel';
  createRoot(document.getElementById('root')).render(isTable ? <LightTable /> : <Panel />);
})();
