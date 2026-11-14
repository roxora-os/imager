// Look for a newer version of the imager on GitHub, and install it when the
// user asks.
//
// The check runs at most once a day, and not at all when turned off in the
// settings. Normal releases are offered to everyone; betas (pre-releases on
// GitHub) only when the setting asks for them. Nothing is downloaded or
// installed before the user presses Update and confirms. How the update
// goes depends on how this copy was installed (shared/update.ts,
// installKind): Homebrew gets its command shown, the DMG is downloaded and
// opened, the Windows installer is run, an AppImage is replaced, a .deb or
// .rpm goes through the package manager. Every download is checked against
// the SHA-256 GitHub lists for the file (update-install.ts).

import { app, net, shell, type WebContents } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assetSha256, BREW_COMMAND, brewCaskOwns, checkDue, installKind, judgeReleases, newestRelease, pickAsset,
  type AppRelease, type InstallKind, type ReleaseAsset, type UpdateCheck, type UpdateResult,
} from '../shared/update';
import { loadSettings, saveSettings } from './settings';
import {
  DOWNLOAD_PREFIX, downloadVerified, fetchReleases, packageInstallCommand, pkexec, programExists, replaceAppImage,
  shellCommand, type Fetch,
} from './update-install';

const owns = (cmd: string, args: string[]) => {
  try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 10000 }); return true; } catch { return false; }
};

let install: { kind: InstallKind; arch: string } | null = null;
/** How this copy was installed, and for which CPU. Looked up once. */
export function detectInstall(): { kind: InstallKind; arch: string } {
  if (install) return install;
  const exe = app.getPath('exe');
  const platform = process.platform;
  const kind = installKind({
    platform, packaged: app.isPackaged, appImage: process.env.APPIMAGE,
    brew: platform === 'darwin' && brewCaskOwns(exe.replace(/\/Contents\/MacOS\/[^/]+$/, ''), { realpath: realpathSync, readdir: readdirSync }),
    nsis: platform === 'win32' && existsSync(join(dirname(exe), 'Uninstall Roxora Imager.exe')),
    dpkg: platform === 'linux' && !process.env.APPIMAGE && owns('dpkg-query', ['-S', exe]),
    rpm: platform === 'linux' && !process.env.APPIMAGE && owns('rpm', ['-qf', exe]),
  });
  // An Intel build on Apple silicon is updated to the Apple silicon build.
  install = { kind, arch: app.runningUnderARM64Translation ? 'arm64' : process.arch };
  return install;
}

// Unpackaged builds only, for the screenshots: a made-up answer, no network.
const FAKE = !app.isPackaged ? process.env.ROXORA_IMAGER_FAKE_UPDATE : undefined;
function fakeCheck(): UpdateCheck {
  if (FAKE === 'error') return { state: 'error', message: 'Could not reach GitHub.' };
  if (FAKE === 'current') return { state: 'current', version: app.getVersion(), beta: false, newerBeta: null };
  return { state: 'newer', offer: {
    version: '9.9.9', url: 'https://github.com/roxora-os/imager/releases', beta: false, kind: 'appimage',
    notes: 'A made-up version for the screenshots.', asset: { name: 'roxora-imager-9.9.9-linux-x86_64.AppImage', size: 164283935 },
  } };
}

/** The release the last check offered, with the file to download. */
let offered: { release: AppRelease; asset: ReleaseAsset | null; kind: InstallKind } | null = null;

function judge(list: AppRelease[], beta: boolean): UpdateCheck {
  const { kind, arch } = detectInstall();
  const res = judgeReleases(app.getVersion(), list, { beta, kind, arch });
  if (res.state === 'newer') {
    const release = newestRelease(list, { beta })!;
    offered = { release, asset: pickAsset(release.assets, kind, arch), kind };
  }
  return res;
}

/**
 * `force`: the user asked (Settings, Check now). Otherwise the check runs
 * when one is due; between checks the last offer is repeated, so the notice
 * does not vanish when the app is restarted. Null: nothing to say.
 */
export async function checkForUpdate(force = false): Promise<UpdateCheck | null> {
  if (FAKE) return force || FAKE === 'newer' ? fakeCheck() : null;
  const s = loadSettings();
  const now = Date.now();
  const remembered = () => {
    const r = s.knownRelease ? judge([s.knownRelease], s.betaUpdates) : null;
    return r?.state === 'newer' ? r : null;
  };
  if (!force && !checkDue(s.updateCheck, s.lastUpdateCheck, now)) return s.updateCheck ? remembered() : null;
  let list: AppRelease[];
  try {
    list = await fetchReleases(net.fetch as unknown as Fetch);
  } catch (e) {
    // Try again at the next start rather than in a day.
    return force ? { state: 'error', message: `Could not reach GitHub (${(e as Error).message}).` } : remembered();
  }
  const res = judge(list, s.betaUpdates);
  // Only what the next start needs: the release and the one file for this install.
  const keep = res.state === 'newer' && offered ? {
    tag_name: offered.release.tag_name, html_url: offered.release.html_url, prerelease: offered.release.prerelease === true,
    body: (offered.release.body ?? '').slice(0, 2000), assets: offered.asset ? [offered.asset] : [],
  } : null;
  saveSettings({ ...loadSettings(), lastUpdateCheck: now, knownRelease: keep });
  return res;
}

let running: AbortController | null = null;

export function cancelUpdate(): void {
  running?.abort();
}

/** Start again with the new version (an AppImage has just been replaced under its own name). */
export function restartApp(): void {
  app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE, args: process.argv.slice(1) } : undefined);
  app.quit();
}

/** Download and install what the last check offered. Called only after the user confirmed. */
export async function installUpdate(wc: WebContents): Promise<UpdateResult> {
  const o = offered;
  if (!o) return { ok: false, reason: 'Check for a new version again.' };
  if (running) return { ok: false, reason: 'An update is already being downloaded.' };
  if (o.kind === 'brew') return { ok: false, reason: 'This copy was installed with Homebrew. Update it in Terminal.', command: BREW_COMMAND };
  const asset = o.asset;
  if (o.kind === 'none' || !asset) return { ok: false, reason: 'The app cannot update this copy itself. Get the new version from the release page.' };
  if (!asset.browser_download_url.startsWith(DOWNLOAD_PREFIX)) return { ok: false, reason: 'The release lists a download that is not on the Roxora Imager release page. Nothing was downloaded.' };
  const version = o.release.tag_name.replace(/^v/, '');
  running = new AbortController();
  const signal = running.signal;
  const d = {
    url: asset.browser_download_url, sha256: assetSha256(asset), size: asset.size, signal, fetch: net.fetch as unknown as Fetch,
    onProgress: (bytes: number, total: number) => { if (!wc.isDestroyed()) wc.send('update:progress', { bytes, total }); },
  };
  try {
    if (o.kind === 'dmg') {
      const dest = join(app.getPath('downloads'), asset.name);
      await downloadVerified({ ...d, dest });
      const err = await shell.openPath(dest);
      return { ok: true, restart: false, message: `${asset.name} is in your Downloads folder${err ? '. Open it' : ' and has been opened'}. `
        + 'Quit Roxora Imager, then drag the new Roxora Imager onto Applications and replace the old one.' };
    }
    if (o.kind === 'windows') {
      const dest = join(mkdtempSync(join(tmpdir(), 'roxora-imager-update-')), asset.name);
      await downloadVerified({ ...d, dest });
      const err = await shell.openPath(dest);
      if (err) return { ok: false, reason: `The installer could not be started (${err}). It is at ${dest}.` };
      // The installer replaces the app, which must not be running then.
      setTimeout(() => app.quit(), 1500);
      return { ok: true, restart: false, message: 'The installer is starting. Roxora Imager closes now.' };
    }
    if (o.kind === 'appimage') {
      const current = process.env.APPIMAGE!;
      await replaceAppImage(current, d);
      return { ok: true, restart: true, message: `Roxora Imager ${version} is now at ${current}. Restart to use it.` };
    }
    const dest = join(mkdtempSync(join(tmpdir(), 'roxora-imager-update-')), asset.name);
    await downloadVerified({ ...d, dest });
    const cmd = packageInstallCommand(o.kind, dest, programExists);
    if (!cmd) return { ok: false, reason: `No package manager was found to install ${asset.name}. It is downloaded and checked, at ${dest}.` };
    const command = shellCommand(cmd);
    if (!programExists('pkexec')) return { ok: false, reason: 'The package is downloaded and checked. Install it in a terminal:', command };
    const r = await pkexec(cmd, signal);
    if (r.code === 0) return { ok: true, restart: true, message: `Roxora Imager ${version} is installed. Restart to use it.` };
    if (r.code === 126 || r.code === 127) {
      return { ok: false, reason: 'Administrator rights were not granted. The package is downloaded and checked; you can install it in a terminal:', command };
    }
    return { ok: false, reason: `The package manager did not install it (exit status ${r.code}). You can try in a terminal:`, command };
  } catch (e) {
    if (signal.aborted) return { ok: false, reason: 'Cancelled. Nothing was installed.' };
    return { ok: false, reason: String((e as Error).message ?? e) };
  } finally {
    running = null;
  }
}
