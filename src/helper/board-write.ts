// The on-board writer: run on one of the boards under Linux, with
// administrator rights (pkexec, through main/elevate.ts like the SD writer),
// it writes that board's own eMMC or SPI NOR flash.
//
//   write-helper --socket PATH --token T --job FILE.json
//
// It trusts nothing in the job but what to write: the board, its eMMC, its
// SPI NOR flash and what is mounted are looked up again here
// (main/board-here.ts). The job must name the board this is, and a device
// that is that board's eMMC or SPI NOR flash; the eMMC is refused while
// anything on it is mounted or in use, the flash while it is mounted. The
// eMMC is then written by the SD writer (write-helper.ts, runWrite), which
// checks the disk once more as a built-in disk and reads it back against the
// release's SHA-256. The flash is written with flashcp, which erases, writes
// and reads it back.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { boardHere } from '../main/board-here';
import { maskromBoard } from '../maskrom/boards';
import type { HelperArgs, HelperMessage } from './write-helper';

export type BoardJob =
  /** A whole image (compressed as the release has it) onto the eMMC, read back against its decompressed SHA-256. */
  | { kind: 'emmc'; boardId: string; device: string; image: string; extractSize: number; extractSha256: string }
  /** A bootloader (plain, as the release has it) into the SPI NOR flash. */
  | { kind: 'spinor'; boardId: string; device: string; image: string; size: number; sha256: string };

const NOTHING = 'Nothing was written.';

export function parseJob(raw: string): BoardJob {
  const j = JSON.parse(raw) as BoardJob;
  const str = (v: unknown) => typeof v === 'string' && v.length > 0;
  if (!j || (j.kind !== 'emmc' && j.kind !== 'spinor')) throw new Error('bad job kind');
  if (!str(j.boardId) || !str(j.device) || !str(j.image)) throw new Error('bad job');
  if (!/^\/dev\/(mmcblk\d+|mtd\d+)$/.test(j.device)) throw new Error('bad job device');
  const size = j.kind === 'emmc' ? j.extractSize : j.size;
  const sha = j.kind === 'emmc' ? j.extractSha256 : j.sha256;
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('bad job size');
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('bad job sha256');
  return j;
}

/** flashcp -v prints "Erasing blocks: 3/16 (18%)", then "Writing data: ...", then "Verifying data: ...". */
export function flashcpProgress(text: string): { stage: 'write' | 'verify'; percent: number } | null {
  let last: { stage: 'write' | 'verify'; percent: number } | null = null;
  for (const m of text.matchAll(/(Erasing|Writing|Verifying)[^(\n\r]*\((\d+)%\)/g)) {
    const pct = Number(m[2]);
    // Erasing and writing are one bar, half each.
    last = m[1] === 'Verifying' ? { stage: 'verify', percent: pct }
      : { stage: 'write', percent: m[1] === 'Erasing' ? Math.floor(pct / 2) : 50 + Math.floor(pct / 2) };
  }
  return last;
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Write the job, or say why not. `writeImage` is the SD writer's runWrite;
 * `root` is for tests only (the helper itself always looks at /).
 */
export async function runBoardJob(job: BoardJob, send: (m: HelperMessage) => void,
  writeImage: (a: HelperArgs, send: (m: HelperMessage) => void) => Promise<void>, root = ''): Promise<void> {
  const fail = (reason: string, detail?: string) => send({ type: 'done', ok: false, reason, ...(detail ? { detail } : {}) });
  const here = await boardHere(root);
  const board = maskromBoard(job.boardId);
  if (!here.board || !board) return fail(`This is not a board the imager knows. ${NOTHING}`);
  if (here.board.board !== board.board) return fail(`This board is the ${here.board.boardName}, not the ${board.boardName}. ${NOTHING}`);
  if (!here.storages.includes(job.kind)) {
    return fail(`The imager does not write the ${job.kind === 'emmc' ? 'eMMC' : 'SPI NOR flash'} of the ${board.boardName}. ${NOTHING}`);
  }

  if (job.kind === 'emmc') {
    if (!here.emmc || here.emmc.device !== job.device) return fail(`${job.device} is not this board's eMMC. ${NOTHING}`);
    if (here.emmcRefusal) return fail(`${here.emmcRefusal} ${NOTHING}`);
    if (here.emmc.bytes < job.extractSize) {
      return fail(`The image (${job.extractSize} bytes) does not fit on the eMMC (${here.emmc.bytes} bytes). ${NOTHING}`);
    }
    // The SD writer checks the disk again (a built-in disk with nothing in
    // use, not the system disk), writes, and reads it back.
    return writeImage({
      socket: '', token: '', image: job.image, device: job.device, extractSize: job.extractSize,
      extractSha256: job.extractSha256, allowLoop: false, allowInternal: true,
    }, send);
  }

  const mtd = here.mtd.find((m) => m.device === job.device);
  if (!mtd) return fail(`${job.device} is not an SPI NOR flash on this board. ${NOTHING}`);
  if (mtd.mounts.length) return fail(`${job.device} is in use: mounted at ${mtd.mounts.join(', ')}. ${NOTHING}`);
  const size = statSync(job.image).size;
  if (size !== job.size || sha256OfFile(job.image) !== job.sha256) {
    return fail(`The bootloader file does not match the release. ${NOTHING}`);
  }
  const limit = Math.min(mtd.bytes, board.spiFlashSize ?? mtd.bytes);
  if (size > limit) return fail(`The image (${size} bytes) is larger than the SPI NOR flash (${limit} bytes). ${NOTHING}`);
  const flashcp = ['/usr/sbin/flashcp', '/usr/bin/flashcp', '/sbin/flashcp'].find((p) => existsSync(p));
  if (!flashcp) return fail(`flashcp is not installed. Install mtd-utils (it erases, writes and checks the flash) and try again. ${NOTHING}`);
  send({ type: 'progress', stage: 'write', bytes: 0, percent: 0, speed: 0 });
  let out = '';
  const code = await new Promise<number | null>((resolve) => {
    const p = spawn(flashcp, ['-v', job.image, job.device]);
    const take = (d: Buffer) => {
      out = (out + d.toString()).slice(-20000);
      const pr = flashcpProgress(d.toString());
      if (pr) send({ type: 'progress', stage: pr.stage, percent: pr.percent, bytes: Math.floor(size * pr.percent / 100), speed: 0 });
    };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('error', () => resolve(null));
    p.on('close', resolve);
  });
  if (code !== 0) {
    return fail('flashcp failed. The SPI NOR flash may be partly written: write it again before restarting the board.', out.trim().split(/[\r\n]+/).slice(-20).join('\n'));
  }
  send({ type: 'progress', stage: 'verify', bytes: size, percent: 100, speed: 0 });
  send({ type: 'done', ok: true, sha256: job.sha256 });
}
