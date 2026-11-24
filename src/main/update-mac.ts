// Updating the app on macOS from inside the app: through Homebrew for a
// cask install, by swapping the bundle for the one in the release DMG
// otherwise. No Electron here; the programs it starts (brew, hdiutil, ditto,
// xattr) go through a runner the tests replace.

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { BREW_CASK } from '../shared/update';

export interface RunResult { code: number | null; output: string }
export type Run = (cmd: string, args: string[], o?: {
  env?: NodeJS.ProcessEnv; signal?: AbortSignal; onOutput?: (text: string) => void;
}) => Promise<RunResult>;

/** Start a program and collect what it prints. */
export const run: Run = (cmd, args, o = {}) => new Promise((resolve) => {
  let output = '';
  const add = (b: Buffer) => {
    const t = b.toString();
    output = (output + t).slice(-8000);
    o.onOutput?.(t);
  };
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: o.env, signal: o.signal });
  p.stdout.on('data', add);
  p.stderr.on('data', add);
  p.on('error', (e) => resolve({ code: null, output: `${output}${e.message}` }));
  p.on('close', (code) => resolve({ code, output }));
});

// ---- Homebrew ----

const BREW_PLACES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

/**
 * Where brew is: its two usual places, else what a login shell finds on its
 * PATH (an app started from the Dock does not have the user's PATH).
 */
export async function findBrew(exists: (p: string) => boolean = existsSync, runner: Run = run,
  shell = process.env.SHELL || '/bin/zsh'): Promise<string | null> {
  for (const p of BREW_PLACES) if (exists(p)) return p;
  const r = await runner(shell, ['-lc', 'command -v brew']);
  const found = r.code === 0 ? r.output.trim().split('\n').pop()?.trim() ?? '' : '';
  return found.startsWith('/') && exists(found) ? found : null;
}

/**
 * The two commands of an update: refresh the taps (without it brew does not
 * know the new version), then upgrade the cask.
 */
export function brewSteps(brew: string, cask = BREW_CASK): { update: string[]; upgrade: string[] } {
  // A nightly cask is version :latest: brew upgrades it only when asked to be greedy.
  return { update: [brew, 'update', '--quiet'], upgrade: [brew, 'upgrade', '--cask', ...(cask.endsWith('@nightly') ? ['--greedy'] : []), cask] };
}

/** brew's environment: its own folder on the PATH, the user's cleanup setting not overridden. */
export function brewEnv(brew: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...env };
  delete e.HOMEBREW_NO_INSTALL_CLEANUP;
  // The taps were refreshed by the first command; brew need not do it again.
  e.HOMEBREW_NO_AUTO_UPDATE = '1';
  e.HOMEBREW_NO_ENV_HINTS = '1';
  const path = (env.PATH ?? '').split(':').filter(Boolean);
  e.PATH = [...new Set([dirname(brew), ...path, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  return e;
}

export type BrewOutcome =
  | { ok: true }
  | { ok: false; cancelled?: boolean; reason: string };

export interface BrewUpgrade {
  brew: string;
  /** The tap's cask this copy came from (roxora-imager or roxora-imager@nightly). */
  cask?: string;
  run?: Run;
  /** The version of the app bundle on disk, to see that it really changed. */
  installedVersion: () => Promise<string | null>;
  runningVersion: string;
  onLog: (text: string) => void;
  /** 'update' can be cancelled, 'upgrade' cannot: it must not stop half way. */
  onStage: (stage: 'update' | 'upgrade') => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** Run Homebrew as the user. Nothing here needs or asks for root. */
export async function brewUpgrade(o: BrewUpgrade): Promise<BrewOutcome> {
  const runner = o.run ?? run;
  const steps = brewSteps(o.brew, o.cask);
  const env = brewEnv(o.brew, o.env);
  const say = (argv: string[]) => o.onLog(`$ brew ${argv.slice(1).join(' ')}\n`);
  o.onStage('update');
  say(steps.update);
  const u = await runner(steps.update[0], steps.update.slice(1), { env, signal: o.signal, onOutput: o.onLog });
  if (o.signal?.aborted) return { ok: false, cancelled: true, reason: 'Cancelled. Nothing was installed.' };
  if (u.code !== 0) return { ok: false, reason: `"brew update" failed (${u.code === null ? 'it could not be started' : `exit status ${u.code}`}).` };
  o.onStage('upgrade');
  say(steps.upgrade);
  const g = await runner(steps.upgrade[0], steps.upgrade.slice(1), { env, onOutput: o.onLog });
  if (g.code !== 0) return { ok: false, reason: `"brew upgrade" failed (${g.code === null ? 'it could not be started' : `exit status ${g.code}`}).` };
  const now = await o.installedVersion();
  // A nightly build keeps the version of the code it was built from: only the commit tells them apart.
  if (now !== null && now === o.runningVersion && !o.cask?.endsWith('@nightly')) {
    return { ok: false, reason: 'Homebrew did not install a newer version: its tap does not have it yet. Try again later.' };
  }
  return { ok: true };
}

// ---- The DMG ----

/** The update cannot be done in place; the caller opens the DMG for the user instead. */
export class NotInPlace extends Error {}

export interface DmgSwap {
  /** The checked DMG. */
  dmg: string;
  /** The running app bundle, /Applications/Roxora Imager.app. */
  appPath: string;
  home: string;
  run?: Run;
  canWrite?: (dir: string) => boolean;
  onLog?: (text: string) => void;
  tmp?: string;
}

const writable = (dir: string) => { try { accessSync(dir, constants.W_OK); return true; } catch { return false; } };

/** The name the previous bundle keeps until the app has been restarted. */
export const oldName = (appPath: string) => join(dirname(appPath), `.${basename(appPath)}.old`);
const newName = (dir: string, name: string) => join(dir, `.${name}.update`);

/**
 * Where the new bundle goes: over the running one when its folder can be
 * written, else into ~/Applications. An app that macOS runs from a
 * translocated, read-only copy has no place of its own to update.
 */
export function swapTarget(appPath: string, home: string, canWrite: (dir: string) => boolean = writable): string {
  if (/\/AppTranslocation\//.test(appPath) || !appPath.endsWith('.app')) {
    throw new NotInPlace('The app is not running from a folder of its own (move it to Applications first).');
  }
  if (canWrite(dirname(appPath))) return appPath;
  const mine = join(home, 'Applications');
  try { mkdirSync(mine, { recursive: true }); } catch { /* checked next */ }
  if (canWrite(mine)) return join(mine, basename(appPath));
  throw new NotInPlace(`Neither ${dirname(appPath)} nor ${mine} can be written.`);
}

/**
 * Put the app from the DMG in place of the running one.
 *
 * The DMG is mounted read-only and out of sight, its app copied with ditto
 * to a temporary name next to the target, the quarantine mark taken off (the
 * app is not notarized), and only then the two swapped by renaming. The old
 * bundle is kept under a hidden name (oldName) so that the running app keeps
 * its files; removeOldBundle() deletes it at the next start. If anything
 * fails the old bundle is where it was. Returns where the new app is.
 */
export async function swapAppFromDmg(o: DmgSwap): Promise<string> {
  const runner = o.run ?? run;
  const log = o.onLog ?? (() => {});
  const target = swapTarget(o.appPath, o.home, o.canWrite);
  const dir = dirname(target);
  const name = basename(target);
  const fresh = newName(dir, name);
  const mnt = mkdtempSync(join(o.tmp ?? tmpdir(), 'roxora-imager-dmg-'));
  const must = async (cmd: string, args: string[], what: string) => {
    log(`$ ${basename(cmd)} ${args.join(' ')}\n`);
    const r = await runner(cmd, args, { onOutput: log });
    if (r.code !== 0) throw new Error(`${what} failed (${r.code === null ? 'could not be started' : `exit status ${r.code}`}): ${r.output.trim().split('\n').pop() ?? ''}`);
  };
  let mounted = false;
  try {
    await must('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, o.dmg], 'Opening the DMG');
    mounted = true;
    const inDmg = readdirSync(mnt).find((n) => n.endsWith('.app'));
    if (!inDmg) throw new Error('The DMG holds no app.');
    rmSync(fresh, { recursive: true, force: true });
    await must('/usr/bin/ditto', [join(mnt, inDmg), fresh], 'Copying the new app');
    if (!existsSync(join(fresh, 'Contents', 'Info.plist')) || !existsSync(join(fresh, 'Contents', 'MacOS'))) {
      throw new Error('The copy of the new app is not complete.');
    }
    // Not notarized: without this Gatekeeper refuses the first start. A file without the mark makes xattr fail; that is fine.
    await runner('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', fresh], { onOutput: log });

    const old = oldName(target);
    const had = existsSync(target);
    if (had) {
      rmSync(old, { recursive: true, force: true });
      renameSync(target, old);
    }
    try {
      renameSync(fresh, target);
    } catch (e) {
      // Never without an app: the old one goes back.
      if (had) renameSync(old, target);
      throw e;
    }
    log(`The new app is at ${target}\n`);
    return target;
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    if (mounted) {
      const d = await runner('/usr/bin/hdiutil', ['detach', mnt], { onOutput: log });
      if (d.code !== 0) await runner('/usr/bin/hdiutil', ['detach', '-force', mnt], { onOutput: log });
    }
    try { rmSync(mnt, { recursive: true, force: true }); } catch { /* still mounted: macOS removes it */ }
  }
}

/** At start: the bundle a previous update put aside is no longer in use. */
export function removeOldBundle(appPath: string): void {
  if (!appPath.endsWith('.app')) return;
  try { rmSync(oldName(appPath), { recursive: true, force: true }); } catch { /* next time */ }
}
