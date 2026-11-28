// Runs one Maskrom write in a worker and reports back.
import type { WorkerEvent, WorkerRequest } from '../maskrom/worker';
import type { FlashResult, RegionResult, Stage } from '../maskrom/sequence';

export interface MaskromJob {
  done: Promise<FlashResult | RegionResult>;
  cancel(): void;
}

export function startMaskrom(req: Omit<Extract<WorkerRequest, { type: 'start' }>, 'type' | 'moduleUrl' | 'wasmUrl' | 'xzWasmUrl'>,
  on: {
    log(line: string): void; stage(s: Stage, detail?: string): void; progress(s: Stage, pct: number): void;
    /** Save the SPI NOR flash as it was before the write (req.spiNor.keep); the path, or why not. */
    backup?(data: Uint8Array): Promise<{ path: string } | { error: string }>;
  }): MaskromJob {
  const w = new Worker('maskrom-worker.js', { type: 'module' });
  let resolve!: (r: FlashResult | RegionResult) => void;
  const done = new Promise<FlashResult | RegionResult>((r) => { resolve = r; });
  w.onmessage = (e: MessageEvent<WorkerEvent>) => {
    const m = e.data;
    if (m.type === 'log') on.log(m.line);
    else if (m.type === 'stage') on.stage(m.stage, m.detail);
    else if (m.type === 'progress') on.progress(m.stage, m.percent);
    else if (m.type === 'backup') {
      const answer = (result: { path: string } | { error: string }) => w.postMessage({ type: 'backup-saved', result } satisfies WorkerRequest);
      const saving: Promise<{ path: string } | { error: string }> = on.backup ? on.backup(m.data) : Promise.resolve({ error: 'This page cannot keep a copy.' });
      saving.then(answer, (e: unknown) => answer({ error: String((e as Error)?.message ?? e) }));
    }
    else if (m.type === 'result') { resolve(m.result); w.terminate(); }
  };
  w.onerror = (e) => { resolve({ ok: false, reason: 'The Maskrom writer stopped.', detail: e.message }); w.terminate(); };
  // Relative to the page: app://local/ in Electron, .../imager/ on the web.
  const at = (p: string) => new URL(p, document.baseURI).href;
  w.postMessage({
    type: 'start', ...req,
    moduleUrl: at('wasm/rkdeveloptool.js'), wasmUrl: at('wasm/rkdeveloptool.wasm'),
    xzWasmUrl: at('resources/xzwasm/xzwasm.wasm'),
  } satisfies WorkerRequest);
  return {
    done,
    cancel() {
      w.terminate();
      resolve({ ok: false, reason: 'Cancelled. The storage may be only partly written.' });
    },
  };
}
