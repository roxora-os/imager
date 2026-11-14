// Reading an image file whatever it is compressed with. No Electron here,
// so the CI write tests can load it too.

import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';

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

function sourceDestination(): typeof import('etcher-sdk/build/source-destination') {
  // Not the index: it loads etcher-sdk's USB boot scanners (see write-helper.ts).
  // require(), not import(): the bundle is CommonJS, esbuild leaves import()
  // of a module outside the bundle as it is, and Node.js then refuses the
  // folder name (ERR_UNSUPPORTED_DIR_IMPORT).
  return require('etcher-sdk/build/source-destination');
}

export interface ImageSource {
  stream: Readable;
  close: () => Promise<void>;
}

/** The decompressed image, through etcher-sdk's decompressors (.xz, .gz, .bz2, or as it is). */
export async function openImage(path: string): Promise<ImageSource> {
  const file = new (sourceDestination().File)({ path });
  const inner = await file.getInnerSource();
  const stream = await inner.createReadStream() as unknown as Readable;
  return { stream, close: () => inner.close().catch(() => {}) };
}

/**
 * The decompressed size of an .xz file from its index, without decompressing.
 * 0 when it cannot be told (gzip and bzip2 do not store it reliably).
 */
export async function xzExtractSize(path: string): Promise<number> {
  const file = new (sourceDestination().File)({ path });
  const inner = await file.getInnerSource();
  try {
    const m = await inner.getMetadata();
    return m.size && !m.isSizeEstimated && Number.isSafeInteger(m.size) ? m.size : 0;
  } finally {
    await inner.close().catch(() => {});
  }
}
