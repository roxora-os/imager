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

export type WorkerRequest =
  | { type: 'start'; moduleUrl: string; wasmUrl: string; loaderUrl: string; fileUrl: string; size: number;
      sha256: string | null; storageCode: number; storageLabel: string; verify: boolean; resetAfter: boolean };

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
    const plan: FlashPlan = {
      loader, storageCode: m.storageCode, storageLabel: m.storageLabel,
      source: xhrSource(m.fileUrl, m.size), expectedSha256: m.sha256,
      verify: m.verify, resetAfter: m.resetAfter,
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
