// A Runner (see sequence.ts) over the WASM rkdeveloptool, collecting each
// command's output so the sequence can read it.

import { RkTool, stripAnsi, type RkFactory } from './rkcore';
import type { Runner } from './sequence';

export async function createRunner(factory: RkFactory, opts: {
  log: (line: string, stream: 'out' | 'err') => void;
  locateFile?: (path: string) => string;
  wasmBinary?: Uint8Array;
}): Promise<Runner> {
  let lines: string[] = [];
  const tool = await RkTool.create(factory, {
    ...(opts.locateFile ? { locateFile: opts.locateFile } : {}),
    ...(opts.wasmBinary ? { wasmBinary: opts.wasmBinary } : {}),
    print: (t) => {
      const s = stripAnsi(t).trimEnd();
      if (!s.trim()) return;
      lines.push(s);
      opts.log(s, 'out');
    },
    printErr: (t) => {
      const s = stripAnsi(t).trimEnd();
      if (s.trim()) opts.log(s, 'err');
    },
  });
  return {
    async run(args) {
      lines = [];
      const code = await tool.run(args);
      return { code, lines };
    },
    mountSource: (s) => tool.mountSource(s),
    mountSink: (s) => tool.mountSink(s),
    writeFile: (n, d) => tool.writeFile(n, d),
  };
}
