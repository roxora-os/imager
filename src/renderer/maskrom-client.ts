// Runs one Maskrom write in a worker and reports back.
import type { WorkerEvent, WorkerRequest } from '../maskrom/worker';
import type { FlashResult, Stage } from '../maskrom/sequence';

export interface MaskromJob {
  done: Promise<FlashResult>;
  cancel(): void;
}

export function startMaskrom(req: Omit<WorkerRequest, 'type' | 'moduleUrl' | 'wasmUrl' | 'loaderUrl'> & { loader: string },
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
  const base = location.origin;
  const { loader, ...rest } = req;
  w.postMessage({
    type: 'start', ...rest,
    moduleUrl: `${base}/wasm/rkdeveloptool.js`, wasmUrl: `${base}/wasm/rkdeveloptool.wasm`,
    loaderUrl: `${base}/resources/${loader}`,
  } satisfies WorkerRequest);
  return {
    done,
    cancel() {
      w.terminate();
      resolve({ ok: false, reason: 'Cancelled. The storage may be only partly written.' });
    },
  };
}
