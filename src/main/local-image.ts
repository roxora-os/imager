// An image file on this computer for the SD card / USB drive path, instead
// of one downloaded from the release list. No Electron here, so the CI
// write tests can load it too.
//
// A file named like an image of a loaded Roxora release must be that file:
// its SHA-256 is compared with the release, and it is then written and read
// back exactly as a downloaded one. Any other file is a custom image: there
// is nothing to compare it with before writing, so it is read once to take
// the size and SHA-256 of its decompressed data, and the drive is read back
// against those.

import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CatalogImage } from '../shared/catalog';
import { detectCompression, openImage, xzExtractSize, type Compression, type ImageSource } from './image-source';

/** The release image with exactly this file name, if a loaded release has one. Sample entries never match. */
export function catalogMatch(name: string, images: Iterable<CatalogImage>): CatalogImage | null {
  for (const img of images) if (!img.sample && img.file === name) return img;
  return null;
}

export async function sha256OfFile(path: string, onBytes: (done: number) => void, signal?: AbortSignal): Promise<string> {
  const h = createHash('sha256');
  let done = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20, signal })) {
    h.update(chunk as Buffer);
    done += (chunk as Buffer).length;
    onBytes(done);
  }
  return h.digest('hex');
}

/** Size and SHA-256 of the decompressed image: what the drive must read back as. */
export async function measureImage(src: ImageSource, onBytes: (done: number) => void, signal?: AbortSignal):
  Promise<{ size: number; sha256: string }> {
  const h = createHash('sha256');
  let size = 0;
  const sink = new Writable({
    highWaterMark: 4 << 20,
    write(chunk: Buffer, _enc, cb) {
      h.update(chunk);
      size += chunk.length;
      onBytes(size);
      cb();
    },
  });
  await pipeline(src.stream, sink, { signal });
  return { size, sha256: h.digest('hex') };
}

export async function measureFile(path: string, onBytes: (done: number) => void, signal?: AbortSignal):
  Promise<{ size: number; sha256: string }> {
  const src = await openImage(path);
  try {
    const m = await measureImage(src, onBytes, signal);
    if (m.size === 0) throw new Error('The image is empty.');
    return m;
  } finally {
    await src.close();
  }
}

export interface LocalDescription {
  name: string;
  /** Size of the file itself. */
  size: number;
  /** Size once decompressed; 0 when only reading it all tells (gzip, bzip2). */
  extractSize: number;
  compression: Compression;
  /** The release image this file is, checked by SHA-256; null for a custom image. */
  image: CatalogImage | null;
}

export interface DescribeOptions {
  /** Progress of the SHA-256 check against the release. */
  onCheck?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /** A stand-in for tests. */
  xzSize?: (path: string) => Promise<number>;
}

/** Look at a chosen file. Throws, with words for the user, when it cannot be used. */
export async function describeLocal(path: string, images: Iterable<CatalogImage>, o: DescribeOptions = {}): Promise<LocalDescription> {
  const name = basename(path);
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch {
    throw new Error(`${name} is not a file that can be read.`);
  }
  if (size === 0) throw new Error(`${name} is empty.`);
  const fh = await open(path, 'r');
  const head = Buffer.alloc(4);
  try { await fh.read(head, 0, 4, 0); } finally { await fh.close(); }
  if (head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new Error(`${name} is a zip archive. Extract the image from it first.`);
  }
  const compression = await detectCompression(path);
  const image = catalogMatch(name, images);
  if (image) {
    const got = size === image.size ? await sha256OfFile(path, (n) => o.onCheck?.(n, size), o.signal) : null;
    if (got !== image.sha256) {
      throw new Error(`${name} has the name of a Roxora release image but is not that file: `
        + (got ? `its SHA-256 is ${got}, the release has ${image.sha256}` : `it holds ${size} bytes, the release file ${image.size}`)
        + '. The download may be damaged; download it again.');
    }
    return { name, size, extractSize: image.extractSize, compression, image };
  }
  let extractSize = 0;
  if (compression === null) extractSize = size;
  else if (compression === 'xz') extractSize = await (o.xzSize ?? xzExtractSize)(path).catch(() => 0);
  return { name, size, extractSize, compression, image: null };
}
