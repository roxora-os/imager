// The update steps against a local server standing in for GitHub: a release
// list and release files.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVerified, fetchReleases, packageInstallCommand, replaceAppImage, shellCommand, type Fetch } from '../src/main/update-install';
import { assetSha256, judgeReleases, newestRelease, pickAsset } from '../src/shared/update';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const work = mkdtempSync(join(tmpdir(), 'update-test-'));
const newApp = Buffer.concat([Buffer.from('#!/bin/sh\necho new\n'), randomBytes(300000)]);
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/releases') {
      const file = (name: string, digest: string | null) => ({ name, size: newApp.length, browser_download_url: `${base}/files/${name}`, digest });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([
        { tag_name: 'v0.1.4-beta.1', html_url: `${base}/tag/v0.1.4-beta.1`, prerelease: true, assets: [] },
        { tag_name: 'v0.1.4', html_url: `${base}/tag/v0.1.4`, body: '- New: updates.', assets: [
          file('roxora-imager-0.1.4-linux-x86_64.AppImage', `sha256:${sha(newApp)}`),
          file('roxora-imager-0.1.4-linux-arm64.AppImage', `sha256:${'0'.repeat(64)}`),
          file('roxora-imager_0.1.4_amd64.deb', null),
        ] },
        { tag_name: 'v0.1.3', html_url: `${base}/tag/v0.1.3`, prerelease: true, assets: [] },
      ]));
    } else if (req.url?.startsWith('/files/')) {
      res.setHeader('content-length', newApp.length);
      res.write(newApp.subarray(0, 1000));
      // In pieces, slow enough to be cancelled.
      if (req.url.includes('slow')) setTimeout(() => res.end(newApp.subarray(1000)), 2000);
      else res.end(newApp.subarray(1000));
    } else if (req.url === '/notalist') {
      res.end('{"message":"rate limited"}');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); rmSync(work, { recursive: true, force: true }); });

const f = fetch as unknown as Fetch;

describe('the release list', () => {
  it('is read and judged: the normal release is offered, with the file for this install', async () => {
    const list = await fetchReleases(f, `${base}/releases`);
    expect(newestRelease(list, { beta: false })?.tag_name).toBe('v0.1.4');
    expect(judgeReleases('0.1.3', list, { beta: false, kind: 'appimage', arch: 'x64' }))
      .toMatchObject({ state: 'newer', offer: { version: '0.1.4', notes: 'New: updates.', asset: { name: 'roxora-imager-0.1.4-linux-x86_64.AppImage' } } });
  });
  it('fails plainly when GitHub does not answer with a list', async () => {
    await expect(fetchReleases(f, `${base}/missing`)).rejects.toThrow('HTTP 404');
    await expect(fetchReleases(f, `${base}/notalist`)).rejects.toThrow(/not a list/);
  });
});

describe('a download', () => {
  it('is kept when its SHA-256 is the listed one, with progress', async () => {
    const dest = join(work, 'ok.bin');
    const seen: number[] = [];
    await downloadVerified({ url: `${base}/files/x`, dest, sha256: sha(newApp), fetch: f, onProgress: (n, t) => { seen.push(n); expect(t).toBe(newApp.length); } });
    expect(readFileSync(dest).equals(newApp)).toBe(true);
    expect(seen.at(-1)).toBe(newApp.length);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
  it('is refused and deleted when the SHA-256 differs', async () => {
    const dest = join(work, 'bad.bin');
    await expect(downloadVerified({ url: `${base}/files/x`, dest, sha256: '0'.repeat(64), fetch: f })).rejects.toThrow(/not the published file/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
  it('is not even started without a listed SHA-256', async () => {
    let asked = 0;
    const counting: Fetch = (u, i) => { asked++; return f(u, i); };
    for (const sha256 of [null, '', 'abc']) {
      await expect(downloadVerified({ url: `${base}/files/x`, dest: join(work, 'none.bin'), sha256, fetch: counting })).rejects.toThrow(/lists no SHA-256/);
    }
    expect(asked).toBe(0);
    expect(existsSync(join(work, 'none.bin'))).toBe(false);
  });
  it('can be cancelled, leaving nothing behind', async () => {
    const dest = join(work, 'cancel.bin');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await expect(downloadVerified({ url: `${base}/files/slow`, dest, sha256: sha(newApp), fetch: f, signal: ac.signal })).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
  it('fails on a missing file', async () => {
    await expect(downloadVerified({ url: `${base}/nothing`, dest: join(work, 'x'), sha256: sha(newApp), fetch: f })).rejects.toThrow('HTTP 404');
  });
});

describe('replacing an AppImage', () => {
  const setup = (name: string) => {
    const dir = mkdtempSync(join(work, 'bin-'));
    const current = join(dir, name);
    writeFileSync(current, 'old version');
    chmodSync(current, 0o755);
    return { dir, current };
  };
  it('puts the checked new file under the old name, executable, with nothing else left in the folder', async () => {
    const { dir, current } = setup('roxora-imager.AppImage');
    const list = await fetchReleases(f, `${base}/releases`);
    const asset = pickAsset(newestRelease(list, { beta: false })!.assets, 'appimage', 'x64')!;
    await replaceAppImage(current, { url: asset.browser_download_url, sha256: assetSha256(asset), fetch: f });
    expect(readFileSync(current).equals(newApp)).toBe(true);
    expect(statSync(current).mode & 0o111).toBe(0o111);
    expect(readdirSync(dir)).toEqual(['roxora-imager.AppImage']);
  });
  it('leaves the old AppImage alone when the download is not the published file', async () => {
    const { dir, current } = setup('roxora-imager.AppImage');
    const list = await fetchReleases(f, `${base}/releases`);
    const wrong = pickAsset(newestRelease(list, { beta: false })!.assets, 'appimage', 'arm64')!;
    await expect(replaceAppImage(current, { url: wrong.browser_download_url, sha256: assetSha256(wrong), fetch: f })).rejects.toThrow(/not the published file/);
    const noDigest = pickAsset(newestRelease(list, { beta: false })!.assets, 'deb', 'x64')!;
    await expect(replaceAppImage(current, { url: noDigest.browser_download_url, sha256: assetSha256(noDigest), fetch: f })).rejects.toThrow(/lists no SHA-256/);
    expect(readFileSync(current, 'utf8')).toBe('old version');
    expect(readdirSync(dir)).toEqual(['roxora-imager.AppImage']);
  });
});

describe('installing a package', () => {
  it('uses the package manager that is there', () => {
    const has = (...names: string[]) => (p: string) => names.includes(p);
    expect(packageInstallCommand('deb', '/tmp/u/a.deb', has('apt-get'))).toEqual(['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '/tmp/u/a.deb']);
    expect(packageInstallCommand('rpm', '/tmp/u/a.rpm', has('dnf', 'zypper'))).toEqual(['dnf', 'install', '-y', '/tmp/u/a.rpm']);
    expect(packageInstallCommand('rpm', '/tmp/u/a.rpm', has('zypper'))).toEqual(['zypper', '--non-interactive', 'install', '--allow-unsigned-rpm', '/tmp/u/a.rpm']);
    expect(packageInstallCommand('deb', '/tmp/u/a.deb', has('dnf'))).toBeNull();
    expect(packageInstallCommand('appimage', '/tmp/x', has('apt-get'))).toBeNull();
  });
  it('gives the command to type instead', () => {
    expect(shellCommand(['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '/tmp/roxora-imager-update-Ab12/roxora-imager_0.1.4_amd64.deb']))
      .toBe('sudo apt-get install -y /tmp/roxora-imager-update-Ab12/roxora-imager_0.1.4_amd64.deb');
    expect(shellCommand(['dnf', 'install', '-y', "/tmp/it's here/a.rpm"])).toBe("sudo dnf install -y '/tmp/it'\\''s here/a.rpm'");
  });
});
