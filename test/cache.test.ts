// The cache Settings can clear: what it measures, what it deletes, what it keeps.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheInfo, clearCache, inCache } from '../src/main/cache';

function dataDir() {
  const d = mkdtempSync(join(tmpdir(), 'cache-'));
  const put = (p: string, n: number) => { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), Buffer.alloc(n, 1)); };
  put('images/roxora-radxa-rock-4d-noble-edge-2026.11.0.img.xz', 1000);
  put('images/maskrom/roxora-radxa-rock-4d-noble-edge-2026.11.0.img', 3000);
  // A download that was broken off, kept to go on from (release-download.ts).
  put('images/roxora-radxa-rock-4d-noble-edge-2026.11.1.img.xz.part', 300);
  put('loaders/rk3576_spl_loader.bin', 200);
  put('settings.json', 20);
  return d;
}

describe('the cache', () => {
  it('measures the downloads and the loaders apart', () => {
    const d = dataDir();
    const c = cacheInfo(d);
    expect(c.images).toMatchObject({ bytes: 4300, files: 3, names: ['maskrom', 'roxora-radxa-rock-4d-noble-edge-2026.11.0.img.xz', 'roxora-radxa-rock-4d-noble-edge-2026.11.1.img.xz.part'] });
    expect(c.loaders).toMatchObject({ bytes: 200, files: 1 });
    rmSync(d, { recursive: true, force: true });
    expect(cacheInfo(d).images).toMatchObject({ bytes: 0, files: 0, names: [] });
  });
  it('deletes the downloads and loaders, keeps the settings', () => {
    const d = dataDir();
    expect(clearCache(d, { busy: false })).toMatchObject({ ok: true, freed: 4500 });
    expect(existsSync(join(d, 'images'))).toBe(false);
    expect(existsSync(join(d, 'loaders'))).toBe(false);
    expect(existsSync(join(d, 'settings.json'))).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
  it('refuses while a write runs, and deletes nothing', () => {
    const d = dataDir();
    expect(clearCache(d, { busy: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/write is running/) });
    expect(cacheInfo(d).images.files).toBe(3);
    rmSync(d, { recursive: true, force: true });
  });
  it('knows which files are in it', () => {
    const d = '/home/u/.config/Roxora Imager';
    expect(inCache(d, join(d, 'images', 'maskrom', 'a.img'))).toBe(true);
    expect(inCache(d, join(d, 'loaders', 'rk3576_spl_loader.bin'))).toBe(true);
    expect(inCache(d, join(d, 'settings.json'))).toBe(false);
    expect(inCache(d, join(d, 'images'))).toBe(false);
    expect(inCache(d, '/home/u/Downloads/a.img')).toBe(false);
  });
});
