import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseCatalog, type CatalogImage } from '../src/shared/catalog';
import { downloadVerified, proxyBase, proxyUrl } from '../src/web/proxy';
import { fetchReleaseFile } from '../src/web/api';
import { upstreamUrl } from '../worker/src/proxy';

const sample = JSON.parse(readFileSync(new URL('../resources/sample-catalog.json', import.meta.url), 'utf8'));
const real = () => { const c = structuredClone(sample); delete c._sample; return c; };
const rock4d = (): CatalogImage => parseCatalog(real()).images.find((i) => i.board === 'radxa-rock-4d')!;

const bytes = new Uint8Array(1000).map((_, i) => i * 7);
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** An image whose .img.xz is `bytes`. */
const imageOf = (b: Uint8Array): CatalogImage => ({ ...rock4d(), size: b.length, sha256: hex(b) });

function serve(b: Uint8Array, opts: { status?: number; length?: string | null; chunk?: number; failAt?: number } = {}) {
  return vi.fn(async (_u: string | URL | Request) => {
    let at = 0;
    const step = opts.chunk ?? 100;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (opts.failAt !== undefined && at >= opts.failAt) { c.error(new TypeError('network')); return; }
        if (at >= b.length) { c.close(); return; }
        c.enqueue(b.slice(at, at + step));
        at += step;
      },
    });
    const headers: Record<string, string> = {};
    const len = opts.length === undefined ? String(b.length) : opts.length;
    if (len !== null) headers['Content-Length'] = len;
    return new Response(body, { status: opts.status ?? 200, headers });
  });
}

describe('download proxy setting', () => {
  it('is off when empty and takes only https or this computer', () => {
    expect(proxyBase(undefined)).toBeNull();
    expect(proxyBase('')).toBeNull();
    expect(proxyBase('  ')).toBeNull();
    expect(proxyBase('not a url')).toBeNull();
    expect(proxyBase('http://roxora-download.example.workers.dev')).toBeNull();
    expect(proxyBase('ftp://example.org')).toBeNull();
    expect(proxyBase('https://example.org/?x=1')).toBeNull();
    expect(proxyBase('https://roxora-download.example.workers.dev')).toBe('https://roxora-download.example.workers.dev');
    expect(proxyBase('https://roxora-download.example.workers.dev/')).toBe('https://roxora-download.example.workers.dev');
    expect(proxyBase('https://example.org/dl/')).toBe('https://example.org/dl');
    expect(proxyBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(proxyBase('http://localhost:8787/')).toBe('http://localhost:8787');
  });

  it('builds <base>/<tag>/<file> for the image and the SPI bootloader, paths the Worker accepts', () => {
    const img = rock4d();
    const base = 'https://dl.example';
    const u = proxyUrl(base, img, 'image')!;
    expect(u).toBe(`${base}/${img.releaseInfo.tag}/${img.file}`);
    const s = proxyUrl(base, img, 'spi')!;
    expect(s).toBe(`${base}/${img.releaseInfo.tag}/${img.spi!.file}`);
    // The Worker maps them to the same release download URLs the catalog has.
    expect(upstreamUrl(new URL(u).pathname)).toBe(img.url);
    expect(upstreamUrl(new URL(s).pathname)).toBe(img.spi!.url);
    expect(proxyUrl(base, { ...img, spi: null }, 'spi')).toBeNull();
  });
});

describe('download through the proxy', () => {
  it('hashes while streaming, reports progress and returns the file', async () => {
    const seen: number[] = [];
    const f = await downloadVerified('https://dl.example/x', { file: 'a.img.xz', size: bytes.length, sha256: hex(bytes) },
      (d) => seen.push(d), serve(bytes));
    expect(f.name).toBe('a.img.xz');
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(bytes);
    expect(seen.length).toBe(10);
    expect(seen.at(-1)).toBe(1000);
  });

  it('refuses a wrong checksum, size, status or a broken stream', async () => {
    const exp = { file: 'a.img.xz', size: bytes.length, sha256: hex(bytes) };
    const other = bytes.map((x) => x ^ 1);
    await expect(downloadVerified('u', exp, () => {}, serve(other))).rejects.toThrow(/checksum/);
    await expect(downloadVerified('u', exp, () => {}, serve(bytes, { length: '5' }))).rejects.toThrow(/wrong size/);
    await expect(downloadVerified('u', exp, () => {}, serve(new Uint8Array(1100), { length: null }))).rejects.toThrow(/larger/);
    await expect(downloadVerified('u', exp, () => {}, serve(bytes.slice(0, 500), { length: null }))).rejects.toThrow(/before the end/);
    await expect(downloadVerified('u', exp, () => {}, serve(bytes, { failAt: 300 }))).rejects.toThrow(/before the end/);
    await expect(downloadVerified('u', exp, () => {}, serve(bytes, { status: 403 }))).rejects.toThrow(/answered 403/);
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(downloadVerified('u', exp, () => {}, down)).rejects.toThrow(/could not be reached/);
  });

  it('gives a prepared file whose written checksum is the extracted image', async () => {
    const img = imageOf(bytes);
    const f = serve(bytes);
    const r = await fetchReleaseFile('https://dl.example', img, 'image', () => {}, f);
    expect(f.mock.calls[0][0]).toBe(`https://dl.example/${img.releaseInfo.tag}/${img.file}`);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.sha256).toBe(img.extractSha256);
      expect(r.size).toBe(bytes.length);
      expect(r.file?.name).toBe(img.file);
    }
  });

  it('falls back with one sentence when there is no proxy or it fails', async () => {
    const img = imageOf(bytes);
    const f = serve(bytes);
    expect(await fetchReleaseFile(null, img, 'image', () => {}, f)).toEqual({ error: 'This page has no download service set up.' });
    expect(f).not.toHaveBeenCalled();
    expect(await fetchReleaseFile('https://dl.example', { ...img, sample: true }, 'image', () => {}, f)).toMatchObject({ error: /not from a published release/ });
    expect(await fetchReleaseFile('https://dl.example', img, 'image', () => {}, serve(bytes, { status: 502 })))
      .toEqual({ error: 'The download through dl.example did not work: the download service answered 502.' });
    const bad = await fetchReleaseFile('https://dl.example', img, 'image', () => {}, serve(bytes.map((x) => x ^ 1)));
    expect(bad).toEqual({ error: 'The download through dl.example did not work: the download does not match the release checksum.' });
  });
});
