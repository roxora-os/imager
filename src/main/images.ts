// Getting an image onto this computer: download it, check it against the
// release, and for Maskrom decompress it (rkdeveloptool writes files as
// they are; RKDevelopTool-GUI decompresses first for the same reason).

import { net } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CatalogImage } from '../shared/catalog';

export type Progress = (p: { stage: 'download' | 'check' | 'decompress'; bytes: number; total: number }) => void;

async function sha256File(path: string, total: number, progress: Progress): Promise<string> {
  const h = createHash('sha256');
  let done = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20 })) {
    h.update(chunk as Buffer);
    done += (chunk as Buffer).length;
    progress({ stage: 'check', bytes: done, total });
  }
  return h.digest('hex');
}

/** A release file the catalog describes: the .img.xz, or the SPI image. */
export type ReleaseFile = Pick<CatalogImage, 'file' | 'url' | 'size' | 'sha256' | 'sample'>;

/**
 * A release file in the cache, downloaded if needed, always checked against
 * the catalog's sha256 before it is used.
 */
export async function fetchImage(img: ReleaseFile, cacheDir: string, progress: Progress, signal?: AbortSignal): Promise<string> {
  if (img.sample) throw new Error('Sample entries cannot be downloaded or written.');
  mkdirSync(cacheDir, { recursive: true });
  const dest = join(cacheDir, img.file);
  if (existsSync(dest) && statSync(dest).size === img.size) {
    if (await sha256File(dest, img.size, progress) === img.sha256) return dest;
    rmSync(dest, { force: true });
  }
  const part = `${dest}.part`;
  const r = await net.fetch(img.url, { signal });
  if (!r.ok || !r.body) throw new Error(`Download failed: HTTP ${r.status}`);
  const h = createHash('sha256');
  let done = 0;
  const body = Readable.fromWeb(r.body as never);
  body.on('data', (c: Buffer) => {
    h.update(c);
    done += c.length;
    progress({ stage: 'download', bytes: done, total: img.size });
  });
  try {
    await pipeline(body, createWriteStream(part), { signal });
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  const got = h.digest('hex');
  if (done !== img.size || got !== img.sha256) {
    rmSync(part, { force: true });
    throw new Error(`The download does not match the release (sha256 ${got}, expected ${img.sha256}).`);
  }
  renameSync(part, dest);
  return dest;
}

export type Compression = 'xz' | 'gzip' | 'bzip2' | null;

/** By content, not by name (RKDevelopTool-GUI's detect_compression does the same). */
export async function detectCompression(path: string): Promise<Compression> {
  const fh = await open(path, 'r');
  try {
    const b = Buffer.alloc(6);
    await fh.read(b, 0, 6, 0);
    if (b.equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return 'xz';
    if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
    if (b.subarray(0, 3).toString('latin1') === 'BZh') return 'bzip2';
    return null;
  } finally {
    await fh.close();
  }
}

/**
 * Decompress to a plain image next to the cache, hashing as it goes.
 * Uses etcher-sdk's decompressors, so .xz, .gz and .bz2 behave as on the
 * SD path. Returns the path and the SHA-256 of the decompressed bytes.
 */
export async function decompress(path: string, outDir: string, progress: Progress, signal?: AbortSignal, expected?: number):
  Promise<{ path: string; size: number; sha256: string }> {
  const { sourceDestination } = await import('etcher-sdk');
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

export function servedFile(token: string) {
  return served.get(token);
}

export function forgetFile(token: string, remove: boolean): void {
  const f = served.get(token);
  served.delete(token);
  if (f && remove) rmSync(f.path, { force: true });
}
