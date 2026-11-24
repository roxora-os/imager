// A Rockchip update.img on this computer: read through a small file source
// (rkfw.ts reads only headers and parameter.txt), and its MD5 checked
// against the one the packer appended. No Electron here.

import { createHash } from 'node:crypto';
import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'node:fs';
import { readUpdateImage, type UpdateImage } from '../maskrom/rkfw';

export function inspectUpdateImage(path: string): UpdateImage {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    return readUpdateImage({
      size,
      read(position, length) {
        const b = Buffer.alloc(length);
        const n = readSync(fd, b, 0, length, position);
        return new Uint8Array(b.buffer, b.byteOffset, n);
      },
    });
  } finally {
    closeSync(fd);
  }
}

/** The MD5 the packer appended after the data: null when it matches (or there is none), else a sentence. */
export async function checkUpdateMd5(path: string, img: UpdateImage, onBytes?: (done: number, total: number) => void, signal?: AbortSignal): Promise<string | null> {
  if (!img.md5) return null;
  const h = createHash('md5');
  let done = 0;
  const total = img.dataEnd;
  for await (const c of createReadStream(path, { start: 0, end: total - 1, highWaterMark: 4 << 20, signal })) {
    h.update(c as Buffer);
    done += (c as Buffer).length;
    onBytes?.(done, total);
  }
  const sum = h.digest('hex');
  return sum === img.md5 ? null : `The update.img does not match the MD5 inside it (${sum}, expected ${img.md5}). The file is damaged or incomplete.`;
}
