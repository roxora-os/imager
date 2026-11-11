import { describe, expect, it, vi } from 'vitest';
import { allowedFile, handle, originAllowed, upstreamUrl } from '../worker/src/proxy';

const IMG = 'roxora-armsom-cm5-io-noble-edge-2026.11.0.img.xz';
const BASE = 'https://dl.example/';

function req(path: string, init: RequestInit & { origin?: string | null } = {}) {
  const headers = new Headers(init.headers);
  const origin = init.origin === undefined ? 'https://roxora-os.github.io' : init.origin;
  if (origin) headers.set('Origin', origin);
  return new Request(BASE + path.replace(/^\//, ''), { method: init.method ?? 'GET', headers });
}

function upstream(status = 200, headers: Record<string, string> = {}, body = 'data') {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(status === 304 ? null : body, { status, headers }));
}

describe('names the proxy serves', () => {
  it('takes the release contract names for the tag\'s version', () => {
    for (const f of [IMG, `${IMG}.sha256`, 'roxora-radxa-rock-4d-noble-edge-2026.11.0-spi.img',
      'roxora-radxa-rock-4d-noble-edge-2026.11.0-spi.img.sha256', 'roxora-armsom-cm5-io-noble-edge-2026.11.0.verify.txt',
      'roxora-catalog.json', 'SHA256SUMS']) {
      expect(allowedFile(f, '2026.11.0'), f).toBe(true);
    }
  });
  it('takes every file of the published release v2026.11.1', () => {
    const files = ['roxora-armsom-cm5-io-noble-edge-2026.11.1.img.xz', 'roxora-armsom-cm5-io-noble-edge-2026.11.1.img.xz.sha256',
      'roxora-armsom-cm5-io-noble-edge-2026.11.1.verify.txt', 'roxora-catalog.json', 'roxora-radxa-rock-4d-noble-edge-2026.11.1-spi.img',
      'roxora-radxa-rock-4d-noble-edge-2026.11.1-spi.img.sha256', 'roxora-radxa-rock-4d-noble-edge-2026.11.1.img.xz',
      'roxora-radxa-rock-4d-noble-edge-2026.11.1.img.xz.sha256', 'roxora-radxa-rock-4d-noble-edge-2026.11.1.verify.txt', 'SHA256SUMS'];
    for (const f of files) expect(upstreamUrl(`/v2026.11.1/${f}`), f).not.toBeNull();
  });
  it('refuses everything else', () => {
    for (const f of ['roxora-armsom-cm5-io-noble-edge-2026.11.1.img.xz', 'roxora-x-2026.11.0.img.xz', 'evil.exe',
      'roxora-armsom-cm5-io-noble-edge-2026.11.0.img', 'roxora-Armsom-cm5-io-noble-edge-2026.11.0.img.xz',
      'roxora-a-b-c-2026.11.0.img.xz.zip', '../roxora-catalog.json', 'SHA256SUMS.asc', '']) {
      expect(allowedFile(f, '2026.11.0'), f).toBe(false);
    }
  });
  it('maps /<tag>/<file> to the release download URL and nothing else', () => {
    expect(upstreamUrl(`/v2026.11.0/${IMG}`)).toBe(`https://github.com/roxora-os/build/releases/download/v2026.11.0/${IMG}`);
    expect(upstreamUrl(`/2026.11.0/${IMG}`)).toBeNull();
    expect(upstreamUrl(`/v2026.11/${IMG}`)).toBeNull();
    expect(upstreamUrl(`/v2026.11.0/x/${IMG}`)).toBeNull();
    expect(upstreamUrl('/v2026.11.0/')).toBeNull();
    expect(upstreamUrl('/https://evil.example/x')).toBeNull();
  });
  it('knows its origins', () => {
    expect(originAllowed('https://roxora-os.github.io')).toBe(true);
    expect(originAllowed('http://localhost:8080')).toBe(true);
    expect(originAllowed('http://127.0.0.1:43210')).toBe(true);
    expect(originAllowed(null)).toBe(true);
    expect(originAllowed('https://evil.example')).toBe(false);
    expect(originAllowed('https://roxora-os.github.io.evil.example')).toBe(false);
    expect(originAllowed('http://localhost.evil.example')).toBe(false);
  });
});

describe('requests', () => {
  it('says what it is at /', async () => {
    const f = upstream();
    const r = await handle(req('/'), f);
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/^Roxora download proxy/);
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses other methods with 405, other paths with 404, other origins with 403, without asking GitHub', async () => {
    const f = upstream();
    expect((await handle(req(`/v2026.11.0/${IMG}`, { method: 'POST' }), f)).status).toBe(405);
    expect((await handle(req(`/v2026.11.0/${IMG}`, { method: 'PUT' }), f)).status).toBe(405);
    expect((await handle(req(`/v2026.11.0/${IMG}`, { method: 'DELETE' }), f)).status).toBe(405);
    expect((await handle(req('/v2026.11.0/evil.exe'), f)).status).toBe(404);
    expect((await handle(req('/robots.txt'), f)).status).toBe(404);
    expect((await handle(req(`/v2026.11.0/${IMG}`, { origin: 'https://evil.example' }), f)).status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it('answers the CORS preflight', async () => {
    const r = await handle(req(`/v2026.11.0/${IMG}`, { method: 'OPTIONS' }), upstream());
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://roxora-os.github.io');
    expect(r.headers.get('Access-Control-Allow-Headers')).toMatch(/Range/);
    expect(r.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
  });

  it('passes Range and the conditional headers on, follows the redirect, copies the response headers', async () => {
    const f = upstream(206, {
      'Content-Length': '4', 'Content-Range': 'bytes 0-3/100', 'Accept-Ranges': 'bytes', ETag: '"abc"',
      'Last-Modified': 'Wed, 11 Nov 2026 00:00:00 GMT', 'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=300', 'Set-Cookie': 'x=y', 'X-Other': 'no',
    });
    const r = await handle(req(`/v2026.11.0/${IMG}`, {
      headers: { Range: 'bytes=0-3', 'If-None-Match': '"zzz"', 'If-Modified-Since': 'Tue, 10 Nov 2026 00:00:00 GMT', Cookie: 'secret' },
    }), f);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://github.com/roxora-os/build/releases/download/v2026.11.0/${IMG}`);
    const sent = new Headers(init!.headers);
    expect(sent.get('range')).toBe('bytes=0-3');
    expect(sent.get('if-none-match')).toBe('"zzz"');
    expect(sent.get('if-modified-since')).toBe('Tue, 10 Nov 2026 00:00:00 GMT');
    expect(sent.get('cookie')).toBeNull();
    expect(init!.redirect).toBe('follow');
    expect(r.status).toBe(206);
    for (const [k, v] of [['Content-Range', 'bytes 0-3/100'], ['Accept-Ranges', 'bytes'], ['ETag', '"abc"'],
      ['Cache-Control', 'public, max-age=300'], ['Content-Type', 'application/octet-stream'],
      ['Access-Control-Allow-Origin', 'https://roxora-os.github.io'], ['Vary', 'Origin']]) {
      expect(r.headers.get(k), k).toBe(v);
    }
    expect(r.headers.get('Access-Control-Expose-Headers')).toMatch(/Content-Range/);
    expect(r.headers.get('Set-Cookie')).toBeNull();
    expect(r.headers.get('X-Other')).toBeNull();
    expect(await r.text()).toBe('data');
  });

  it('streams the body through without reading it first', async () => {
    let pulled = 0;
    const body = new ReadableStream({ pull(c) { pulled++; if (pulled > 3) c.close(); else c.enqueue(new Uint8Array([pulled])); } });
    const f = vi.fn(async () => new Response(body, { status: 200 }));
    const r = await handle(req(`/v2026.11.0/${IMG}`), f);
    expect(pulled).toBeLessThanOrEqual(1); // nothing consumed before the client reads
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('passes 304 through and has no body for HEAD', async () => {
    expect((await handle(req(`/v2026.11.0/${IMG}`), upstream(304, { ETag: '"abc"' }))).status).toBe(304);
    const h = await handle(req(`/v2026.11.0/${IMG}`, { method: 'HEAD' }), upstream(200, { 'Content-Length': '10' }));
    expect(h.status).toBe(200);
    expect(h.headers.get('Content-Length')).toBe('10');
  });

  it('serves clients that send no Origin, without CORS headers', async () => {
    const r = await handle(req(`/v2026.11.0/${IMG}`, { origin: null }), upstream());
    expect(r.status).toBe(200);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('says plainly when GitHub has no such file', async () => {
    const r = await handle(req(`/v2026.11.9/roxora-armsom-cm5-io-noble-edge-2026.11.9.img.xz`), upstream(404));
    expect(r.status).toBe(404);
    expect(await r.text()).toMatch(/No such file/);
  });

  it('keeps Content-Range on a 416 and says so when GitHub cannot be reached', async () => {
    const r = await handle(req(`/v2026.11.0/${IMG}`, { headers: { Range: 'bytes=999-' } }), upstream(416, { 'Content-Range': 'bytes */100' }));
    expect(r.status).toBe(416);
    expect(r.headers.get('Content-Range')).toBe('bytes */100');
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://roxora-os.github.io');
    const down = vi.fn(async () => { throw new TypeError('network'); });
    const d = await handle(req(`/v2026.11.0/${IMG}`), down);
    expect(d.status).toBe(502);
    expect(d.headers.get('Access-Control-Allow-Origin')).toBe('https://roxora-os.github.io');
  });

  it('refuses paths that try to leave the release directory', async () => {
    const f = upstream();
    for (const p of ['/v2026.11.0/..%2Froxora-catalog.json', '/v2026.11.0/%2e%2e/SHA256SUMS', '/v2026.11.0//SHA256SUMS',
      '/v2026.11.0/roxora-catalog.json/extra']) {
      expect((await handle(req(p), f)).status, p).toBe(404);
    }
    expect(f).not.toHaveBeenCalled();
    // A query string is dropped, never passed on.
    await handle(req('/v2026.11.0/SHA256SUMS?x=1/../evil'), f);
    expect(f.mock.calls[0][0]).toBe('https://github.com/roxora-os/build/releases/download/v2026.11.0/SHA256SUMS');
  });
});

