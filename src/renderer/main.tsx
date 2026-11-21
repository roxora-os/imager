import '@patternfly/patternfly/patternfly.css';
import '@patternfly/patternfly/patternfly-addons.css';
import './app.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { followSystem } from './theme';
import { I18nProvider } from './i18n';

followSystem();
createRoot(document.getElementById('root')!).render(<I18nProvider><App /></I18nProvider>);
