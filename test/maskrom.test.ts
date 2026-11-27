// The Maskrom sequence through the real rkdeveloptool WASM and its libusb
// WebUSB backend, against a pretend board (fake-rockchip.ts).
//
// Needs vendor/rkdeveloptool-wasm/ (scripts/build-wasm.sh, or the CI
// artifact). Skipped when it is missing so a fresh checkout can still run the
// other tests; CI always has it.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { FakeBoard } from './fake-rockchip';
import { syntheticLoader } from './synthetic-loader';
import { createRunner } from '../src/maskrom/runner';
import { BOARD_GONE, flash, parseFlashSize, parseList, spiStorageProblem, SPI_MAX_BYTES, type FlashPlan, type Hooks } from '../src/maskrom/sequence';

const WASM_DIR = new URL('../vendor/rkdeveloptool-wasm/', import.meta.url);
const haveWasm = existsSync(new URL('rkdeveloptool.wasm', WASM_DIR));
// rkdeveloptool parses the loader, so it must be one; built from random bytes.
const loader = syntheticLoader();

const MiB = 1024 * 1024;

async function setup(board: FakeBoard) {
  Object.defineProperty(globalThis.navigator, 'usb', { value: board.usb(), configurable: true });
  const mod = await import(pathToFileURL(new URL('rkdeveloptool.js', WASM_DIR).pathname).href);
  const log: string[] = [];
  const runner = await createRunner(mod.default, {
    log: (l) => log.push(l),
    wasmBinary: readFileSync(new URL('rkdeveloptool.wasm', WASM_DIR)),
  });
  return { runner, log };
}

function hooks(stages: string[]): Hooks {
  return {
    stage: (s) => stages.push(s),
    progress: () => {},
    log: () => {},
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    cancelled: () => false,
  };
}

function source(data: Uint8Array) {
  return { size: data.length, read: (p: number, n: number) => data.subarray(p, p + n) };
}

function plan(data: Uint8Array, p: Partial<FlashPlan> = {}): FlashPlan {
  return {
    loader, storageCode: 1, storageLabel: 'eMMC', source: source(data),
    expectedSha256: createHash('sha256').update(data).digest('hex'),
    verify: true, resetAfter: true, reconnectTimeout: 5000, ...p,
  };
}

describe('output parsing', () => {
  it('reads the device mode from ld', () => {
    expect(parseList(['DevNo=1\tVid=0x2207,Pid=0x350e,LocationID=101\tMaskrom'])).toBe('maskrom');
    expect(parseList(['DevNo=1\tVid=0x2207,Pid=0x350e,LocationID=101\tLoader'])).toBe('loader');
    expect(parseList(['not found any devices!'])).toBe('none');
    expect(parseList(['DevNo=1 ... Loader', 'DevNo=2 ... Loader'])).toBe('several');
  });
  it('reads the storage size from rfi', () => {
    expect(parseFlashSize(['Flash Info:', '\tFlash Size: 7456 MB', '\tFlash Size: 15269888 Sectors'])).toBe(15269888 * 512);
    expect(parseFlashSize(['Read Flash Info failed!'])).toBeNull();
  });
});

describe.skipIf(!haveWasm)('Maskrom flash through the WASM rkdeveloptool', () => {
  // An odd size, so the last block is a partial sector.
  const image = new Uint8Array(randomBytes(6 * MiB + 1234));

  it('sends the loader, follows the re-enumeration without a second pick, writes eMMC and verifies', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB, 9: 16 * MiB }, defaultStorage: 9 });
    const { runner, log } = await setup(board);
    const stages: string[] = [];
    const res = await flash(runner, plan(image), hooks(stages));
    expect({ res, log: log.slice(-15) }).toMatchObject({ res: { ok: true, verified: "match", capacity: 64 * MiB } });
    expect(stages).toEqual(['detect', 'loader', 'reconnect', 'storage', 'write', 'verify', 'reset']);
    // db sends the 0x471 (DDR init) and 0x472 (usbplug) entries of the loader.
    expect(board.loaderBytes).toBeGreaterThan(100_000);
    expect(Buffer.from(board.contents(1, image.length)).equals(Buffer.from(image))).toBe(true);
    // SPI NOR untouched.
    expect(board.contents(9, 4096).every((b) => b === 0)).toBe(true);
    expect(board.resets).toBe(1);
  });

  it('refuses when the storage does not switch, and writes nothing', async () => {
    const board = new FakeBoard({ storages: { 9: 16 * MiB }, defaultStorage: 9 });
    const { runner } = await setup(board);
    const res = await flash(runner, plan(image), hooks([]));
    expect(res).toMatchObject({ ok: false });
    expect((res as { reason: string }).reason).toMatch(/did not switch to eMMC/);
    expect(board.log.filter((l) => l === 'cmd 0x15')).toEqual([]);
  });

  it('refuses an image larger than the storage', async () => {
    const board = new FakeBoard({ storages: { 9: 4 * MiB }, defaultStorage: 9 });
    const { runner } = await setup(board);
    const res = await flash(runner, plan(image, { storageCode: 9, storageLabel: 'SPI NOR flash' }), hooks([]));
    expect((res as { reason: string }).reason).toMatch(/does not fit in SPI NOR flash/);
    expect(board.log.filter((l) => l === 'cmd 0x15')).toEqual([]);
  });

  it('reports a read-back mismatch with its offset', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1, corruptReadAt: 3 * MiB + 7 });
    const { runner } = await setup(board);
    const res = await flash(runner, plan(image), hooks([]));
    expect((res as { reason: string }).reason).toBe(`Read-back does not match: first difference at byte ${3 * MiB + 7}.`);
  });

  it('tells loader filler apart from a bad write', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1, fillerFrom: 4 * MiB });
    const { runner } = await setup(board);
    const res = await flash(runner, plan(image), hooks([]));
    expect(res).toMatchObject({ ok: true, verified: 'partial', verifiedBytes: 4 * MiB });
  });

  it('stops when the written bytes do not match the release checksum', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1 });
    const { runner } = await setup(board);
    const res = await flash(runner, plan(image, { expectedSha256: '0'.repeat(64) }), hooks([]));
    expect((res as { reason: string }).reason).toMatch(/does not match the release checksum/);
  });

  it('goes on when the board comes back from the loader still looking like Maskrom (RK3576)', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB, 9: 16 * MiB }, defaultStorage: 9, loaderLooksLikeMaskrom: true });
    const { runner } = await setup(board);
    const stages: string[] = [];
    const res = await flash(runner, plan(image), hooks(stages));
    expect(res).toMatchObject({ ok: true, verified: 'match' });
    expect(stages).toEqual(['detect', 'loader', 'reconnect', 'storage', 'write', 'verify', 'reset']);
    expect(board.loaderBytes).toBeGreaterThan(100_000);
    expect(Buffer.from(board.contents(1, image.length)).equals(Buffer.from(image))).toBe(true);
  });

  it('does not send the loader again when it already runs (RK3576 after an earlier attempt)', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB, 9: 16 * MiB }, defaultStorage: 9, loaderAlreadyRunning: true });
    const { runner } = await setup(board);
    const stages: string[] = [];
    const res = await flash(runner, plan(image), hooks(stages));
    expect(res).toMatchObject({ ok: true, verified: 'match' });
    expect(stages).toEqual(['detect', 'storage', 'write', 'verify', 'reset']);
    expect(board.loaderBytes).toBe(0);
    expect(Buffer.from(board.contents(1, image.length)).equals(Buffer.from(image))).toBe(true);
  });

  it('says so when the board does not come back after the loader', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1, stayAway: true });
    const { runner } = await setup(board);
    const res = await flash(runner, plan(image, { reconnectTimeout: 1500 }), hooks([]));
    expect((res as { reason: string }).reason).toBe(`${BOARD_GONE} It did not come back after the loader was sent.`);
  });

  it('says the board was disconnected when it goes away during the write', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1, unplugOnWrite: true });
    const { runner } = await setup(board);
    const res = await flash(runner, plan(image), hooks([]));
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe(BOARD_GONE);
    expect((res as { detail?: string }).detail).toMatch(/Writing failed/);
  });

  it('says so when no board is connected', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1 });
    board.devices = [];
    const { runner } = await setup(board);
    const res = await flash(runner, plan(image), hooks([]));
    expect((res as { reason: string }).reason).toBe('No board in Maskrom mode was found.');
  });

  // The SPI NOR flash (from Maskrom Studio's safer SPI write): a copy of it is kept before anything is written.
  const bootloader = new Uint8Array(randomBytes(3 * MiB + 512));
  const spiPlan = (keep: (c: Uint8Array) => Promise<{ path: string } | { error: string }>) =>
    plan(bootloader, { storageCode: 9, storageLabel: 'SPI NOR flash', spiNor: { keep } });

  it('keeps the whole SPI NOR flash before writing it, then writes and verifies', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB, 9: 16 * MiB }, defaultStorage: 1 });
    const before = new Uint8Array(randomBytes(16 * MiB));
    board.storages.get(9)!.write(0, before);
    const { runner } = await setup(board);
    const stages: string[] = [];
    let kept: Uint8Array | null = null;
    const res = await flash(runner, spiPlan(async (c) => { kept = c.slice(); return { path: '/kept' }; }), hooks(stages));
    expect(res).toMatchObject({ ok: true, verified: 'match', capacity: 16 * MiB });
    expect(stages).toEqual(['detect', 'loader', 'reconnect', 'storage', 'backup', 'write', 'verify', 'reset']);
    expect(kept).not.toBeNull();
    expect(Buffer.from(kept!).equals(Buffer.from(before))).toBe(true);
    expect(Buffer.from(board.contents(9, bootloader.length)).equals(Buffer.from(bootloader))).toBe(true);
  });

  it('writes nothing to the SPI NOR flash when its copy cannot be kept', async () => {
    const board = new FakeBoard({ storages: { 9: 16 * MiB }, defaultStorage: 9 });
    const { runner } = await setup(board);
    const res = await flash(runner, spiPlan(async () => ({ error: 'disk full' })), hooks([]));
    expect(res).toMatchObject({ ok: false, reason: 'The copy of the SPI NOR flash could not be saved on this computer. Nothing was written.', detail: 'disk full' });
    expect(board.log.filter((l) => l === 'cmd 0x15')).toEqual([]);
  });

  it('never takes a storage larger than any SPI NOR flash for it (an eMMC or a UFS module)', async () => {
    // A loader that answers the switch to SPI NOR (cs 9) but stays on a 32 GB storage.
    const board = new FakeBoard({ storages: { 9: 32e9 }, defaultStorage: 9 });
    const { runner } = await setup(board);
    let asked = false;
    const res = await flash(runner, spiPlan(async () => { asked = true; return { path: '/kept' }; }), hooks([]));
    expect((res as { reason: string }).reason).toBe(spiStorageProblem(32e9));
    expect(asked).toBe(false);
    expect(board.log.filter((l) => l === 'cmd 0x15')).toEqual([]);
  });
});

describe('the SPI NOR storage check', () => {
  it('needs a size, and one an SPI NOR flash can have', () => {
    expect(spiStorageProblem(null)).toMatch(/did not report the size/);
    expect(spiStorageProblem(16 * MiB)).toBeNull();
    expect(spiStorageProblem(SPI_MAX_BYTES)).toBeNull();
    expect(spiStorageProblem(SPI_MAX_BYTES + 512)).toMatch(/larger than any SPI NOR flash/);
  });
});
