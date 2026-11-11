// Check GitHub for a newer release of the imager: at most once a day, and
// not at all when turned off in the settings. The app says there is a new
// version and links to its release page; it does not replace itself.

import { app, net } from 'electron';
import { checkDue, newerRelease, type AppRelease } from '../shared/update';
import { loadSettings, saveSettings } from './settings';

export const APP_REPO = 'roxora-os/imager';

export async function checkForUpdate(force = false): Promise<{ version: string; url: string } | null> {
  const s = loadSettings();
  const now = Date.now();
  if (!force && !checkDue(s.updateCheck, s.lastUpdateCheck, now)) return null;
  saveSettings({ ...s, lastUpdateCheck: now });
  try {
    const r = await net.fetch(`https://api.github.com/repos/${APP_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'roxora-imager' },
    });
    if (r.status === 404) return null; // no release yet
    if (!r.ok) return null;
    return newerRelease(app.getVersion(), (await r.json()) as AppRelease);
  } catch {
    return null;
  }
}
