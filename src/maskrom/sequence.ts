// The Maskrom flash sequence.
//
// The steps follow edk2-webflash (db, wl 0, rd) with what RKDevelopTool-GUI
// adds around them: pick the storage explicitly and confirm it switched,
// check the image fits, and read everything back to compare it with the
// release checksum, telling a real mismatch apart from the 0xCC filler some
// RK3576 loaders return for reads past a point.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { progressOf, type ByteSink, type ByteSource } from './rkcore';

export interface Runner {
  run(args: string[]): Promise<{ code: number; lines: string[] }>;
  mountSource(src: ByteSource): string;
  mountSink(sink: ByteSink): string;
  writeFile(name: string, data: Uint8Array): string;
}

export type Stage = 'detect' | 'loader' | 'reconnect' | 'storage' | 'write' | 'verify' | 'reset';

export interface Hooks {
  stage(stage: Stage, detail?: string): void;
  progress(stage: Stage, percent: number): void;
  log(line: string): void;
  /** Wait this long; the worker passes setTimeout, tests pass something faster. */
  sleep(ms: number): Promise<void>;
  cancelled(): boolean;
}

export interface FlashPlan {
  loader: Uint8Array;
  storageCode: number;
  storageLabel: string;
  source: ByteSource;
  /** SHA-256 of the bytes being written (the release's extract_sha256), or null to use what was sent. */
  expectedSha256: string | null;
  verify: boolean;
  resetAfter: boolean;
  /** How long to wait for the board to come back after the loader, in ms. */
  reconnectTimeout?: number;
}

export type FlashResult =
  | { ok: true; verified: 'match'; sha256: string; capacity: number | null }
  | { ok: true; verified: 'skipped'; sha256: string; capacity: number | null }
  | { ok: false; reason: string; detail?: string };

export class FlashError extends Error {}

export const SECTOR = 512;
const FILLER = 0xcc;

export type DeviceMode = 'maskrom' | 'loader' | 'none' | 'several';

/** Parse "ld" output: "DevNo=1	Vid=0x2207,Pid=0x350e,LocationID=101	Maskrom". */
export function parseList(lines: string[]): DeviceMode {
  const devs = lines.filter((l) => /DevNo=\d+/.test(l));
  if (devs.length === 0) return 'none';
  if (devs.length > 1) return 'several';
  if (/Maskrom/i.test(devs[0])) return 'maskrom';
  if (/Loader/i.test(devs[0])) return 'loader';
  return 'none';
}

/** Parse "rfi" output for the storage size in bytes. */
export function parseFlashSize(lines: string[]): number | null {
  for (const l of lines) {
    const m = /Flash Size:\s*(\d+)\s*Sectors/i.exec(l);
    if (m) return Number(m[1]) * SECTOR;
  }
  return null;
}

/** Hashes what is written and compares it with what the source holds. */
class ReadBack implements ByteSink {
  private h = sha256.create();
  private pos = 0;
  firstDiff: number | null = null;
  fillerAt: number | null = null;

  constructor(private source: ByteSource, private onProgress: (done: number) => void) {}

  write(chunk: Uint8Array): void {
    // The read-back is rounded up to whole sectors; only the image's bytes count.
    const want = Math.max(0, Math.min(chunk.length, this.source.size - this.pos));
    if (want > 0) {
      const part = chunk.subarray(0, want);
      this.h.update(part);
      if (this.firstDiff === null) {
        const orig = this.source.read(this.pos, want);
        for (let i = 0; i < want; i++) {
          if (part[i] !== orig[i]) {
            this.firstDiff = this.pos + i;
            // Is the sector it falls in all filler where the image is not?
            const s = i - (i % SECTOR);
            const sec = part.subarray(s, s + SECTOR);
            const osec = orig.subarray(s, s + SECTOR);
            if (sec.length === SECTOR && sec.every((b) => b === FILLER) && !osec.every((b) => b === FILLER)) {
              this.fillerAt = this.pos + s;
            }
            break;
          }
        }
      }
    }
    this.pos += chunk.length;
    this.onProgress(Math.min(this.pos, this.source.size));
  }

  digest(): string {
    return bytesToHex(this.h.digest());
  }
}

/** Hashes the source as rkdeveloptool reads it. */
function hashingSource(src: ByteSource, onRead: (end: number) => void): { source: ByteSource; digest: () => string | null } {
  const h = sha256.create();
  let next = 0;
  let inOrder = true;
  return {
    source: {
      size: src.size,
      read(position, length) {
        const b = src.read(position, length);
        // rkdeveloptool reads the header twice (sparse and UBI checks), then
        // the whole file in order. Hash each byte once, in order.
        if (position <= next && position + b.length > next) {
          h.update(b.subarray(next - position));
          next = position + b.length;
        } else if (position > next) {
          inOrder = false; // a skip we did not expect; do not trust the hash
        }
        onRead(position + length);
        return b;
      },
    },
    digest: () => (inOrder && next === src.size ? bytesToHex(h.digest()) : null),
  };
}

export async function flash(r: Runner, plan: FlashPlan, hooks: Hooks): Promise<FlashResult> {
  const step = async (stage: Stage, args: string[], what: string) => {
    if (hooks.cancelled()) throw new FlashError('Cancelled.');
    hooks.log(`$ rkdeveloptool ${args.join(' ')}`);
    const res = await r.run(args);
    if (res.code !== 0) throw new FlashError(`${what} failed (rkdeveloptool exit ${res.code}).`);
    return res.lines;
  };
  try {
    hooks.stage('detect');
    const mode = parseList((await r.run(['ld'])).lines);
    if (mode === 'none') return { ok: false, reason: 'No board in Maskrom mode was found.' };
    if (mode === 'several') return { ok: false, reason: 'More than one Rockchip device is connected. Leave only the board you want to write.' };

    if (mode === 'maskrom') {
      hooks.stage('loader');
      const loader = r.writeFile('loader.bin', plan.loader);
      await step('loader', ['db', loader], 'Sending the loader');
      // The board resets and comes back as a Loader device. The main process
      // grants access to Rockchip devices, so it shows up again without a
      // second device pick.
      hooks.stage('reconnect');
      const deadline = (plan.reconnectTimeout ?? 20000);
      let waited = 0;
      let back = false;
      await hooks.sleep(1000);
      while (waited < deadline) {
        if (hooks.cancelled()) throw new FlashError('Cancelled.');
        const m = parseList((await r.run(['ld'])).lines);
        if (m === 'loader') { back = true; break; }
        await hooks.sleep(500);
        waited += 500;
      }
      if (!back) {
        return { ok: false, reason: 'The board did not come back after the loader was sent.',
          detail: 'Unplug the USB cable, put the board in Maskrom mode again and retry.' };
      }
    }

    hooks.stage('storage', plan.storageLabel);
    const cs = await r.run(['cs', String(plan.storageCode)]);
    if (cs.code !== 0) {
      return { ok: false, reason: `The board did not switch to ${plan.storageLabel}. Nothing was written.`,
        detail: cs.lines.join('\n') };
    }
    const rfi = await r.run(['rfi']);
    const capacity = rfi.code === 0 ? parseFlashSize(rfi.lines) : null;
    if (capacity !== null && plan.source.size > capacity) {
      return { ok: false, reason: `The image (${plan.source.size} bytes) does not fit in ${plan.storageLabel} (${capacity} bytes). Nothing was written.` };
    }

    hooks.stage('write');
    hooks.progress('write', 0);
    const src = hashingSource(plan.source, (end) => hooks.progress('write', Math.floor(end * 100 / plan.source.size)));
    const srcPath = r.mountSource(src.source);
    await step('write', ['wl', '0', srcPath], 'Writing');
    const sent = src.digest();
    if (plan.expectedSha256 && sent && sent !== plan.expectedSha256) {
      return { ok: false, reason: 'The image file changed or is damaged: what was written does not match the release checksum.',
        detail: `sent ${sent}, release ${plan.expectedSha256}` };
    }
    const expected = plan.expectedSha256 ?? sent;

    let result: FlashResult;
    if (plan.verify && expected) {
      hooks.stage('verify');
      hooks.progress('verify', 0);
      const rb = new ReadBack(plan.source, (done) => hooks.progress('verify', Math.floor(done * 100 / plan.source.size)));
      const sinkPath = r.mountSink(rb);
      const sectors = Math.ceil(plan.source.size / SECTOR);
      await step('verify', ['rl', '0', `0x${sectors.toString(16)}`, sinkPath], 'Reading back');
      const got = rb.digest();
      if (got !== expected) {
        if (rb.fillerAt !== null) {
          return { ok: false, reason: `Could not verify: from ${rb.fillerAt} bytes on, the loader returns filler instead of data. The write itself may be fine.`,
            detail: `read back ${got}, expected ${expected}` };
        }
        return { ok: false, reason: `Read-back does not match: first difference at byte ${rb.firstDiff}.`,
          detail: `read back ${got}, expected ${expected}` };
      }
      result = { ok: true, verified: 'match', sha256: got, capacity };
    } else {
      result = { ok: true, verified: 'skipped', sha256: expected ?? '', capacity };
    }

    if (plan.resetAfter) {
      hooks.stage('reset');
      await r.run(['rd']);
    }
    return result;
  } catch (e) {
    if (e instanceof FlashError) return { ok: false, reason: e.message };
    return { ok: false, reason: 'rkdeveloptool stopped with an error.', detail: String((e as Error)?.message ?? e) };
  }
}

export { progressOf };
