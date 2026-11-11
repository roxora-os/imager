// The app's pages are served from app://local/, a secure origin of its own
// (WebUSB needs one). Every response carries COOP/COEP like edk2-webflash's
// coi-serviceworker.js, so the page is cross-origin isolated as there.
//
// app://local/file/<token> serves an image file the main process prepared
// for the Maskrom worker, with Range requests, so the worker reads it in
// pieces and never holds it whole. app://local/loader/<name> serves the
// Maskrom loader from the user data folder once it matches its pin.

import { protocol } from 'electron';
import { createReadStream, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { servedFile } from './images';
import { cachedLoader } from './loader-cache';

export const SCHEME = 'app';
export const ORIGIN = 'app://local';

export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }]);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.bin': 'application/octet-stream',
};

const SECURITY = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
};

const WORKER_CSP = SECURITY['Content-Security-Policy'].replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'");

/** Parse "bytes=a-b"; null when absent or unsatisfiable. */
export function parseRange(h: string | null, size: number): { start: number; end: number } | null {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!n) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!(start <= end) || start >= size) return null;
  return { start, end };
}

export function handleProtocol(rendererDir: string, resourcesDir: string, loaderDir: string): void {
  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'local') return new Response('not found', { status: 404 });
    const path = decodeURIComponent(url.pathname);

    if (path.startsWith('/file/')) {
      const f = servedFile(path.slice(6));
      if (!f) return new Response('not found', { status: 404, headers: SECURITY });
      const range = parseRange(req.headers.get('range'), f.size);
      const start = range?.start ?? 0;
      const end = range?.end ?? f.size - 1;
      const body = Readable.toWeb(createReadStream(f.path, { start, end })) as ReadableStream;
      return new Response(body, {
        status: range ? 206 : 200,
        headers: {
          ...SECURITY, 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${f.size}` } : {}),
        },
      });
    }

    if (path.startsWith('/loader/')) {
      const data = cachedLoader(loaderDir, path.slice('/loader/'.length));
      if (!data) return new Response('not found', { status: 404, headers: SECURITY });
      return new Response(data as BlobPart, { headers: { ...SECURITY, 'Content-Type': 'application/octet-stream' } });
    }

    // Static files: the renderer build, and resources/.
    const base = path.startsWith('/resources/') ? resourcesDir : rendererDir;
    const rel = path.startsWith('/resources/') ? path.slice('/resources/'.length) : path.slice(1) || 'index.html';
    const full = normalize(join(base, rel));
    if (!full.startsWith(normalize(base) + sep)) return new Response('not found', { status: 404 });
    // A worker gets its CSP from its own script's response. rkdeveloptool's
    // embind glue builds functions with new Function(), so the worker that
    // runs it needs 'unsafe-eval'; the page itself does not get it.
    const headers: Record<string, string> = { ...SECURITY, 'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream' };
    if (rel.endsWith('-worker.js')) headers['Content-Security-Policy'] = WORKER_CSP;
    try {
      const data = readFileSync(full);
      return new Response(data, { headers });
    } catch {
      return new Response('not found', { status: 404, headers: SECURITY });
    }
  });
}
