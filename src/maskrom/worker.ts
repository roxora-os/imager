/// <reference lib="webworker" />
// Dedicated worker that runs rkdeveloptool (WASM) for one Maskrom write.
//
// As in edk2-webflash the WASM runs in a worker; libusb's WebUSB backend
// uses navigator.usb there, which Electron exposes to workers of the app's
// origin. The image is read with synchronous Range requests to
// app://local/file/<token> (see main/protocol.ts), a few MiB at a time.

import { createRunner } from './runner';
import { flash, flashRegions, TRUSTED_READ_BYTES, type FlashPlan, type FlashResult, type RegionResult, type Stage } from './sequence';
import { planUpdateRegions, readUpdateImage } from './rkfw';
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
      verify: boolean; resetAfter: boolean; reconnectTimeout?: number;
      /** A whole image: also zero the old backup GPT at the end of the storage (sequence.ts). */
      clearBackupGpt?: boolean;
      /**
       * A Rockchip update.img (fileUrl): its partition table, loader and
       * partitions where its parameter.txt puts them (rkfw.ts), instead of
       * one image from sector 0.
       */
      updateImage?: boolean;
      /**
       * The storage is the SPI NOR flash: refuse a storage of another size,
       * and with keep, copy the flash to the page first ("backup" event),
       * which answers with "backup-saved" (sequence.ts FlashPlan.spiNor).
       */
      spiNor?: { keep: boolean } }
  | { type: 'backup-saved'; result: { path: string } | { error: string } };

export type WorkerEvent =
  | { type: 'log'; line: string }
  | { type: 'stage'; stage: Stage; detail?: string }
  | { type: 'progress'; stage: Stage; percent: number }
  /** The SPI NOR flash as it was, for the page to save; answered with "backup-saved". */
  | { type: 'backup'; data: Uint8Array }
  | { type: 'result'; result: FlashResult | RegionResult };

const post = (m: WorkerEvent, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

/** The page's answer to the last "backup" event. */
let backupSaved: ((r: { path: string } | { error: string }) => void) | null = null;

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
  if (m.type === 'backup-saved') { backupSaved?.(m.result); backupSaved = null; return; }
  if (m.type !== 'start') return;
  try {
    const imported = await import(/* @vite-ignore */ m.moduleUrl);
    const factory = imported.default ?? imported.createRKDevelopToolModule;
    const runner = await createRunner(factory, {
      log: (line) => post({ type: 'log', line }),
      locateFile: (p) => (p.endsWith('.wasm') ? m.wasmUrl : p),
    });
    const loader = new Uint8Array(await (await fetch(m.loaderUrl)).arrayBuffer());
    let lastPct = -1;
    const hooks = {
      stage: (stage: Stage, detail?: string) => post({ type: 'stage', stage, ...(detail ? { detail } : {}) }),
      progress: (stage: Stage, percent: number) => {
        if (percent !== lastPct) { lastPct = percent; post({ type: 'progress', stage, percent }); }
      },
      log: (line: string) => post({ type: 'log', line }),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      cancelled: () => false, // cancelling terminates the worker
    };
    if (m.updateImage) {
      const file = xhrSource(m.fileUrl!, m.size);
      const pkg = readUpdateImage(file);
      const result = await flashRegions(runner, {
        loader, storageCode: m.storageCode, storageLabel: m.storageLabel, checkHeadBytes: TRUSTED_READ_BYTES, resetAfter: m.resetAfter,
        ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
        plan: (capacity) => {
          const r = planUpdateRegions(file, pkg, capacity);
          if ('stop' in r) return r;
          // As RKDevTool's "Upgrade Firmware": the partition table from parameter.txt, then the loader, then the partitions.
          return { regions: r.regions, before: [
            { what: 'Writing the partition table', files: [{ name: 'parameter.txt', data: r.parameter }], args: ([f]) => ['gpt', f] },
            { what: 'Writing the boot loader', files: [{ name: 'MiniLoaderAll.bin', data: r.loader }], args: ([f]) => ['ul', f] },
          ] };
        },
      }, hooks);
      post({ type: 'result', result });
      return;
    }
    const source = m.file ? await pickedFileSource(m.file, m.xzWasmUrl!) : xhrSource(m.fileUrl!, m.size);
    const plan: FlashPlan = {
      loader, storageCode: m.storageCode, storageLabel: m.storageLabel,
      source, expectedSha256: m.sha256,
      verify: m.verify, resetAfter: m.resetAfter, clearBackupGpt: m.clearBackupGpt === true,
      ...(m.reconnectTimeout ? { reconnectTimeout: m.reconnectTimeout } : {}),
      ...(m.spiNor ? { spiNor: m.spiNor.keep ? {
        keep: (copy: Uint8Array) => new Promise<{ path: string } | { error: string }>((resolve) => {
          backupSaved = resolve;
          post({ type: 'backup', data: copy }, [copy.buffer as ArrayBuffer]);
        }),
      } : {} } : {}),
    };
    const result = await flash(runner, plan, hooks);
    post({ type: 'result', result });
  } catch (e) {
    post({ type: 'result', result: { ok: false, reason: 'The Maskrom writer could not start.', detail: String((e as Error)?.message ?? e) } });
  }
});
