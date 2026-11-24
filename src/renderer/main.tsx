import '@patternfly/patternfly/patternfly.css';
import '@patternfly/patternfly/patternfly-addons.css';
import './app.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { followSystem } from './theme';

followSystem();
// The desktop app: one scroll container per view, and text selection only
// where there is something to copy (app.css). Ctrl+A (Cmd+A) selects the
// text of the field it is typed in, never the whole window.
if ((window as unknown as { imager?: { platform?: string } }).imager?.platform !== 'web') {
  document.documentElement.classList.add('desktop');
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a') {
      const t = e.target as HTMLElement | null;
      const editable = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (!editable) e.preventDefault();
    }
  }, true);
}
createRoot(document.getElementById('root')!).render(<App />);
