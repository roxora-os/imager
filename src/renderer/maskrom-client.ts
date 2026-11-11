// Runs one Maskrom write in a worker and reports back.
import type { WorkerEvent, WorkerRequest } from '../maskrom/worker';
import type { FlashResult, Stage } from '../maskrom/sequence';

export interface MaskromJob {
  done: Promise<FlashResult>;
  cancel(): void;
}

export function startMaskrom(req: Omit<WorkerRequest, 'type' | 'moduleUrl' | 'wasmUrl' | 'loaderUrl' | 'xzWasmUrl'> & { loader: string },
  on: { log(line: string): void; stage(s: Stage, detail?: string): void; progress(s: Stage, pct: number): void }): MaskromJob {
  const w = new Worker('maskrom-worker.js', { type: 'module' });
  let resolve!: (r: FlashResult) => void;
  const done = new Promise<FlashResult>((r) => { resolve = r; });
  w.onmessage = (e: MessageEvent<WorkerEvent>) => {
    const m = e.data;
    if (m.type === 'log') on.log(m.line);
    else if (m.type === 'stage') on.stage(m.stage, m.detail);
    else if (m.type === 'progress') on.progress(m.stage, m.percent);
    else if (m.type === 'result') { resolve(m.result); w.terminate(); }
  };
  w.onerror = (e) => { resolve({ ok: false, reason: 'The Maskrom writer stopped.', detail: e.message }); w.terminate(); };
  // Relative to the page: app://local/ in Electron, .../imager/ on the web.
  const at = (p: string) => new URL(p, document.baseURI).href;
  const { loader, ...rest } = req;
  w.postMessage({
    type: 'start', ...rest,
    moduleUrl: at('wasm/rkdeveloptool.js'), wasmUrl: at('wasm/rkdeveloptool.wasm'),
    loaderUrl: at(`resources/${loader}`), xzWasmUrl: at('resources/xzwasm/xzwasm.wasm'),
  } satisfies WorkerRequest);
  return {
    done,
    cancel() {
      w.terminate();
      resolve({ ok: false, reason: 'Cancelled. The storage may be only partly written.' });
    },
  };
}
