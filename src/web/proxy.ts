// Release downloads through the Roxora download proxy (worker/ in this
// repo). GitHub sends no CORS headers on release downloads, so the web
// build cannot read them itself; the proxy serves the same files with
// those headers. Its address is set at build time (ROXORA_DOWNLOAD_PROXY);
// without one, or when it fails, the page asks the user to download the
// file and choose it, as before.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { CatalogImage } from '../shared/catalog';

/**
 * The proxy's base URL from the build setting, or null for none. Only
 * https, or http on this computer for testing with `wrangler dev`.
 */
export function proxyBase(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (u.protocol !== 'https:' && !local) return null;
  if (u.search || u.hash || u.username || u.password) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/** What to download for an image: the .img.xz or its SPI bootloader. */
export function releaseFile(img: CatalogImage, what: 'image' | 'spi'): { file: string; size: number; sha256: string } | null {
  if (what === 'spi') return img.spi ? { file: img.spi.file, size: img.spi.size, sha256: img.spi.sha256 } : null;
  return { file: img.file, size: img.size, sha256: img.sha256 };
}

/** The proxy URL of a release file: <base>/<tag>/<file>, as the Worker maps it. */
export function proxyUrl(base: string, img: CatalogImage, what: 'image' | 'spi'): string | null {
  const f = releaseFile(img, what);
  const tag = img.releaseInfo?.tag;
  if (!f || !tag) return null;
  return `${base}/${encodeURIComponent(tag)}/${encodeURIComponent(f.file)}`;
}

/**
 * Download `url`, hashing while it streams, and return the bytes as a File
 * only when size and SHA-256 are the expected ones. Throws an Error with a
 * short reason otherwise.
 */
export async function downloadVerified(
  url: string,
  expected: { file: string; size: number; sha256: string },
  onProgress: (done: number, total: number) => void,
  fetchFn: typeof fetch = fetch,
): Promise<File> {
  let r: Response;
  try {
    r = await fetchFn(url);
  } catch {
    throw new Error('the download service could not be reached');
  }
  if (!r.ok || !r.body) throw new Error(`the download service answered ${r.status}`);
  const len = r.headers.get('Content-Length');
  if (len !== null && Number(len) !== expected.size) throw new Error('the download has the wrong size');
  const h = sha256.create();
  const parts: Uint8Array[] = [];
  const reader = r.body.getReader();
  let done = 0;
  try {
    for (;;) {
      const c = await reader.read();
      if (c.done) break;
      done += c.value.length;
      if (done > expected.size) throw new Error('the download is larger than the release file');
      h.update(c.value);
      parts.push(c.value);
      onProgress(done, expected.size);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    if (e instanceof Error && e.message.startsWith('the download')) throw e;
    throw new Error('the download stopped before the end');
  }
  if (done !== expected.size) throw new Error('the download stopped before the end');
  if (bytesToHex(h.digest()) !== expected.sha256) throw new Error('the download does not match the release checksum');
  return new File(parts as BlobPart[], expected.file, { type: 'application/octet-stream' });
}
