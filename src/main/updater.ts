// Look for a newer version of the imager on GitHub, and install it when the
// user asks.
//
// The check runs at most once a day, and not at all when turned off in the
// settings. Which releases are offered is the tier chosen in Settings
// (shared/channel.ts): Stable the newest normal release, Prerelease betas
// too, CI the rolling build of main when it is from another commit. Nothing is downloaded or
// installed before the user presses Update and confirms. How the update
// goes depends on how this copy was installed (shared/update.ts,
// installKind): a Homebrew cask is upgraded by running brew, the app from a
// DMG is swapped for the one in the new DMG (update-mac.ts), the Windows
// installer is run, an AppImage is replaced, a .deb or .rpm goes through
// the package manager. A .deb from an apt repository (Roxora's, on a Roxora
// system) is never replaced from here: it comes with the system's software
// updates, and the app only says a new version is out. Every download is
// checked against the SHA-256 GitHub lists for the file (update-install.ts).

import { app, net, shell, type WebContents } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  APT_COMMAND, APT_PACKAGE, aptRepoCarries, assetSha256, BREW_CASK, brewCaskName, brewCommand, checkDue, installKind, judgeChannel,
  pickAsset,
  type AppRelease, type InstallKind, type ReleaseAsset, type UpdateCheck, type UpdateResult,
} from '../shared/update';
import { pickRelease, type Channel } from '../shared/channel';
import { loadSettings, saveSettings } from './settings';
import { brewUpgrade, findBrew, NotInPlace, removeOldBundle, run, swapAppFromDmg } from './update-mac';
import {
  DOWNLOAD_PREFIX, downloadVerified, fetchReleases, packageInstallCommand, pkexec, programExists, replaceAppImage,
  shellCommand, type Fetch,
} from './update-install';

const owns = (cmd: string, args: string[]) => {
  try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 10000 }); return true; } catch { return false; }
};
/** What a command prints, in the C locale; empty when it fails or is missing. */
const output = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, env: { ...process.env, LC_ALL: 'C' } });
  } catch { return ''; }
};

/** The app bundle on macOS: /Applications/Roxora Imager.app. */
const appBundle = () => app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '');

/** At start: clear away the bundle a previous in-app update on macOS put aside. */
export function afterUpdateCleanup(): void {
  if (process.platform === 'darwin' && app.isPackaged) removeOldBundle(appBundle());
}

let install: { kind: InstallKind; arch: string } | null = null;
/** The tap's cask this copy came from, when Homebrew installed it. */
let brewCask: string | null = null;
/** How this copy was installed, and for which CPU. Looked up once. */
export function detectInstall(): { kind: InstallKind; arch: string } {
  if (install) return install;
  const exe = app.getPath('exe');
  const platform = process.platform;
  const dpkg = platform === 'linux' && !process.env.APPIMAGE && owns('dpkg-query', ['-S', exe]);
  const kind = installKind({
    platform, packaged: app.isPackaged, appImage: process.env.APPIMAGE,
    brew: platform === 'darwin' && (brewCask = brewCaskName(exe.replace(/\/Contents\/MacOS\/[^/]+$/, ''), { realpath: realpathSync, readdir: readdirSync })) !== null,
    nsis: platform === 'win32' && existsSync(join(dirname(exe), 'Uninstall Roxora Imager.exe')),
    dpkg,
    rpm: platform === 'linux' && !process.env.APPIMAGE && owns('rpm', ['-qf', exe]),
    // A .deb that apt can get again from a repository: Roxora's packages on
    // a Roxora system. The system's updates bring new versions.
    aptRepo: dpkg && aptRepoCarries(output('apt-cache', ['policy', APT_PACKAGE])),
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
  if (FAKE === 'brew' || FAKE === 'apt') {
    return { state: 'newer', offer: {
      version: '9.9.9', url: 'https://github.com/roxora-os/imager/releases', beta: false, kind: FAKE,
      notes: 'A made-up version for the screenshots.', asset: null,
    } };
  }
  return { state: 'newer', offer: {
    version: '9.9.9', url: 'https://github.com/roxora-os/imager/releases', beta: false, kind: 'appimage',
    notes: 'A made-up version for the screenshots.', asset: { name: 'roxora-imager-9.9.9-linux-x86_64.AppImage', size: 164283935 },
  } };
}

/** The release the last check offered, with the file to download. */
let offered: { release: AppRelease; asset: ReleaseAsset | null; kind: InstallKind } | null = null;

declare const __BUILD_COMMIT__: string;
/** The commit this copy was built from (scripts/build.mjs), for the CI tier. */
const BUILD_COMMIT = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown';

function judge(list: AppRelease[], channel: Channel): UpdateCheck {
  const { kind, arch } = detectInstall();
  const res = judgeChannel(app.getVersion(), BUILD_COMMIT, list, { channel, kind, arch });
  if (res.state === 'newer') {
    const release = channel === 'ci' ? pickRelease(list, 'ci')! : pickRelease(list.filter((r) => r.tag_name !== 'ci'), channel)!;
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
  if (FAKE) return force || FAKE === 'newer' || FAKE === 'brew' || FAKE === 'apt' ? fakeCheck() : null;
  const s = loadSettings();
  const now = Date.now();
  const remembered = () => {
    const r = s.knownRelease ? judge([s.knownRelease], s.appChannel) : null;
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
  const res = judge(list, s.appChannel);
  // Only what the next start needs: the release and the one file for this install.
  const keep = res.state === 'newer' && offered ? {
    tag_name: offered.release.tag_name, name: offered.release.name ?? null, html_url: offered.release.html_url, prerelease: offered.release.prerelease === true,
    body: (offered.release.body ?? '').slice(0, 2000), assets: offered.asset ? [offered.asset] : [],
  } : null;
  saveSettings({ ...loadSettings(), lastUpdateCheck: now, knownRelease: keep });
  return res;
}

let running: AbortController | null = null;

export function cancelUpdate(): void {
  running?.abort();
}

/** Where the new version starts from, when that is not where this one runs. */
let relaunchExe: string | null = null;

/** Start again with the new version (an AppImage or app bundle has just been replaced under its own name). */
export function restartApp(): void {
  const execPath = relaunchExe ?? process.env.APPIMAGE;
  app.relaunch(execPath ? { execPath, args: process.argv.slice(1) } : undefined);
  app.quit();
}

/** The version of the app bundle on disk, which an update has changed while this one still runs. */
async function bundleVersion(): Promise<string | null> {
  const r = await run('/usr/bin/defaults', ['read', join(appBundle(), 'Contents', 'Info'), 'CFBundleShortVersionString']);
  return r.code === 0 ? r.output.trim() : null;
}

/** Download and install what the last check offered. Called only after the user confirmed. */
export async function installUpdate(wc: WebContents): Promise<UpdateResult> {
  // The screenshots: as on a Mac without Homebrew.
  if (FAKE) return { ok: false, reason: 'Homebrew was not found on this Mac. You can update in Terminal:', command: brewCommand() };
  const o = offered;
  if (!o) return { ok: false, reason: 'Check for a new version again.' };
  if (running) return { ok: false, reason: 'An update is already being downloaded.' };
  const send = (channel: string, payload: unknown) => { if (!wc.isDestroyed()) wc.send(channel, payload); };
  const log = (text: string) => send('update:log', text);
  const stage = (name: string) => send('update:stage', name);
  if (o.kind === 'brew') {
    // As the user, never as root; brew refuses root anyway.
    const cask = brewCask ?? BREW_CASK;
    // The CI tier comes from the nightly cask, the other two from the stable
    // one: a copy from the other cask has to be swapped, which the user does.
    const wantNightly = loadSettings().appChannel === 'ci';
    if (wantNightly !== cask.endsWith('@nightly')) {
      const other = wantNightly ? 'roxora-imager@nightly' : BREW_CASK;
      return { ok: false, reason: `This copy came from the Homebrew cask ${cask}, which does not carry ${wantNightly ? 'CI builds' : 'releases'}. Switch to ${other} in Terminal:`,
        command: `brew uninstall --cask ${cask} && brew install --cask gahingwoo/tap/${other}` };
    }
    running = new AbortController();
    try {
      const brew = await findBrew();
      if (!brew) return { ok: false, reason: 'Homebrew was not found on this Mac. You can update in Terminal:', command: brewCommand(cask) };
      const r = await brewUpgrade({
        brew, cask, runningVersion: app.getVersion(), installedVersion: bundleVersion, onLog: log, signal: running.signal,
        onStage: (st) => stage(st === 'update' ? 'brew-update' : 'brew-upgrade'),
      });
      if (r.ok) return { ok: true, restart: true, message: `Homebrew installed Roxora Imager ${o.release.tag_name.replace(/^v/, '')}. Restart to use it.` };
      return r.cancelled ? { ok: false, reason: r.reason } : { ok: false, reason: `${r.reason} Its output is below. You can also update in Terminal:`, command: brewCommand(cask) };
    } finally {
      running = null;
    }
  }
  // Never swapped from here: apt keeps it, with the rest of the system.
  if (o.kind === 'apt') return { ok: false, reason: 'This copy is updated with the system\'s software updates. You can also update it in a terminal:', command: APT_COMMAND };
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
      stage('download');
      await downloadVerified({ ...d, dest });
      // From here on there is no stopping half way.
      stage('install');
      try {
        const at = await swapAppFromDmg({ dmg: dest, appPath: appBundle(), home: homedir(), onLog: log });
        const moved = at !== appBundle();
        if (moved) relaunchExe = join(at, 'Contents', 'MacOS', app.getPath('exe').split('/').pop()!);
        return { ok: true, restart: true, message: moved
          ? `Roxora Imager ${version} is installed at ${at}, because ${appBundle().replace(/\/[^/]+$/, '')} cannot be written. The old copy is still at ${appBundle()}. Restart to use the new one.`
          : `Roxora Imager ${version} is installed. Restart to use it.` };
      } catch (e) {
        // Not possible here: as before, the DMG is opened and the user drags the app.
        log(`${(e as Error).message}\n`);
        const err = await shell.openPath(dest);
        const why = e instanceof NotInPlace ? 'The app could not be replaced where it is' : 'Replacing the app did not work';
        return { ok: true, restart: false, message: `${why}: ${(e as Error).message.replace(/\.$/, '')}. The old app is unchanged. ${asset.name} is in your Downloads folder${err ? '. Open it' : ' and has been opened'}: `
          + 'quit Roxora Imager, then drag the new Roxora Imager onto Applications and replace the old one.' };
      }
    }
    if (o.kind === 'windows') {
      const dest = join(mkdtempSync(join(tmpdir(), 'roxora-imager-update-')), asset.name);
      stage('download');
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
