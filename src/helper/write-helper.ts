// The SD/USB writer for Linux and Windows (macOS: main/mac-write.ts). Runs
// as its own process with administrator rights (pkexec or UAC; see
// main/elevate.ts) because writing a whole drive needs them. It talks to the app over a local socket
// with one JSON object per line.
//
//   write-helper --socket PATH --token T --image FILE.img.xz --device DEV
//                --extract-size N --extract-sha256 HEX [--allow-internal]
//   write-helper --socket PATH --token T --job FILE.json
//
// The second form writes the board this runs on (helper/board-write.ts).
//
// It checks the target again (the app's list could be stale, and this
// process trusts nothing it is told): on Linux with lsblk's view of every
// disk as well, so the disk the system runs from is refused here too, and a
// built-in disk only with --allow-internal, which the app passes after the
// user confirmed that disk. Then it writes with etcher-sdk, and reads the
// drive back and compares the SHA-256 of the image's bytes with the release's
// extract_sha256.

import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import * as drivelist from 'drivelist';
// Only the parts the writer uses: etcher-sdk's index also loads its device
// scanner, which pulls in the Raspberry Pi and BeagleBone USB boot modules
// and their firmware blobs. Those are not shipped (scripts/build-writer.mjs).
import * as multiWrite from 'etcher-sdk/build/multi-write';
import { guardReadsAfterClose } from './read-guard';
import * as sourceDestination from 'etcher-sdk/build/source-destination';
import { isOfferedTarget, type DriveInfo } from '../shared/targets';
import { withDiskFacts } from '../main/linux-disks';
import { parseJob, runBoardJob } from './board-write';

export interface HelperArgs {
  socket: string;
  token: string;
  image: string;
  device: string;
  extractSize: number;
  extractSha256: string;
  /** Only for the CI test: allow /dev/loopN, which is never a system disk. */
  allowLoop: boolean;
  /** A built-in disk (eMMC, SD card slot, NVMe) that holds nothing in use may be written. */
  allowInternal: boolean;
}

export type HelperMessage =
  | { type: 'hello'; token: string }
  | { type: 'progress'; stage: 'write' | 'verify'; percent: number; bytes: number; speed: number }
  | { type: 'done'; ok: true; sha256: string }
  | { type: 'done'; ok: false; reason: string; detail?: string };

export function parseArgs(argv: string[]): HelperArgs {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    if (i < 0 || i + 1 >= argv.length) throw new Error(`missing --${k}`);
    return argv[i + 1];
  };
  const extractSize = Number(get('extract-size'));
  const extractSha256 = get('extract-sha256');
  if (!Number.isSafeInteger(extractSize) || extractSize <= 0) throw new Error('bad --extract-size');
  if (!/^[0-9a-f]{64}$/.test(extractSha256)) throw new Error('bad --extract-sha256');
  return {
    socket: get('socket'), token: get('token'), image: get('image'), device: get('device'),
    extractSize, extractSha256,
    allowLoop: argv.includes('--allow-loop') && process.env.ROXORA_IMAGER_TEST === '1',
    allowInternal: argv.includes('--allow-internal'),
  };
}

async function readBackSha256(drive: drivelist.Drive, length: number,
  progress: (bytes: number) => void): Promise<string> {
  const dev = new sourceDestination.BlockDevice({ drive, write: false, direct: true });
  await dev.open();
  try {
    const stream = await dev.createReadStream({ start: 0, end: length - 1, alignment: dev.alignment });
    const h = createHash('sha256');
    let done = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      h.update(chunk);
      done += chunk.length;
      progress(done);
    }
    if (done !== length) throw new Error(`read ${done} bytes back, expected ${length}`);
    return h.digest('hex');
  } finally {
    await dev.close();
  }
}

export async function runWrite(a: HelperArgs, send: (m: HelperMessage) => void): Promise<void> {
  const drives = await drivelist.list();
  let drive = drives.find((d) => d.device === a.device);
  const loop = a.allowLoop && /^\/dev\/loop\d+$/.test(a.device);
  if (loop && !drive) {
    // drivelist does not always list loop devices; describe it ourselves.
    const { statSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    statSync(a.device);
    const size = Number(execFileSync('blockdev', ['--getsize64', a.device]).toString().trim());
    drive = {
      device: a.device, displayName: a.device, description: 'loop device', size, raw: a.device,
      mountpoints: [], isReadOnly: false, isSystem: false, isVirtual: true, isRemovable: true,
      isCard: false, isUSB: false, isSCSI: false, isUAS: false, busType: 'VIRTUAL', busVersion: null,
      error: null, enumerator: 'test', blockSize: 512, logicalBlockSize: 512, devicePath: null,
      partitionTableType: null,
    } as unknown as drivelist.Drive;
  }
  if (!drive) {
    send({ type: 'done', ok: false, reason: `${a.device} is no longer connected.` });
    return;
  }
  const checked = loop ? [] : await withDiskFacts(drives as unknown as DriveInfo[]);
  if (!loop && !isOfferedTarget(a.device, checked, { minSize: a.extractSize, platform: process.platform, internal: a.allowInternal })) {
    send({ type: 'done', ok: false, reason: `${a.device} is not a drive the imager writes to (system disk, a built-in disk in use, read-only or too small). Nothing was written.` });
    return;
  }

  const source = new sourceDestination.File({ path: a.image });
  guardReadsAfterClose(source);
  const dest = new sourceDestination.BlockDevice({ drive, write: true, direct: true, unmountOnSuccess: false });
  let failure: Error | null = null;
  await multiWrite.decompressThenFlash({
    source,
    destinations: [dest],
    verify: false, // checked below against the release, not against the source
    trim: false,
    decompressFirst: false,
    numBuffers: 16,
    onFail: (_d, e) => { failure = e; },
    onProgress: (p) => {
      const bytes = p.position ?? 0;
      send({ type: 'progress', stage: 'write', bytes, speed: p.speed ?? 0,
        percent: Math.min(100, Math.floor(bytes * 100 / a.extractSize)) });
    },
  });
  if (failure) {
    send({ type: 'done', ok: false, reason: 'Writing failed.', detail: String((failure as Error).message) });
    return;
  }

  let last = 0;
  const sha = await readBackSha256(drive, a.extractSize, (bytes) => {
    const pct = Math.floor(bytes * 100 / a.extractSize);
    if (pct !== last) {
      last = pct;
      send({ type: 'progress', stage: 'verify', percent: pct, bytes, speed: 0 });
    }
  });
  if (sha !== a.extractSha256) {
    send({ type: 'done', ok: false, reason: 'The drive does not read back what the release contains. Do not use it; try another card or drive.',
      detail: `read back ${sha}, release ${a.extractSha256}` });
    return;
  }
  send({ type: 'done', ok: true, sha256: sha });
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--job')) return boardMain(argv);
  let args: HelperArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`write-helper: ${(e as Error).message}\n`);
    return 2;
  }
  const sock: Socket = await new Promise((resolve, reject) => {
    const s = connect(args.socket, () => resolve(s));
    s.on('error', reject);
  });
  const send = (m: HelperMessage) => { sock.write(`${JSON.stringify(m)}\n`); };
  send({ type: 'hello', token: args.token });
  // The app asks us to stop by sending "cancel". The drive is then left
  // half written, which the app says.
  sock.on('data', (d) => { if (d.toString().includes('"cancel"')) process.exit(3); });
  let code = 0;
  try {
    await runWrite(args, send);
  } catch (e) {
    send({ type: 'done', ok: false, reason: 'Writing stopped with an error.', detail: String((e as Error)?.message ?? e) });
    code = 1;
  }
  await new Promise<void>((r) => sock.end(r));
  return code;
}

/** The board this runs on: its eMMC or SPI NOR flash (board-write.ts). Linux only. */
async function boardMain(argv: string[]): Promise<number> {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    if (i < 0 || i + 1 >= argv.length) throw new Error(`missing --${k}`);
    return argv[i + 1];
  };
  let job;
  let socket: string;
  let token: string;
  try {
    socket = get('socket');
    token = get('token');
    const { readFileSync } = await import('node:fs');
    job = parseJob(readFileSync(get('job'), 'utf8'));
  } catch (e) {
    process.stderr.write(`write-helper: ${(e as Error).message}\n`);
    return 2;
  }
  const sock: Socket = await new Promise((resolve, reject) => {
    const s = connect(socket, () => resolve(s));
    s.on('error', reject);
  });
  const send = (m: HelperMessage) => { sock.write(`${JSON.stringify(m)}\n`); };
  send({ type: 'hello', token });
  sock.on('data', (d) => { if (d.toString().includes('"cancel"')) process.exit(3); });
  let code = 0;
  try {
    if (process.platform !== 'linux') send({ type: 'done', ok: false, reason: 'Writing the board this runs on works on Linux only.' });
    else await runBoardJob(job, send, runWrite);
  } catch (e) {
    send({ type: 'done', ok: false, reason: 'Writing stopped with an error.', detail: String((e as Error)?.message ?? e) });
    code = 1;
  }
  await new Promise<void>((r) => sock.end(r));
  return code;
}

// Started directly (bundled as build/helper/write-helper.js). The flags are
// looked up by name, so it does not matter whether the bootstrap file or
// the helper itself is argv[1].
if (process.env.ROXORA_IMAGER_HELPER === '1') {
  main(process.argv.slice(1)).then((c) => process.exit(c), (e) => {
    process.stderr.write(`write-helper: ${String(e)}\n`);
    process.exit(1);
  });
}
