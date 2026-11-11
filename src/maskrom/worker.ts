/// <reference lib="webworker" />
// Dedicated worker that runs rkdeveloptool (WASM) for one Maskrom write.
//
// As in edk2-webflash the WASM runs in a worker; libusb's WebUSB backend
// uses navigator.usb there, which Electron exposes to workers of the app's
// origin. The image is read with synchronous Range requests to
// app://local/file/<token> (see main/protocol.ts), a few MiB at a time.

import { createRunner } from './runner';
import { flash, type FlashPlan, type Stage } from './sequence';
import type { ByteSource } from './rkcore';
import { rawSource, xzSource } from './file-source';
import { detectFormat, hasSpecialMagic } from '../web/webflash/image-source.js';
import { XzDecoder, xzUncompressedSize } from '../web/webflash/xz.js';

/** A source over a picked File: raw as it is, .xz decompressed as it is read. */
async function pickedFileSource(file: File, xzWasmUrl: string): Promise<ByteSource> {
  const FRS = (self as unknown as { FileReaderSync: new () => { readAsArrayBuffer(b: Blob): ArrayBuffer } }).FileReaderSync;
  const reader = new FRS();
  const read = (p: number, n: number) => new Uint8Array(reader.readAsArrayBuffer(file.slice(p, p + n)));
  const fmt = detectFormat(read(0, Math.min(16, file.size)), file.name);
  let src: ByteSource;
  if (fmt.format === 'raw') {
    src = rawSource(file.size, read);
  } else if (fmt.format === 'xz') {
    const size = await xzUncompressedSize(async (a: number, b: number) => read(a, b - a), file.size);
    if (!size) throw new Error(`${file.name} does not look like a complete .xz file.`);
    const mod = await WebAssembly.compile(await (await fetch(xzWasmUrl)).arrayBuffer());
    src = xzSource(file.size, size, read, () => new XzDecoder(new WebAssembly.Instance(mod, {})));
  } else if (fmt.format === 'gzip') {
    throw new Error(`${file.name} is gzip-compressed. Use the .img.xz from the release, or an uncompressed .img.`);
  } else {
    throw new Error(fmt.message);
  }
  // rkdeveloptool's wl writes a file starting with these as sparse or UBI.
  if (hasSpecialMagic(src.read(0, Math.min(4, src.size)))) {
    throw new Error(`${file.name} starts like an Android sparse or UBI image, which this writer does not handle.`);
  }
  return src;
}

export type WorkerRequest =
  | { type: 'start'; moduleUrl: string; wasmUrl: string; loaderUrl: string;
      /** Electron: the prepared file, served by the main process. */
      fileUrl?: string;
      /** Web: the file the user picked (.img or .img.xz), read here. */
      file?: File; xzWasmUrl?: string;
      size: number; sha256: string | null; storageCode: number; storageLabel: string;
      verify: boolean; resetAfter: boolean; reconnectTimeout?: number };

export type WorkerEvent =
  | { type: 'log'; line: string }
  | { type: 'stage'; stage: Stage; detail?: string }
  | { type: 'progress'; stage: Stage; percent: number }
  | { type: 'result'; result: Awaited<ReturnType<typeof flash>> };

const post = (m: WorkerEvent) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

const CHUNK = 4 << 20;

/** Read `url` by Range requests, keeping the last chunk. */
export function xhrSource(url: string, size: number): ByteSource {
  let cacheStart = -1;
  let cache = new Uint8Array(0);
  const load = (start: number) => {
    const end = Math.min(size, start + CHUNK) - 1;
    const x = new XMLHttpRequest();
    x.open('GET', url, false);
    x.responseType = 'arraybuffer';
    x.setRequestHeader('Range', `bytes=${start}-${end}`);
    x.send();
    if (x.status !== 206 && x.status !== 200) throw new Error(`reading the image failed: HTTP ${x.status}`);
    cache = new Uint8Array(x.response as ArrayBuffer);
    if (cache.length !== end - start + 1) throw new Error('reading the image returned a short block');
    cacheStart = start;
  };
  return {
    size,
    read(position, length) {
      const out = new Uint8Array(length);
      let done = 0;
      while (done < length) {
        const pos = position + done;
        if (cacheStart < 0 || pos < cacheStart || pos >= cacheStart + cache.length) {
          load(pos - (pos % CHUNK));
        }
        const off = pos - cacheStart;
        const n = Math.min(length - done, cache.length - off);
        out.set(cache.subarray(off, off + n), done);
        done += n;
      }
      return out;
    },
  };
}

self.addEventListener('message', async (ev: MessageEvent<WorkerRequest>) => {
  const m = ev.data;
  if (m.type !== 'start') return;
  try {
    const imported = await import(/* @vite-ignore */ m.moduleUrl);
    const factory = imported.default ?? imported.createRKDevelopToolModule;
    const runner = await createRunner(factory, {
      log: (line) => post({ type: 'log', line }),
      locateFile: (p) => (p.endsWith('.wasm') ? m.wasmUrl : p),
    });
    const loader = new Uint8Array(await (await fetch(m.loaderUrl)).arrayBuffer());
    const source = m.file ? await pickedFileSource(m.file, m.xzWasmUrl!) : xhrSource(m.fileUrl!, m.size);
    const plan: FlashPlan = {
      loader, storageCode: m.storageCode, storageLabel: m.storageLabel,
      source, expectedSha256: m.sha256,
      verify: m.verify, resetAfter: m.resetAfter,
      ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
    };
    let lastPct = -1;
    const result = await flash(runner, plan, {
      stage: (stage, detail) => post({ type: 'stage', stage, ...(detail ? { detail } : {}) }),
      progress: (stage, percent) => {
        if (percent !== lastPct) { lastPct = percent; post({ type: 'progress', stage, percent }); }
      },
      log: (line) => post({ type: 'log', line }),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      cancelled: () => false, // cancelling terminates the worker
    });
    post({ type: 'result', result });
  } catch (e) {
    post({ type: 'result', result: { ok: false, reason: 'The Maskrom writer could not start.', detail: String((e as Error)?.message ?? e) } });
  }
});
