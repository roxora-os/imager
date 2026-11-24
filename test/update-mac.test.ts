// The macOS in-app update without a Mac: brew, hdiutil, ditto and xattr are
// stand-ins; the folders and the renaming are real, in a temporary folder.
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  brewEnv, brewSteps, brewUpgrade, findBrew, NotInPlace, oldName, removeOldBundle, swapAppFromDmg, swapTarget, type Run,
} from '../src/main/update-mac';

const work = mkdtempSync(join(tmpdir(), 'update-mac-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('finding Homebrew', () => {
  const noShell: Run = async () => ({ code: 1, output: '' });
  it('looks in its two usual places first', async () => {
    expect(await findBrew((p) => p === '/opt/homebrew/bin/brew', noShell)).toBe('/opt/homebrew/bin/brew');
    expect(await findBrew((p) => p === '/usr/local/bin/brew', noShell)).toBe('/usr/local/bin/brew');
    expect(await findBrew(() => true, noShell)).toBe('/opt/homebrew/bin/brew');
  });
  it('asks a login shell otherwise, and believes only a path that exists', async () => {
    const calls: string[][] = [];
    const shell: Run = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, output: 'some greeting\n/Users/u/homebrew/bin/brew\n' }; };
    expect(await findBrew((p) => p === '/Users/u/homebrew/bin/brew', shell, '/bin/zsh')).toBe('/Users/u/homebrew/bin/brew');
    expect(calls).toEqual([['/bin/zsh', '-lc', 'command -v brew']]);
    expect(await findBrew(() => false, shell, '/bin/zsh')).toBeNull();
    expect(await findBrew(() => true, async () => ({ code: 0, output: 'brew: aliased to something\n' }), '/bin/zsh')).toBe('/opt/homebrew/bin/brew');
    expect(await findBrew((p) => !p.includes('homebrew') && !p.includes('/usr/local'), async () => ({ code: 0, output: 'brew () { ... }\n' }), '/bin/zsh')).toBeNull();
  });
  it('is nowhere on a Mac without it', async () => {
    expect(await findBrew(() => false, noShell)).toBeNull();
  });
});

describe('the Homebrew commands', () => {
  it('refresh the taps, then upgrade the cask', () => {
    expect(brewSteps('/opt/homebrew/bin/brew')).toEqual({
      update: ['/opt/homebrew/bin/brew', 'update', '--quiet'],
      upgrade: ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'roxora-imager'],
    });
  });
  it('upgrade the nightly cask greedily: it is version :latest', () => {
    expect(brewSteps('/opt/homebrew/bin/brew', 'roxora-imager@nightly').upgrade)
      .toEqual(['/opt/homebrew/bin/brew', 'upgrade', '--cask', '--greedy', 'roxora-imager@nightly']);
  });
  it('run with brew on the PATH and without overriding the cleanup', () => {
    const e = brewEnv('/opt/homebrew/bin/brew', { PATH: '/usr/bin:/bin', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOME: '/Users/u' });
    expect(e.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    expect('HOMEBREW_NO_INSTALL_CLEANUP' in e).toBe(false);
    expect(e.HOME).toBe('/Users/u');
  });
});

describe('upgrading through Homebrew', () => {
  const setup = (codes: { update?: number | null; upgrade?: number | null }, after = '9.9.9') => {
    const calls: string[][] = [];
    const stages: string[] = [];
    let log = '';
    const run: Run = async (cmd, args, o) => {
      calls.push([cmd, ...args]);
      o?.onOutput?.(`output of ${args[0]}\n`);
      const step = args[0] === 'update' ? 'update' : 'upgrade';
      const code = step in codes ? codes[step]! : 0;
      return { code, output: '' };
    };
    const go = (signal?: AbortSignal) => brewUpgrade({
      brew: '/opt/homebrew/bin/brew', run, runningVersion: '0.1.5', installedVersion: async () => after,
      onLog: (t) => { log += t; }, onStage: (s) => stages.push(s), signal, env: { PATH: '/usr/bin' },
    });
    return { calls, stages, go, log: () => log };
  };
  it('runs both commands as they are, no sudo, and streams their output', async () => {
    const t = setup({});
    expect(await t.go()).toEqual({ ok: true });
    expect(t.calls).toEqual([['/opt/homebrew/bin/brew', 'update', '--quiet'], ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'roxora-imager']]);
    expect(t.stages).toEqual(['update', 'upgrade']);
    expect(t.log()).toBe('$ brew update --quiet\noutput of update\n$ brew upgrade --cask roxora-imager\noutput of upgrade\n');
  });
  it('does not upgrade when refreshing the taps failed', async () => {
    const t = setup({ update: 1 });
    expect(await t.go()).toEqual({ ok: false, reason: '"brew update" failed (exit status 1).' });
    expect(t.calls).toHaveLength(1);
  });
  it('reports a failed upgrade', async () => {
    const t = setup({ upgrade: 1 });
    expect(await t.go()).toEqual({ ok: false, reason: '"brew upgrade" failed (exit status 1).' });
    expect(await setup({ upgrade: null }).go()).toMatchObject({ ok: false, reason: '"brew upgrade" failed (it could not be started).' });
  });
  it('is not fooled when brew succeeds without installing anything newer', async () => {
    const t = setup({}, '0.1.5');
    expect(await t.go()).toMatchObject({ ok: false, reason: expect.stringMatching(/tap does not have it yet/) });
  });
  it('can be cancelled before the upgrade starts, and then does not start it', async () => {
    const ac = new AbortController();
    const t = setup({});
    ac.abort();
    expect(await t.go(ac.signal)).toEqual({ ok: false, cancelled: true, reason: 'Cancelled. Nothing was installed.' });
    expect(t.calls).toHaveLength(1);
    expect(t.stages).toEqual(['update']);
  });
});

// A stand-in for hdiutil, ditto and xattr. The "DMG" is a folder holding the new app.
function fakeMac(dmgContents: string, fail: Partial<Record<'attach' | 'ditto' | 'detach', boolean>> = {}) {
  const calls: string[] = [];
  const run: Run = async (cmd, args) => {
    const tool = cmd.split('/').pop()!;
    calls.push(tool === 'ditto' ? 'ditto' : `${tool} ${args[0]}`);
    if (tool === 'hdiutil' && args[0] === 'attach') {
      if (fail.attach) return { code: 1, output: 'hdiutil: attach failed - image not recognized\n' };
      cpSync(dmgContents, args[args.indexOf('-mountpoint') + 1], { recursive: true });
      return { code: 0, output: '' };
    }
    if (tool === 'hdiutil' && args[0] === 'detach') {
      if (fail.detach && !args.includes('-force')) return { code: 16, output: 'Resource busy\n' };
      rmSync(args[args.length - 1], { recursive: true, force: true });
      return { code: 0, output: '' };
    }
    if (tool === 'ditto') {
      if (fail.ditto) { mkdirSync(args[1], { recursive: true }); return { code: 1, output: 'ditto: No space left on device\n' }; }
      cpSync(args[0], args[1], { recursive: true });
      return { code: 0, output: '' };
    }
    return { code: tool === 'xattr' ? 1 : 0, output: '' }; // xattr: no such mark, as on a file that never had one
  };
  return { run, calls };
}
function bundle(dir: string, name: string, version: string): string {
  const app = join(dir, name);
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), `version ${version}`);
  writeFileSync(join(app, 'Contents', 'MacOS', 'Roxora Imager'), `binary ${version}`);
  return app;
}
const versionAt = (app: string) => readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8');
function scene() {
  const root = mkdtempSync(join(work, 'scene-'));
  const apps = join(root, 'Applications');
  const home = join(root, 'home');
  const dmg = join(root, 'dmg');
  const tmp = join(root, 'tmp');
  for (const d of [apps, home, dmg, tmp]) mkdirSync(d);
  bundle(dmg, 'Roxora Imager.app', 'new');
  writeFileSync(join(dmg, '.background.png'), 'x');
  return { root, apps, home, dmg, tmp, app: bundle(apps, 'Roxora Imager.app', 'old') };
}

describe('where the new app goes', () => {
  it('is over the running one when its folder can be written', () => {
    expect(swapTarget('/Applications/Roxora Imager.app', '/Users/u', () => true)).toBe('/Applications/Roxora Imager.app');
  });
  it('is ~/Applications when it cannot', () => {
    const s = scene();
    expect(swapTarget(s.app, s.home, (d) => d !== s.apps)).toBe(join(s.home, 'Applications', 'Roxora Imager.app'));
    expect(existsSync(join(s.home, 'Applications'))).toBe(true);
  });
  it('is nowhere when neither can be written, or the app runs translocated', () => {
    const s = scene();
    expect(() => swapTarget(s.app, s.home, () => false)).toThrow(NotInPlace);
    expect(() => swapTarget('/private/var/folders/ab/T/AppTranslocation/1234/d/Roxora Imager.app', '/Users/u', () => true)).toThrow(NotInPlace);
  });
});

describe('swapping the app for the one in the DMG', () => {
  it('puts the new app in place, keeps the old one aside until the restart, and tidies up', async () => {
    const s = scene();
    const mac = fakeMac(s.dmg);
    const at = await swapAppFromDmg({ dmg: '/x/new.dmg', appPath: s.app, home: s.home, run: mac.run, tmp: s.tmp });
    expect(at).toBe(s.app);
    expect(versionAt(s.app)).toBe('version new');
    expect(versionAt(oldName(s.app))).toBe('version old');
    expect(readdirSync(s.apps).sort()).toEqual(['.Roxora Imager.app.old', 'Roxora Imager.app']);
    expect(readdirSync(s.tmp)).toEqual([]);
    expect(mac.calls).toEqual(['hdiutil attach', 'ditto', 'xattr -dr', 'hdiutil detach']);
    removeOldBundle(s.app);
    expect(readdirSync(s.apps)).toEqual(['Roxora Imager.app']);
  });
  it('mounts read-only and out of sight, and removes the quarantine mark from the new copy only', async () => {
    const s = scene();
    const seen: string[][] = [];
    const mac = fakeMac(s.dmg);
    const run: Run = (cmd, args, o) => { seen.push([cmd, ...args]); return mac.run(cmd, args, o); };
    await swapAppFromDmg({ dmg: '/x/new.dmg', appPath: s.app, home: s.home, run, tmp: s.tmp });
    expect(seen[0].slice(0, 5)).toEqual(['/usr/bin/hdiutil', 'attach', '-nobrowse', '-readonly', '-noautoopen']);
    expect(seen[0].at(-1)).toBe('/x/new.dmg');
    expect(seen.find((c) => c[0] === '/usr/bin/xattr')).toEqual(['/usr/bin/xattr', '-dr', 'com.apple.quarantine', join(s.apps, '.Roxora Imager.app.update')]);
  });
  it('installs into ~/Applications when the app folder cannot be written, leaving the old app alone', async () => {
    const s = scene();
    const mac = fakeMac(s.dmg);
    const at = await swapAppFromDmg({ dmg: '/x/new.dmg', appPath: s.app, home: s.home, run: mac.run, tmp: s.tmp, canWrite: (d) => d !== s.apps });
    expect(at).toBe(join(s.home, 'Applications', 'Roxora Imager.app'));
    expect(versionAt(at)).toBe('version new');
    expect(versionAt(s.app)).toBe('version old');
    expect(readdirSync(s.apps)).toEqual(['Roxora Imager.app']);
  });
  const unchanged = (s: ReturnType<typeof scene>) => {
    expect(versionAt(s.app)).toBe('version old');
    expect(readdirSync(s.apps)).toEqual(['Roxora Imager.app']);
    expect(readdirSync(s.tmp)).toEqual([]);
  };
  it('leaves the old app untouched when the DMG cannot be opened', async () => {
    const s = scene();
    const mac = fakeMac(s.dmg, { attach: true });
    await expect(swapAppFromDmg({ dmg: '/x/new.dmg', appPath: s.app, home: s.home, run: mac.run, tmp: s.tmp })).rejects.toThrow(/Opening the DMG failed \(exit status 1\): hdiutil: attach failed/);
    unchanged(s);
    expect(mac.calls).toEqual(['hdiutil attach']);
  });
  it('leaves the old app untouched when the copy fails, removes the partial copy and detaches', async () => {
    const s = scene();
    const mac = fakeMac(s.dmg, { ditto: true });
    await expect(swapAppFromDmg({ dmg: '/x/new.dmg', appPath: s.app, home: s.home, run: mac.run, tmp: s.tmp })).rejects.toThrow(/Copying the new app failed.*No space left/);
    unchanged(s);
    expect(mac.calls.at(-1)).toBe('hdiutil detach');
  });
  it('refuses a DMG without an app, or with an incomplete one', async () => {
    const s = scene();
    rmSync(join(s.dmg, 'Roxora Imager.app'), { recursive: true });
    await expect(swapAppFromDmg({ dmg: '/x/new.dmg', appPath: s.app, home: s.home, run: fakeMac(s.dmg).run, tmp: s.tmp })).rejects.toThrow('The DMG holds no app.');
    unchanged(s);
    mkdirSync(join(s.dmg, 'Roxora Imager.app', 'Contents'), { recursive: true });
    await expect(swapAppFromDmg({ dmg: '/x/new.dmg', appPath: s.app, home: s.home, run: fakeMac(s.dmg).run, tmp: s.tmp })).rejects.toThrow('not complete');
    unchanged(s);
  });
  it('says so without touching anything when there is nowhere to install', async () => {
    const s = scene();
    const mac = fakeMac(s.dmg);
    await expect(swapAppFromDmg({ dmg: '/x/new.dmg', appPath: s.app, home: s.home, run: mac.run, tmp: s.tmp, canWrite: () => false })).rejects.toThrow(NotInPlace);
    expect(mac.calls).toEqual([]);
    unchanged(s);
  });
  it('forces the detach when the volume is busy', async () => {
    const s = scene();
    const mac = fakeMac(s.dmg, { detach: true });
    await swapAppFromDmg({ dmg: '/x/new.dmg', appPath: s.app, home: s.home, run: mac.run, tmp: s.tmp });
    expect(mac.calls.slice(-2)).toEqual(['hdiutil detach', 'hdiutil detach']);
    expect(versionAt(s.app)).toBe('version new');
  });
});
