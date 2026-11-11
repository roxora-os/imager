// Settings, stored as JSON in the user data folder.
import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Settings {
  /** Look for a newer version of the app, at most once a day. */
  updateCheck: boolean;
  /** When the last check ran, ms since the epoch. */
  lastUpdateCheck: number;
  /** Reset the board after a Maskrom write. */
  resetAfterMaskrom: boolean;
}

const DEFAULTS: Settings = { updateCheck: true, lastUpdateCheck: 0, resetAfterMaskrom: true };

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
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(s, null, 2));
}
