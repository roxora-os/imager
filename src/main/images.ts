// Getting an image onto this computer: download it, check it against the
// release, and for Maskrom decompress it (rkdeveloptool writes files as
// they are; RKDevelopTool-GUI decompresses first for the same reason).

import { net } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { downloadReleaseFile, type Progress, type ReleaseFile } from './release-download';

export type { Progress, ReleaseFile } from './release-download';

/**
 * A release file in the cache, downloaded if needed (an image in parts part
 * after part), always checked against the catalog's sha256 before it is used.
 */
export function fetchImage(img: ReleaseFile, cacheDir: string, progress: Progress, signal?: AbortSignal): Promise<string> {
  return downloadReleaseFile(img, cacheDir, progress, signal, (url, init) => net.fetch(url, init));
}

export { detectCompression, type Compression } from './image-source';

/**
 * Decompress to a plain image next to the cache, hashing as it goes.
 * Uses etcher-sdk's decompressors, so .xz, .gz and .bz2 behave as on the
 * SD path. Returns the path and the SHA-256 of the decompressed bytes.
 */
export async function decompress(path: string, outDir: string, progress: Progress, signal?: AbortSignal, expected?: number):
  Promise<{ path: string; size: number; sha256: string }> {
  // Not the index: it loads etcher-sdk's USB boot scanners (see write-helper.ts).
  // require(), not import(): see openImage() in mac-write.ts.
  const sourceDestination = require('etcher-sdk/build/source-destination') as typeof import('etcher-sdk/build/source-destination');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `maskrom-${randomBytes(6).toString('hex')}.img`);
  const file = new sourceDestination.File({ path });
  const inner = await file.getInnerSource();
  const total = statSync(path).size;
  const h = createHash('sha256');
  let size = 0;
  try {
    const rs = await inner.createReadStream();
    (rs as NodeJS.ReadableStream).on('data', (c: Buffer) => {
      h.update(c);
      size += c.length;
      // The compressed position is not exposed; the bar counts output bytes
      // against the expected size the caller passes in, or the input size.
      progress({ stage: 'decompress', bytes: size, total: Math.max(expected ?? total, size) });
    });
    await pipeline(rs as NodeJS.ReadableStream, createWriteStream(out), { signal });
  } catch (e) {
    rmSync(out, { force: true });
    throw e;
  } finally {
    await inner.close().catch(() => {});
  }
  return { path: out, size, sha256: h.digest('hex') };
}

/**
 * Files the renderer's Maskrom worker may read, by token. The worker reads
 * them through app://local/file/<token> with Range requests.
 */
const served = new Map<string, { path: string; size: number }>();

export function serveFile(path: string): { token: string; size: number } {
  const token = randomBytes(16).toString('hex');
  const size = statSync(path).size;
  served.set(token, { path, size });
  return { token, size };
}

/** Serve a file under a fixed token (tests only). */
export function serveFileAs(token: string, path: string): void {
  served.set(token, { path, size: statSync(path).size });
}

/** The paths being served now. */
export function servedPaths(): string[] {
  return [...served.values()].map((f) => f.path);
}

export function servedFile(token: string) {
  return served.get(token);
}

export function forgetFile(token: string, remove: boolean): void {
  const f = served.get(token);
  served.delete(token);
  if (f && remove) rmSync(f.path, { force: true });
}
