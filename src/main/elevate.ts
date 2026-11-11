// Start the write helper with administrator rights and follow its progress.
//
// The helper is this app's own executable in Node mode
// (ELECTRON_RUN_AS_NODE), started through @balena/sudo-prompt the way Etcher
// does it: pkexec on Linux, the password dialog on macOS, UAC on Windows. It
// reports over a local socket, because the elevated process's stdout only
// arrives when it exits.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HelperMessage } from '../helper/write-helper';

export interface HelperLaunch {
  /** Executable to run. */
  exec: string;
  /** Bootstrap script passed as the first argument. */
  bootstrap: string;
  env: Record<string, string>;
}

/**
 * How to start the helper. Inside an AppImage the executable lives on a FUSE
 * mount root cannot read, so the AppImage is run again with
 * APPIMAGE_EXTRACT_AND_RUN and the bootstrap finds the helper next to the
 * extracted executable. Everywhere else the helper's path is known.
 */
export function helperLaunch(o: {
  execPath: string; helperPath: string; appImage?: string; dir: string; resourcesRelative: string;
}): HelperLaunch {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', ROXORA_IMAGER_HELPER: '1' };
  let code: string;
  let exec = o.execPath;
  if (o.appImage) {
    exec = o.appImage;
    env.APPIMAGE_EXTRACT_AND_RUN = '1';
    code = `const p = require('path');\nrequire(p.join(p.dirname(process.execPath), ${JSON.stringify(o.resourcesRelative)}));\n`;
  } else {
    code = `require(${JSON.stringify(o.helperPath)});\n`;
  }
  const bootstrap = join(o.dir, 'bootstrap.js');
  writeFileSync(bootstrap, code, { mode: 0o644 });
  return { exec, bootstrap, env };
}

/** Quote one argument for the shell sudo-prompt runs (sh, or cmd on Windows). */
export function quote(arg: string, platform = process.platform): string {
  if (platform === 'win32') {
    if (/["%]/.test(arg)) throw new Error(`cannot pass ${arg} safely`);
    return `"${arg}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(l: HelperLaunch, args: string[], platform = process.platform): string {
  return [l.exec, l.bootstrap, ...args].map((a) => quote(a, platform)).join(' ');
}

export interface RunHelperOptions {
  launch: (dir: string) => HelperLaunch;
  args: (socket: string, token: string) => string[];
  onMessage: (m: HelperMessage) => void;
  /** Runs the command with administrator rights. Tests pass something else. */
  elevate: (cmd: string, env: Record<string, string>) => Promise<void>;
  signal?: AbortSignal;
}

export type HelperOutcome = Extract<HelperMessage, { type: 'done' }>;

export async function runHelper(o: RunHelperOptions): Promise<HelperOutcome> {
  const dir = mkdtempSync(join(tmpdir(), 'roxora-imager-'));
  const token = randomBytes(16).toString('hex');
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\roxora-imager-${randomBytes(8).toString('hex')}`
    : join(dir, 'helper.sock');
  let outcome: HelperOutcome | null = null;
  let peer: Socket | null = null;
  let peerClosed: () => void = () => {};
  const closed = new Promise<void>((r) => { peerClosed = r; });
  const server = createServer((s) => {
    if (peer) { s.destroy(); return; } // one helper only
    s.on('close', () => { if (s === peer) peerClosed(); });
    let buf = '';
    let trusted = false;
    s.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: HelperMessage;
        try { m = JSON.parse(line); } catch { continue; }
        if (!trusted) {
          if (m.type === 'hello' && m.token === token) { trusted = true; peer = s; continue; }
          s.destroy();
          return;
        }
        if (m.type === 'done') outcome = m;
        o.onMessage(m);
      }
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  const onAbort = () => { peer?.write('{"type":"cancel"}\n'); };
  o.signal?.addEventListener('abort', onAbort);
  try {
    const launch = o.launch(dir);
    const cmd = commandLine(launch, o.args(socketPath, token));
    try {
      await o.elevate(cmd, launch.env);
    } catch (e) {
      if (!outcome && peer) await Promise.race([closed, new Promise((r) => setTimeout(r, 2000))]);
      if (outcome) return outcome;
      const msg = String((e as Error)?.message ?? e);
      if (o.signal?.aborted) return { type: 'done', ok: false, reason: 'Cancelled. The drive is only partly written.' };
      if (/did not grant permission|cancel|dismissed|Request dismissed|Error executing command as another user/i.test(msg)) {
        return { type: 'done', ok: false, reason: 'Administrator rights were not granted. Nothing was written.' };
      }
      return { type: 'done', ok: false, reason: 'The writer could not be started.', detail: msg };
    }
    // The process can be gone before its last message is read.
    if (!outcome && peer) await Promise.race([closed, new Promise((r) => setTimeout(r, 2000))]);
    return outcome ?? { type: 'done', ok: false, reason: 'The writer stopped without saying why.' };
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** sudo-prompt, wrapped in a promise. */
export async function sudoPromptElevate(cmd: string, env: Record<string, string>): Promise<void> {
  const sudo = (await import('@balena/sudo-prompt')).default ?? (await import('@balena/sudo-prompt'));
  await new Promise<void>((resolve, reject) => {
    (sudo as { exec: Function }).exec(cmd, { name: 'Roxora Imager', env }, (err: Error | undefined) => {
      if (err) reject(err); else resolve();
    });
  });
}
