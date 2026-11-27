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
  /**
   * After the image, zero the last 33 sectors of the storage, where a GPT
   * keeps its backup copy: a whole-disk image smaller than the storage
   * leaves the old one there otherwise, and some tools then find a stale
   * partition table. Only when the storage size is known and the image ends
   * before them.
   */
  clearBackupGpt?: boolean;
}

/** GPT keeps a copy of itself in the last 33 sectors of the disk. */
export const BACKUP_GPT_SECTORS = 33;

/** Where the backup GPT starts on a storage of `capacity` bytes, or null when an image of `imageSize` reaches into it. */
export function backupGptLba(capacity: number | null, imageSize: number): number | null {
  if (capacity === null) return null;
  const lba = Math.floor(capacity / SECTOR) - BACKUP_GPT_SECTORS;
  return lba * SECTOR >= imageSize ? lba : null;
}

export type FlashResult =
  | { ok: true; verified: 'match'; sha256: string; capacity: number | null; clearedBackupGpt?: boolean }
  | { ok: true; verified: 'skipped'; sha256: string; capacity: number | null; clearedBackupGpt?: boolean }
  /**
   * Everything before verifiedBytes read back as written; from there on the
   * loader returned 0xCC filler (RK3576 loaders over USB), so the rest could
   * not be read back. On a ROCK 4D such a card booted normally.
   */
  | { ok: true; verified: 'partial'; verifiedBytes: number; sha256: string; capacity: number | null; clearedBackupGpt?: boolean }
  | { ok: false; reason: string; detail?: string };

export class FlashError extends Error {}

/** The start of the reason when the board left the USB bus during a write (the page shows how to get it back). */
export const BOARD_GONE = 'The board was disconnected.';

/**
 * After a failed command: is the board still there? `ld` once; when no
 * device answers (or ld itself fails), the cable was pulled or the board
 * reset. From Maskrom Studio's region writer.
 */
async function boardGone(r: Runner, e: FlashError, hooks: Hooks): Promise<boolean> {
  if (e.message === 'Cancelled.' || hooks.cancelled()) return false;
  try { return parseList((await r.run(['ld'])).lines) === 'none'; } catch { return true; }
}

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

class Stopped extends Error {
  constructor(public result: Extract<FlashResult, { ok: false }>) { super(result.reason); }
}

/**
 * Find the board and have its loader run: db unless it already runs, then
 * follow the board through its re-enumeration. Throws Stopped with the
 * result to give when it cannot.
 */
async function bringUp(r: Runner, plan: { loader: Uint8Array; reconnectTimeout?: number }, hooks: Hooks): Promise<void> {
  const stop = (reason: string, detail?: string): never => { throw new Stopped({ ok: false, reason, ...(detail ? { detail } : {}) }); };
  hooks.stage('detect');
  const mode = parseList((await r.run(['ld'])).lines);
  if (mode === 'none') stop('No board in Maskrom mode was found.');
  if (mode === 'several') stop('More than one Rockchip device is connected. Leave only the board you want to write.');

  // The loader (usbplug) answers rfi; plain Maskrom cannot. On the RK3576
  // ld says Maskrom either way, so a board whose loader still runs from an
  // earlier attempt looks like a fresh one; db then fails on it.
  const loaderRuns = async () => {
    const probe = await r.run(['rfi']);
    return probe.code === 0 && parseFlashSize(probe.lines) !== null;
  };
  if (mode === 'maskrom' && await loaderRuns()) {
    hooks.log('The loader is already running on the board; not sending it again.');
  } else if (mode === 'maskrom') {
    hooks.stage('loader');
    const loader = r.writeFile('loader.bin', plan.loader);
    if (hooks.cancelled()) throw new FlashError('Cancelled.');
    hooks.log(`$ rkdeveloptool db ${loader}`);
    const db = await r.run(['db', loader]);
    if (db.code !== 0) {
      // db also fails when a loader is already running (RKDevelopTool-GUI
      // checks the same way): go on if rfi answers.
      if (!(await loaderRuns())) {
        throw new FlashError(`Sending the loader failed (rkdeveloptool exit ${db.code}).`);
      }
    } else {
      // The board resets and comes back with the loader (usbplug) running.
      // The main process grants access to Rockchip devices, so it shows up
      // again without a second device pick. Some SoCs come back as a Loader
      // device; the RK3576 comes back still looking like Maskrom to `ld`
      // (same descriptor), so then the loader is known to run when `rfi`
      // gets an answer, which plain Maskrom cannot give (RKDevelopTool-GUI
      // waits for rfi the same way).
      hooks.stage('reconnect');
      const deadline = (plan.reconnectTimeout ?? 20000);
      let waited = 0;
      let back = false;
      await hooks.sleep(1000);
      while (waited < deadline) {
        if (hooks.cancelled()) throw new FlashError('Cancelled.');
        const m = parseList((await r.run(['ld'])).lines);
        if (m === 'loader') { back = true; break; }
        if (m === 'maskrom' && await loaderRuns()) { back = true; break; }
        await hooks.sleep(500);
        waited += 500;
      }
      if (!back) {
        stop(`${BOARD_GONE} It did not come back after the loader was sent.`,
          'Unplug the USB cable, put the board in Maskrom mode again and retry.');
      }
    }
  }
}

/** Switch to the storage (cs) and read its size (rfi). Throws Stopped when it does not switch. */
async function selectStorage(r: Runner, code: number, label: string, hooks: Hooks): Promise<number | null> {
  hooks.stage('storage', label);
  const cs = await r.run(['cs', String(code)]);
  if (cs.code !== 0) {
    throw new Stopped({ ok: false, reason: `The board did not switch to ${label}. Nothing was written.`, detail: cs.lines.join('\n') });
  }
  const rfi = await r.run(['rfi']);
  return rfi.code === 0 ? parseFlashSize(rfi.lines) : null;
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
    await bringUp(r, plan, hooks);
    const capacity = await selectStorage(r, plan.storageCode, plan.storageLabel, hooks);
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
      if (got === expected) {
        result = { ok: true, verified: 'match', sha256: got, capacity };
      } else if (rb.fillerAt !== null && rb.firstDiff !== null && rb.firstDiff >= rb.fillerAt) {
        // Every byte before the filler matched; past it nothing can be read.
        hooks.log(`Read-back matched up to ${rb.fillerAt} bytes; from there the loader returns filler (read back ${got}, expected ${expected}).`);
        result = { ok: true, verified: 'partial', verifiedBytes: rb.fillerAt, sha256: expected, capacity };
      } else {
        return { ok: false, reason: `Read-back does not match: first difference at byte ${rb.firstDiff}.`,
          detail: `read back ${got}, expected ${expected}` };
      }
    } else {
      result = { ok: true, verified: 'skipped', sha256: expected ?? '', capacity };
    }

    if (plan.clearBackupGpt) {
      const lba = backupGptLba(capacity, plan.source.size);
      if (lba === null) {
        hooks.log(capacity === null ? 'The storage size is unknown, so the old backup partition table was left as it is.'
          : 'The image reaches the last sectors of the storage; there is no old backup partition table to clear.');
      } else {
        // Not read back: on RK3576 this loader's reads past 32 MiB are not trustworthy.
        const zeros: ByteSource = { size: BACKUP_GPT_SECTORS * SECTOR, read: (_p, n) => new Uint8Array(n) };
        await step('write', ['wl', String(lba), r.mountSource(zeros)], 'Clearing the old backup partition table');
        result = { ...result, clearedBackupGpt: true };
      }
    }

    if (plan.resetAfter) {
      hooks.stage('reset');
      await r.run(['rd']);
    }
    return result;
  } catch (e) {
    if (e instanceof Stopped) return e.result;
    if (e instanceof FlashError) {
      if (await boardGone(r, e, hooks)) return { ok: false, reason: BOARD_GONE, detail: e.message };
      return { ok: false, reason: e.message };
    }
    return { ok: false, reason: 'rkdeveloptool stopped with an error.', detail: String((e as Error)?.message ?? e) };
  }
}

export { progressOf };

// ---- Several regions: a Rockchip update.img (rkfw.ts) ----

/** Reads this far from the start of the storage come back as written on RK3576; past it, maybe not. */
export const TRUSTED_READ_BYTES = 32 * 1024 * 1024;
const SAMPLE = 64 * 1024;

export interface RegionSpec { lba: number; source: ByteSource; label: string }

/** A command run after the storage is chosen and before the first wl, with the files it needs. */
export interface BeforeStep { what: string; files: Array<{ name: string; data: Uint8Array }>; args: (paths: string[]) => string[] }

export interface RegionPlan {
  loader: Uint8Array;
  storageCode: number;
  storageLabel: string;
  /** What to write once the storage size is known, or why not. */
  plan(capacity: number | null): { regions: RegionSpec[]; before?: BeforeStep[] } | { stop: string };
  /**
   * Read back everything written in the first this many bytes of the
   * storage and compare it whole; past it (the loader's reads are trusted
   * only so far), samples are compared and a mismatch is reported, not
   * taken as a failed write.
   */
  checkHeadBytes: number;
  resetAfter: boolean;
  reconnectTimeout?: number;
}

export interface RegionChecks {
  /** Bytes compared in full within checkHeadBytes, all equal. */
  headBytes: number;
  /** Samples past it that read back as written, as 0xCC filler, or as something else. */
  matched: number;
  filler: number;
  unsure: number;
}

export type RegionResult =
  | { ok: true; capacity: number | null; written: number; checks: RegionChecks }
  | { ok: false; reason: string; detail?: string; written?: number };

class Collect implements ByteSink {
  chunks: Uint8Array[] = [];
  write(c: Uint8Array) { this.chunks.push(c.slice()); }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

async function readSectors(r: Runner, lba: number, sectors: number): Promise<Uint8Array | null> {
  const sink = new Collect();
  const res = await r.run(['rl', String(lba), String(sectors), r.mountSink(sink)]);
  return res.code === 0 ? sink.bytes().subarray(0, sectors * SECTOR) : null;
}

/**
 * Write regions at their own sectors, after the `before` commands (an
 * update.img's gpt parameter.txt and ul loader), then compare what was
 * written: in full within checkHeadBytes, by samples past it.
 */
export async function flashRegions(r: Runner, plan: RegionPlan, hooks: Hooks): Promise<RegionResult> {
  let written = 0;
  const step = async (args: string[], what: string) => {
    if (hooks.cancelled()) throw new FlashError('Cancelled.');
    hooks.log(`$ rkdeveloptool ${args.join(' ')}`);
    const res = await r.run(args);
    if (res.code !== 0) throw new FlashError(`${what} failed (rkdeveloptool exit ${res.code}).`);
  };
  try {
    await bringUp(r, plan, hooks);
    const capacity = await selectStorage(r, plan.storageCode, plan.storageLabel, hooks);
    const planned = plan.plan(capacity);
    if ('stop' in planned) return { ok: false, reason: `${planned.stop} Nothing was written.` };
    for (const g of planned.regions) {
      if (capacity !== null && g.lba * SECTOR + g.source.size > capacity) {
        return { ok: false, reason: `${g.label} does not fit ${plan.storageLabel} (${capacity} bytes). Nothing was written.` };
      }
    }

    hooks.stage('write');
    for (const b of planned.before ?? []) {
      const paths = b.files.map((f) => r.writeFile(f.name, f.data));
      await step(b.args(paths), b.what);
    }
    const total = planned.regions.reduce((n, g) => n + g.source.size, 0);
    hooks.progress('write', 0);
    for (const g of planned.regions) {
      const base = written;
      const counted: ByteSource = {
        size: g.source.size,
        read(position, length) {
          hooks.progress('write', Math.floor(Math.min(base + position + length, total) * 100 / total));
          return g.source.read(position, length);
        },
      };
      await step(['wl', String(g.lba), r.mountSource(counted)], `Writing ${g.label}`);
      written += g.source.size;
    }

    hooks.stage('verify');
    hooks.progress('verify', 0);
    const checks: RegionChecks = { headBytes: 0, matched: 0, filler: 0, unsure: 0 };
    const limit = Math.min(plan.checkHeadBytes, TRUSTED_READ_BYTES);
    const CHUNK = 1 << 20;
    const headTotal = planned.regions.reduce((n, g) => n + Math.max(0, Math.min(g.lba * SECTOR + g.source.size, limit) - g.lba * SECTOR), 0);
    for (const g of planned.regions) {
      const start = g.lba * SECTOR;
      const end = Math.min(start + g.source.size, limit);
      for (let at = start; at < end; at += CHUNK) {
        const len = Math.min(CHUNK, end - at);
        const got = await readSectors(r, at / SECTOR, Math.ceil(len / SECTOR));
        if (!got || !sameBytes(got.subarray(0, len), g.source.read(at - start, len))) {
          return { ok: false, written, reason: `${g.label} does not read back as written (sector ${at / SECTOR}). Write it again.` };
        }
        checks.headBytes += len;
        if (headTotal) hooks.progress('verify', Math.floor(checks.headBytes * 100 / headTotal));
      }
      // Past the trusted part: the start, middle and end of the region.
      if (start + g.source.size > limit) {
        const from = Math.max(0, limit - start);
        const len = Math.min(SAMPLE, g.source.size - from);
        const offs = new Set([from, Math.max(from, g.source.size - len), from + Math.floor((g.source.size - from) / 2 / SECTOR) * SECTOR]);
        for (const off of offs) {
          const n = Math.min(len, g.source.size - off);
          if (n <= 0) continue;
          const got = await readSectors(r, (start + off) / SECTOR, Math.ceil(n / SECTOR));
          if (got && sameBytes(got.subarray(0, n), g.source.read(off, n))) checks.matched++;
          else if (got && got.subarray(0, n).every((x) => x === FILLER)) checks.filler++;
          else {
            checks.unsure++;
            hooks.log(`Sample at sector ${(start + off) / SECTOR} (${g.label}) read back ${got ? 'differently' : 'with an error'}; past 32 MiB the loader's reads are not trusted.`);
          }
        }
      }
    }
    hooks.progress('verify', 100);
    hooks.log(`Read back and compared ${checks.headBytes} bytes within the first ${limit / (1 << 20)} MiB: all equal.`);

    if (plan.resetAfter) {
      hooks.stage('reset');
      await r.run(['rd']);
    }
    return { ok: true, capacity, written, checks };
  } catch (e) {
    if (e instanceof Stopped) return e.result;
    const partly = written > 0 ? ` The ${plan.storageLabel} is only partly written: run the same write again.` : '';
    if (e instanceof FlashError) {
      if (await boardGone(r, e, hooks)) return { ok: false, reason: `${BOARD_GONE}${partly}`, detail: e.message, written };
      return { ok: false, reason: `${e.message}${partly}`, written };
    }
    return { ok: false, reason: 'rkdeveloptool stopped with an error.', detail: String((e as Error)?.message ?? e), written };
  }
}
