// Entry of the web build: the same page as the desktop app, with
// window.imager provided by the browser instead of Electron's preload.
import { webApi } from './api';

(window as unknown as { imager: typeof webApi }).imager = webApi;
await import('../renderer/main');
