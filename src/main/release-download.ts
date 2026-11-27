// Downloading a release file into the cache, checked against the catalog.
// One file, or an image a release carries in parts (roxora-os/build
// docs/release-contract.md, "Images in parts"): the parts are downloaded in
// order and appended to one file, which is the image. No Electron here, so
// the tests run it against a local server.
//
// A download that fails or is cancelled keeps its `<file>.part`, and the
// next one goes on from there with an HTTP Range request; a
// server that answers the whole file instead is read from the start of the
// part again. Short network failures are tried again a few times, waiting
// longer each time, before the error is shown. Whatever was resumed, the
// joined file is checked against the release's SHA-256 at the end; a
// mismatch deletes it, and a resumed one is then downloaded once more from
// nothing.

import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CatalogImage } from '../shared/catalog';

export type Progress = (p: { stage: 'download' | 'check' | 'decompress'; bytes: number; total: number }) => void;

export type FetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

/** A release file the catalog describes: the .img.xz (whole or in parts), or the SPI image. */
export type ReleaseFile = Pick<CatalogImage, 'file' | 'url' | 'size' | 'sha256' | 'sample'> & Partial<Pick<CatalogImage, 'parts'>>;

export interface RetryOptions {
  /** Further tries after a network failure, per part. Default 3. */
  retries?: number;
  /** The first wait; doubled each time. Default 1000 ms. */
  backoffMs?: number;
}

async function sha256File(path: string, total: number, progress: Progress, start = 0, end?: number): Promise<string> {
  const h = createHash('sha256');
  let done = 0;
  if (end !== undefined && end <= start) return h.digest('hex');
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20, start, ...(end !== undefined ? { end: end - 1 } : {}) })) {
    h.update(chunk as Buffer);
    done += (chunk as Buffer).length;
    progress({ stage: 'check', bytes: done, total });
  }
  return h.digest('hex');
}

/** The bytes of a file from start to end, hashed into h. */
async function hashInto(h: ReturnType<typeof createHash>, path: string, start: number, end: number): Promise<void> {
  if (end <= start) return;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20, start, end: end - 1 })) h.update(chunk as Buffer);
}

/** What the release does not match: the download is thrown away, not kept for later. */
class Mismatch extends Error {}
/** An answer that trying again will not change (404, 403 ...). */
class Refused extends Error {}

const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0);

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Cancelled.')); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(new Error('Cancelled.')); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * A release file in the cache, downloaded if needed, always checked against
 * the catalog's sha256 before it is used.
 *
 * An image in parts is downloaded part after part into one `<file>.part`
 * file, with the progress counted over the whole image. Each part is checked
 * against its own size and SHA-256 as it ends, so a bad part stops the
 * download there, and the joined file against the image's. A file that does
 * not match is deleted; a failure or a cancel keeps what was downloaded for
 * the next try (see the top of this file).
 */
export async function downloadReleaseFile(img: ReleaseFile, cacheDir: string, progress: Progress,
  signal: AbortSignal | undefined, fetchFn: FetchFn, retry: RetryOptions = {}): Promise<string> {
  if (img.sample) throw new Error('Sample entries cannot be downloaded or written.');
  mkdirSync(cacheDir, { recursive: true });
  const dest = join(cacheDir, img.file);
  if (existsSync(dest) && statSync(dest).size === img.size) {
    if (await sha256File(dest, img.size, progress) === img.sha256) return dest;
    rmSync(dest, { force: true });
  }
  let at = 0;
  const sources = (img.parts && img.parts.length > 0
    ? img.parts.map((p, i) => ({ url: p.url, size: p.size, sha256: p.sha256, name: `part ${i + 1} of ${img.parts!.length}` }))
    : [{ url: img.url, size: img.size, sha256: img.sha256, name: '' }]).map((x) => { const o = { ...x, start: at }; at += x.size; return o; });
  const part = `${dest}.part`;
  const retries = retry.retries ?? 3;
  const backoff = retry.backoffMs ?? 1000;

  for (let fresh = false; ; fresh = true) {
    if (fresh || sizeOf(part) > img.size) rmSync(part, { force: true });
    const resumed = sizeOf(part) > 0;
    try {
      for (const src of sources) {
        const end = src.start + src.size;
        const h = createHash('sha256');
        for (let attempt = 0; ; attempt++) {
          let have = Math.min(sizeOf(part), end);
          if (have < src.start) throw new Mismatch(`The partly downloaded file is shorter than ${src.name || 'expected'}.`);
          if (have === end) break;
          try {
            const from = have - src.start;
            const r = await fetchFn(src.url, { signal, ...(from > 0 ? { headers: { Range: `bytes=${from}-` } } : {}) });
            const range = /^bytes (\d+)-/.exec(r.headers.get('content-range') ?? '');
            if (r.status === 206 && range && Number(range[1]) === from) { /* goes on from `have` */ }
            else if (r.status === 206) {
              // Some other range: start this source over on the next try.
              await r.body?.cancel();
              truncateSync(part, src.start);
              throw new Error(`Download failed: the server sent another part of the file${src.name ? ` for ${src.name}` : ''}`);
            } else if (r.ok) {
              // The whole file again (no Range support): this source starts over.
              if (from > 0) { truncateSync(part, src.start); have = src.start; }
            } else if (r.status >= 500 || r.status === 429) {
              throw new Error(`Download failed: HTTP ${r.status}${src.name ? ` for ${src.name}` : ''}`);
            } else {
              throw new Refused(`Download failed: HTTP ${r.status}${src.name ? ` for ${src.name}` : ''}`);
            }
            if (!r.body) throw new Error(`Download failed: no data${src.name ? ` for ${src.name}` : ''}`);
            if (have === 0) closeSync(openSync(part, 'w'));
            let done = have;
            const count = new Transform({
              transform(chunk: Buffer, _enc, cb) {
                done += chunk.length;
                if (done > end) { cb(new Mismatch(`The download${src.name ? ` of ${src.name}` : ''} is longer than the release states.`)); return; }
                progress({ stage: 'download', bytes: done, total: img.size });
                cb(null, chunk);
              },
            });
            await pipeline(Readable.fromWeb(r.body as never), count, createWriteStream(part, { flags: 'a' }), { signal });
            if (sizeOf(part) !== end) throw new Error(`The download${src.name ? ` of ${src.name}` : ''} ended early.`);
            break;
          } catch (e) {
            if (signal?.aborted || e instanceof Mismatch || e instanceof Refused || attempt >= retries) throw e;
            await wait(backoff * 2 ** attempt, signal);
          }
        }
        if (sources.length > 1) {
          await hashInto(h, part, src.start, end);
          const sum = h.digest('hex');
          if (sum !== src.sha256) throw new Mismatch(`The download of ${src.name} does not match the release (sha256 ${sum}, expected ${src.sha256}).`);
        }
      }
      const sum = await sha256File(part, img.size, progress);
      if (sizeOf(part) !== img.size || sum !== img.sha256) {
        throw new Mismatch(`The download does not match the release (sha256 ${sum}, expected ${img.sha256}).`);
      }
    } catch (e) {
      if (!(e instanceof Mismatch)) throw e;
      rmSync(part, { force: true });
      // What was there before may have been another file's start: once more from nothing.
      if (resumed && !fresh) continue;
      throw e;
    }
    renameSync(part, dest);
    return dest;
  }
}
