import { describe, expect, it } from 'vitest';
import {
  assetSha256, brewCaskOwns, checkDue, compareVersions, installKind, judgeReleases, newestRelease, pickAsset,
  UPDATE_INTERVAL, whatsNew, type AppRelease, type ReleaseAsset,
} from '../src/shared/update';

const asset = (name: string, digest: string | null = `sha256:${'a'.repeat(64)}`): ReleaseAsset =>
  ({ name, size: 1000, browser_download_url: `https://github.com/roxora-os/imager/releases/download/v1/${name}`, digest });
const assetsOf = (v: string) => [
  asset(`roxora-imager-${v}-1.aarch64.rpm`), asset(`roxora-imager-${v}-1.x86_64.rpm`),
  asset(`roxora-imager-${v}-linux-arm64.AppImage`), asset(`roxora-imager-${v}-linux-x86_64.AppImage`),
  asset(`roxora-imager-${v}-macos-arm64.dmg`), asset(`roxora-imager-${v}-macos-x86_64.dmg`),
  asset(`roxora-imager-${v}-windows-x64-setup.exe`), asset(`roxora-imager-${v}-windows-x64.zip`),
  asset(`roxora-imager_${v}_amd64.deb`), asset(`roxora-imager_${v}_arm64.deb`), asset('SHA256SUMS'),
];
const rel = (v: string, over: Partial<AppRelease> = {}): AppRelease => ({
  tag_name: `v${v}`, html_url: `https://github.com/roxora-os/imager/releases/tag/v${v}`,
  body: `\n- Fix: something\n  that broke.\n- More.\n`, assets: assetsOf(v), ...over,
});

describe('versions', () => {
  it('compares numerically', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('2026.11.10', '2026.11.2')).toBeGreaterThan(0);
    expect(compareVersions('v0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
  it('puts a beta before its release, and beta.10 after beta.2', () => {
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('0.1.5', '0.1.5-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('0.1.5-beta.10', '0.1.5-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('0.1.5-beta.2', '0.1.5-beta.2')).toBe(0);
    expect(compareVersions('0.1.5-beta', '0.1.5-beta.1')).toBeLessThan(0);
    expect(compareVersions('0.1.6-beta.1', '0.1.5')).toBeGreaterThan(0);
  });
  it('checks at most once a day, and never when turned off', () => {
    const now = 10 * UPDATE_INTERVAL;
    expect(checkDue(true, 0, now)).toBe(true);
    expect(checkDue(true, now - 1000, now)).toBe(false);
    expect(checkDue(true, now - UPDATE_INTERVAL, now)).toBe(true);
    expect(checkDue(false, 0, now)).toBe(false);
    expect(checkDue(true, now + 5000, now)).toBe(true); // clock went back
  });
});

describe('the newest release', () => {
  // As GitHub lists them: by date, not by version.
  const list = [
    rel('0.1.9'), rel('0.2.0-beta.1', { prerelease: true }), rel('0.1.10'), rel('0.3.0', { draft: true }),
    rel('0.1.11', { prerelease: true }), rel('0.1.2'),
  ];
  it('is the highest normal release by default: no drafts, no betas', () => {
    expect(newestRelease(list, { beta: false })?.tag_name).toBe('v0.1.10');
  });
  it('includes betas when asked, highest version wins', () => {
    expect(newestRelease(list, { beta: true })?.tag_name).toBe('v0.2.0-beta.1');
    expect(newestRelease([rel('0.1.10'), rel('0.1.10-beta.3', { prerelease: true })], { beta: true })?.tag_name).toBe('v0.1.10');
  });
  it('treats a version with a suffix as a beta even when GitHub does not mark it', () => {
    expect(newestRelease([rel('0.1.4'), rel('0.1.5-beta.1')], { beta: false })?.tag_name).toBe('v0.1.4');
  });
  it('is nothing when there are only betas and drafts', () => {
    expect(newestRelease([rel('0.1.3', { prerelease: true }), rel('0.2.0', { draft: true })], { beta: false })).toBeNull();
    expect(newestRelease([], { beta: true })).toBeNull();
  });
});

describe('what a check says', () => {
  const o = { beta: false, kind: 'appimage' as const, arch: 'x64' };
  it('offers a newer normal release with its file and the first line of its notes', () => {
    const r = judgeReleases('0.1.3', [rel('0.1.4'), rel('0.1.3', { prerelease: true })], o);
    expect(r).toEqual({ state: 'newer', offer: {
      version: '0.1.4', url: 'https://github.com/roxora-os/imager/releases/tag/v0.1.4', beta: false,
      notes: 'Fix: something that broke.', kind: 'appimage', asset: { name: 'roxora-imager-0.1.4-linux-x86_64.AppImage', size: 1000 },
    } });
  });
  it('says the newest version is installed', () => {
    expect(judgeReleases('0.1.4', [rel('0.1.4'), rel('0.1.3')], o)).toEqual({ state: 'current', version: '0.1.4', beta: false, newerBeta: null });
    // A build newer than anything published.
    expect(judgeReleases('0.2.0', [rel('0.1.4')], o)).toMatchObject({ state: 'current', beta: false });
  });
  it('does not push a beta unless asked, but says one is out', () => {
    const list = [rel('0.1.5-beta.1', { prerelease: true }), rel('0.1.4')];
    expect(judgeReleases('0.1.4', list, o)).toEqual({ state: 'current', version: '0.1.4', beta: false, newerBeta: '0.1.5-beta.1' });
    expect(judgeReleases('0.1.4', list, { ...o, beta: true })).toMatchObject({ state: 'newer', offer: { version: '0.1.5-beta.1', beta: true } });
  });
  it('says plainly when the running version is a beta and no newer normal release exists', () => {
    // Marked as a pre-release on GitHub, no suffix (every version up to 0.1.3).
    expect(judgeReleases('0.1.3', [rel('0.1.3', { prerelease: true }), rel('0.1.2', { prerelease: true })], o))
      .toEqual({ state: 'current', version: '0.1.3', beta: true, newerBeta: null });
    expect(judgeReleases('0.1.5-beta.1', [rel('0.1.5-beta.2', { prerelease: true }), rel('0.1.4')], o))
      .toEqual({ state: 'current', version: '0.1.5-beta.1', beta: true, newerBeta: '0.1.5-beta.2' });
    // The release of a beta is an update for everyone.
    expect(judgeReleases('0.1.5-beta.1', [rel('0.1.5')], o)).toMatchObject({ state: 'newer', offer: { version: '0.1.5' } });
  });
  it('offers a version without a file when the release has none for this install', () => {
    const r = judgeReleases('0.1.3', [rel('0.1.4', { assets: [asset('SHA256SUMS')] })], o);
    expect(r).toMatchObject({ state: 'newer', offer: { version: '0.1.4', asset: null } });
  });
  it('shortens the notes to one line', () => {
    expect(whatsNew('\nA line first.\n\n- New: `this` thing\n  goes on here.\n- Other.')).toBe('New: this thing goes on here.');
    expect(whatsNew('Just words.\n')).toBe('Just words.');
    expect(whatsNew(null)).toBe('');
    expect(whatsNew(`- ${'word '.repeat(100)}`).length).toBeLessThanOrEqual(180);
  });
});

describe('how this copy was installed', () => {
  it('follows the platform, the AppImage variable and the package databases', () => {
    expect(installKind({ platform: 'linux', packaged: true, appImage: '/home/u/.local/bin/roxora-imager.AppImage' })).toBe('appimage');
    expect(installKind({ platform: 'linux', packaged: true, dpkg: true })).toBe('deb');
    expect(installKind({ platform: 'linux', packaged: true, rpm: true })).toBe('rpm');
    expect(installKind({ platform: 'linux', packaged: true, dpkg: true, rpm: true })).toBe('deb');
    expect(installKind({ platform: 'linux', packaged: true })).toBe('none');
    expect(installKind({ platform: 'darwin', packaged: true })).toBe('dmg');
    expect(installKind({ platform: 'darwin', packaged: true, brew: true })).toBe('brew');
    expect(installKind({ platform: 'win32', packaged: true, nsis: true })).toBe('windows');
    expect(installKind({ platform: 'win32', packaged: true })).toBe('none'); // the zip
    expect(installKind({ platform: 'linux', packaged: false, appImage: '/x.AppImage' })).toBe('none');
  });
  it('knows a Homebrew cask by the Caskroom', () => {
    const links: Record<string, string> = {
      '/opt/homebrew/Caskroom/roxora-imager/0.1.4/Roxora Imager.app': '/Applications/Roxora Imager.app',
    };
    const fs = {
      realpath: (p: string) => links[p] ?? p,
      readdir: (p: string) => {
        if (p === '/opt/homebrew/Caskroom/roxora-imager') return ['.metadata', '0.1.4'];
        if (p === '/opt/homebrew/Caskroom/roxora-imager/0.1.4') return ['Roxora Imager.app'];
        throw new Error('ENOENT');
      },
    };
    // Homebrew today: the app is in /Applications, a link to it in the Caskroom.
    expect(brewCaskOwns('/Applications/Roxora Imager.app', fs)).toBe(true);
    // Another copy on the same Mac is not the cask's.
    expect(brewCaskOwns('/Users/u/Downloads/Roxora Imager.app', fs)).toBe(false);
    // The app itself inside a Caskroom.
    const none = { realpath: (p: string) => p, readdir: () => { throw new Error('ENOENT'); } };
    expect(brewCaskOwns('/usr/local/Caskroom/roxora-imager/0.1.4/Roxora Imager.app', none)).toBe(true);
    expect(brewCaskOwns('/Applications/Roxora Imager.app', none)).toBe(false);
  });
});

describe('the file for this install', () => {
  const a = assetsOf('0.1.4');
  it('is chosen by kind and CPU', () => {
    const name = (kind: Parameters<typeof pickAsset>[1], arch: string) => pickAsset(a, kind, arch)?.name ?? null;
    expect(name('dmg', 'arm64')).toBe('roxora-imager-0.1.4-macos-arm64.dmg');
    expect(name('dmg', 'x64')).toBe('roxora-imager-0.1.4-macos-x86_64.dmg');
    expect(name('windows', 'x64')).toBe('roxora-imager-0.1.4-windows-x64-setup.exe');
    expect(name('appimage', 'x64')).toBe('roxora-imager-0.1.4-linux-x86_64.AppImage');
    expect(name('appimage', 'arm64')).toBe('roxora-imager-0.1.4-linux-arm64.AppImage');
    expect(name('deb', 'x64')).toBe('roxora-imager_0.1.4_amd64.deb');
    expect(name('deb', 'arm64')).toBe('roxora-imager_0.1.4_arm64.deb');
    expect(name('rpm', 'x64')).toBe('roxora-imager-0.1.4-1.x86_64.rpm');
    expect(name('rpm', 'arm64')).toBe('roxora-imager-0.1.4-1.aarch64.rpm');
  });
  it('is nothing for Homebrew, an unknown install, another CPU or a release without it', () => {
    expect(pickAsset(a, 'brew', 'arm64')).toBeNull();
    expect(pickAsset(a, 'none', 'x64')).toBeNull();
    expect(pickAsset(a, 'windows', 'arm64')).toBeNull();
    expect(pickAsset(a, 'appimage', 'ia32')).toBeNull();
    expect(pickAsset([asset('SHA256SUMS')], 'deb', 'x64')).toBeNull();
    expect(pickAsset(undefined, 'deb', 'x64')).toBeNull();
  });
  it('has a checksum only in the form GitHub gives it', () => {
    expect(assetSha256(asset('x'))).toBe('a'.repeat(64));
    expect(assetSha256(asset('x', null))).toBeNull();
    expect(assetSha256(asset('x', 'sha256:abc'))).toBeNull();
    expect(assetSha256(asset('x', `md5:${'a'.repeat(64)}`))).toBeNull();
  });
});
