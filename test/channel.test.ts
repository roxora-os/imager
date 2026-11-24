// Stable, Prerelease and CI: which release each tier means.
import { describe, expect, it } from 'vitest';
import { ciCommit, pickRelease, releaseLabel, sameCommit } from '../src/shared/channel';
import { judgeChannel, pickAsset, type AppRelease } from '../src/shared/update';

const rel = (tag_name: string, more: Partial<AppRelease> = {}): AppRelease => ({ tag_name, html_url: `https://x/${tag_name}`, ...more });
// Releases as GitHub lists them (newest first by date), with a rolling ci release.
const list = [
  rel('ci', { prerelease: true, name: 'CI build 1a2b3c4 2026-11-24', body: 'Built from 1a2b3c4d5e on 2026-11-24. Untested.' }),
  rel('0.4.1'), rel('0.4.0'), rel('0.3.0'), rel('0.3.0-tspi3m.1', { prerelease: true }), rel('0.5.0-rc.1', { prerelease: true }),
  rel('0.6.0', { draft: true }),
];

describe('tiers', () => {
  it('Stable skips pre-releases, drafts and the ci release', () => {
    expect(pickRelease(list, 'stable')?.tag_name).toBe('0.4.1');
  });
  it('Prerelease takes the newest version, pre-releases included, never the ci release', () => {
    expect(pickRelease(list, 'prerelease')?.tag_name).toBe('0.5.0-rc.1');
    expect(pickRelease([rel('ci', { prerelease: true }), rel('0.3.0-tspi3m.1', { prerelease: true }), rel('0.2.1')], 'prerelease')?.tag_name).toBe('0.3.0-tspi3m.1');
  });
  it('CI is the release tagged ci, and only that', () => {
    expect(pickRelease(list, 'ci')?.tag_name).toBe('ci');
    expect(pickRelease(list.slice(1), 'ci')).toBeNull();
    expect(pickRelease([rel('ci', { draft: true })], 'ci')).toBeNull();
  });
  it('reads the commit of a CI release', () => {
    expect(ciCommit(list[0])).toBe('1a2b3c4');
    expect(ciCommit(rel('ci', { name: 'CI build', body: 'Built from 9f8e7d6c5b4a on ...' }))).toBe('9f8e7d6c5b4a');
    expect(releaseLabel(list[0])).toBe('CI build 1a2b3c4');
    expect(releaseLabel(list[1])).toBe('0.4.1');
    expect(sameCommit('1a2b3c4', '1a2b3c4d5e6f')).toBe(true);
    expect(sameCommit('1a2b3c4', '9a2b3c4')).toBe(false);
  });
});

describe('app updates by tier', () => {
  const app = [
    rel('ci', { prerelease: true, name: 'CI build 1a2b3c4 2026-11-24', assets: [{ name: 'roxora-imager-0.2.0-linux-x86_64.AppImage', size: 1, browser_download_url: 'u' }] }),
    rel('v0.2.0', { assets: [{ name: 'roxora-imager-0.2.0-linux-x86_64.AppImage', size: 1, browser_download_url: 'u' }] }),
    rel('v0.3.0-beta.1', { prerelease: true }),
  ];
  const o = { kind: 'appimage' as const, arch: 'x64' };
  it('Stable and Prerelease compare versions and leave the ci release out', () => {
    expect(judgeChannel('0.1.0', 'aaaaaaa', app, { ...o, channel: 'stable' })).toMatchObject({ state: 'newer', offer: { version: '0.2.0' } });
    expect(judgeChannel('0.2.0', 'aaaaaaa', app, { ...o, channel: 'prerelease' })).toMatchObject({ state: 'newer', offer: { version: '0.3.0-beta.1' } });
    expect(judgeChannel('0.2.0', 'aaaaaaa', [app[0], app[1]], { ...o, channel: 'stable' })).toMatchObject({ state: 'current' });
  });
  it('CI offers the ci release when it was built from another commit', () => {
    expect(judgeChannel('0.2.0', 'aaaaaaa', app, { ...o, channel: 'ci' })).toMatchObject({ state: 'newer', offer: { version: 'CI build 1a2b3c4', asset: { name: 'roxora-imager-0.2.0-linux-x86_64.AppImage' } } });
    expect(judgeChannel('0.2.0', '1a2b3c4', app, { ...o, channel: 'ci' })).toMatchObject({ state: 'current' });
    expect(judgeChannel('0.2.0', '1a2b3c4', app.slice(1), { ...o, channel: 'ci' })).toMatchObject({ state: 'current' });
  });
  it('finds the Windows arm64 installer', () => {
    const assets = ['x64', 'arm64'].map((a) => ({ name: `roxora-imager-0.2.0-windows-${a}-setup.exe`, size: 1, browser_download_url: 'u' }));
    expect(pickAsset(assets, 'windows', 'arm64')?.name).toBe('roxora-imager-0.2.0-windows-arm64-setup.exe');
    expect(pickAsset(assets, 'windows', 'x64')?.name).toBe('roxora-imager-0.2.0-windows-x64-setup.exe');
  });
});

describe('a ci release in the list', () => {
  const app = [
    rel('ci', { prerelease: true, name: 'CI build 1a2b3c4 2026-11-24' }),
    rel('v0.1.10'),
  ];
  it('is never offered to Stable or Prerelease, and an unknown build commit still gets the CI offer', () => {
    expect(judgeChannel('0.1.10', 'unknown', app, { kind: 'appimage', arch: 'x64', channel: 'prerelease' })).toMatchObject({ state: 'current' });
    expect(judgeChannel('0.1.10', 'unknown', app, { kind: 'appimage', arch: 'x64', channel: 'ci' })).toMatchObject({ state: 'newer', offer: { ci: true } });
  });
});
