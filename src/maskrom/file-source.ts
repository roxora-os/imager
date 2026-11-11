// Byte sources over a file the user picked, for the web build's Maskrom
// worker. rkdeveloptool reads through synchronous file system calls, so
// these read synchronously too (FileReaderSync in the worker; a plain
// function in the tests).
//
// A .img.xz is decompressed as rkdeveloptool reads it, with the xz decoder
// edk2-webflash uses (web/webflash/xz.js on xzwasm). rkdeveloptool reads the
// first sectors twice (its sparse and UBI checks), then the file in order,
// and the read-back reads it once more from the start; the first MiB is
// kept for the first case, and a read before the window restarts the decoder.

import type { ByteSource } from './rkcore';

export type SyncRead = (position: number, length: number) => Uint8Array;

export interface XzLike {
  push(input: Uint8Array): Uint8Array[];
  finish(): Uint8Array[];
  dispose?(): void;
}

export function rawSource(size: number, read: SyncRead): ByteSource {
  return { size, read };
}

const HEAD = 1 << 20;
const IN_CHUNK = 1 << 20;

export function xzSource(compressedSize: number, imageSize: number, read: SyncRead, newDecoder: () => XzLike): ByteSource {
  let dec: XzLike | null = null;
  let inPos = 0;
  let finished = false;
  let winStart = 0;
  let win = new Uint8Array(0);
  const head = new Uint8Array(Math.min(HEAD, imageSize));
  let headLen = 0;

  const restart = () => {
    dec?.dispose?.();
    dec = newDecoder();
    inPos = 0;
    finished = false;
    winStart = 0;
    win = new Uint8Array(0);
  };

  const append = (parts: Uint8Array[], keepFrom: number) => {
    let total = 0;
    for (const p of parts) total += p.length;
    if (total === 0) return;
    // Remember the head of the image.
    let at = winStart + win.length;
    for (const p of parts) {
      if (at < head.length) {
        const n = Math.min(head.length - at, p.length);
        if (at === headLen) { head.set(p.subarray(0, n), at); headLen += n; }
      }
      at += p.length;
    }
    const drop = Math.max(0, Math.min(keepFrom - winStart, win.length));
    const next = new Uint8Array(win.length - drop + total);
    next.set(win.subarray(drop));
    let o = win.length - drop;
    for (const p of parts) { next.set(p, o); o += p.length; }
    winStart += drop;
    win = next;
  };

  return {
    size: imageSize,
    read(position, length) {
      const end = position + length;
      if (end <= headLen) return head.slice(position, end);
      if (!dec || position < winStart) restart();
      while (winStart + win.length < end) {
        if (finished) throw new Error(`the .xz file holds less than its index says (wanted byte ${end})`);
        let parts: Uint8Array[];
        if (inPos < compressedSize) {
          const n = Math.min(IN_CHUNK, compressedSize - inPos);
          parts = dec!.push(read(inPos, n));
          inPos += n;
        } else {
          parts = dec!.finish();
          finished = true;
        }
        append(parts, position);
      }
      const off = position - winStart;
      return win.slice(off, off + length);
    },
  };
}
