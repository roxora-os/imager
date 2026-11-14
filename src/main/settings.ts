// Settings, stored as JSON in the user data folder.
import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppRelease } from '../shared/update';

export interface Settings {
  /** Look for a newer version of the app, at most once a day. */
  updateCheck: boolean;
  /** When the last check ran, ms since the epoch. */
  lastUpdateCheck: number;
  /** Reset the board after a Maskrom write. */
  resetAfterMaskrom: boolean;
  /** Offer beta versions (pre-releases on GitHub) as updates too. */
  betaUpdates: boolean;
  /** The newer release the last check found, repeated at the next start. */
  knownRelease: AppRelease | null;
}

const DEFAULTS: Settings = { updateCheck: true, lastUpdateCheck: 0, resetAfterMaskrom: true, betaUpdates: false, knownRelease: null };

function file(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8'));
    return {
      updateCheck: typeof raw.updateCheck === 'boolean' ? raw.updateCheck : DEFAULTS.updateCheck,
      lastUpdateCheck: Number.isFinite(raw.lastUpdateCheck) ? raw.lastUpdateCheck : 0,
      resetAfterMaskrom: typeof raw.resetAfterMaskrom === 'boolean' ? raw.resetAfterMaskrom : DEFAULTS.resetAfterMaskrom,
      betaUpdates: raw.betaUpdates === true,
      knownRelease: raw.knownRelease && typeof raw.knownRelease.tag_name === 'string' && typeof raw.knownRelease.html_url === 'string'
        && Array.isArray(raw.knownRelease.assets) ? raw.knownRelease : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(s, null, 2));
}
