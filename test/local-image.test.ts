import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { catalogMatch, describeLocal, measureImage, sha256OfFile } from '../src/main/local-image';
import type { CatalogImage } from '../src/shared/catalog';

const work = mkdtempSync(join(tmpdir(), 'local-image-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const file = (name: string, data: Buffer) => { const p = join(work, name); writeFileSync(p, data); return p; };
const XZ = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);

const NAME = 'roxora-radxa-rock-4d-noble-edge-2026.11.3.img.xz';
const released = Buffer.concat([XZ, randomBytes(5000)]);
const image = (over: Partial<CatalogImage> = {}): CatalogImage => ({
  id: `2026.11.3/${NAME}`, board: 'radxa-rock-4d', boardName: 'Radxa ROCK 4D', vendor: 'Radxa', soc: 'rk3576',
  release: 'noble', ubuntuVersion: '24.04', branch: 'edge', kernel: '6.18', file: NAME, url: 'https://example.invalid/x',
  size: released.length, sha256: sha(released), extractSize: 4000000000, extractSha256: 'e'.repeat(64),
  status: 'ci-only', verifyUrl: '', spi: null, sample: false,
  releaseInfo: { version: '2026.11.3' } as CatalogImage['releaseInfo'], ...over,
} as CatalogImage);

describe('matching a file name with the release list', () => {
  it('matches the exact file name only', () => {
    const imgs = [image()];
    expect(catalogMatch(NAME, imgs)?.id).toBe(`2026.11.3/${NAME}`);
    for (const n of [NAME.replace('.xz', ''), NAME.toUpperCase(), `copy of ${NAME}`, NAME.replace('11.3', '11.4'), `${NAME} (1)`, '']) {
      expect(catalogMatch(n, imgs)).toBeNull();
    }
  });
  it('never matches sample entries, and matches nothing without releases', () => {
    expect(catalogMatch(NAME, [image({ sample: true })])).toBeNull();
    expect(catalogMatch(NAME, [])).toBeNull();
  });
});

describe('looking at a chosen file', () => {
  it('takes a file with a release name and the release SHA-256 as that release image', async () => {
    const seen: number[] = [];
    const d = await describeLocal(file(NAME, released), [image()], { onCheck: (n) => seen.push(n) });
    expect(d).toMatchObject({ name: NAME, size: released.length, extractSize: 4000000000, compression: 'xz' });
    expect(d.image?.id).toBe(`2026.11.3/${NAME}`);
    expect(seen.at(-1)).toBe(released.length);
  });
  it('refuses a file with a release name whose contents differ', async () => {
    const changed = Buffer.from(released);
    changed[100] ^= 1;
    mkdirSync(join(work, 'changed'));
    await expect(describeLocal(file(`changed/${NAME}`, changed), [image()])).rejects.toThrow(/name of a Roxora release image but is not that file.*SHA-256/);
    mkdirSync(join(work, 'short'));
    await expect(describeLocal(file(`short/${NAME}`, released.subarray(0, 900)), [image()])).rejects.toThrow(/holds 900 bytes/);
  });
  it('takes any other file as a custom image, with the size it will have on the drive', async () => {
    const plain = randomBytes(3000);
    expect(await describeLocal(file('my.img', plain), [image()]))
      .toEqual({ name: 'my.img', size: 3000, extractSize: 3000, compression: null, image: null });
    const xz = await describeLocal(file('my.img.xz', Buffer.concat([XZ, randomBytes(50)])), [image()], { xzSize: async () => 123456 });
    expect(xz).toEqual({ name: 'my.img.xz', size: 56, extractSize: 123456, compression: 'xz', image: null });
    const gz = await describeLocal(file('my.img.gz', Buffer.concat([Buffer.from([0x1f, 0x8b]), randomBytes(50)])), []);
    expect(gz).toMatchObject({ extractSize: 0, compression: 'gzip', image: null });
    const broken = await describeLocal(file('odd.xz', Buffer.concat([XZ, randomBytes(50)])), [], { xzSize: async () => { throw new Error('no index'); } });
    expect(broken.extractSize).toBe(0);
  });
  it('refuses what cannot be an image', async () => {
    await expect(describeLocal(file('empty.img', Buffer.alloc(0)), [])).rejects.toThrow(/empty/);
    await expect(describeLocal(file('a.zip', Buffer.concat([Buffer.from('PK\x03\x04'), randomBytes(40)])), [])).rejects.toThrow(/zip archive/);
    await expect(describeLocal(join(work, 'missing.img'), [])).rejects.toThrow(/not a file that can be read/);
    await expect(describeLocal(work, [])).rejects.toThrow(/not a file that can be read/);
  });
});

describe('the checksum of a custom image', () => {
  it('is the SHA-256 and size of the decompressed data', async () => {
    const data = randomBytes(300000);
    const seen: number[] = [];
    const m = await measureImage({ stream: Readable.from([data.subarray(0, 1000), data.subarray(1000)]), close: async () => {} }, (n) => seen.push(n));
    expect(m).toEqual({ size: data.length, sha256: sha(data) });
    expect(seen).toEqual([1000, data.length]);
  });
  it('stops when cancelled', async () => {
    const ac = new AbortController();
    const endless = new Readable({ read() { this.push(Buffer.alloc(1024)); } });
    setTimeout(() => ac.abort(), 50);
    await expect(measureImage({ stream: endless, close: async () => {} }, () => {}, ac.signal)).rejects.toThrow();
  });
  it('hashes a file as it is', async () => {
    const data = randomBytes(70000);
    expect(await sha256OfFile(file('h.bin', data), () => {})).toBe(sha(data));
  });
});
