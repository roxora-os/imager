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
import { flash, parseFlashSize, parseList, type FlashPlan, type Hooks } from '../src/maskrom/sequence';

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
    expect((res as { reason: string }).reason).toMatch(new RegExp(`^Could not verify: from ${4 * MiB} bytes on`));
  });

  it('stops when the written bytes do not match the release checksum', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1 });
    const { runner } = await setup(board);
    const res = await flash(runner, plan(image, { expectedSha256: '0'.repeat(64) }), hooks([]));
    expect((res as { reason: string }).reason).toMatch(/does not match the release checksum/);
  });

  it('says so when the board does not come back after the loader', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1, stayAway: true });
    const { runner } = await setup(board);
    const res = await flash(runner, plan(image, { reconnectTimeout: 1500 }), hooks([]));
    expect((res as { reason: string }).reason).toMatch(/did not come back/);
  });

  it('says so when no board is connected', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1 });
    board.devices = [];
    const { runner } = await setup(board);
    const res = await flash(runner, plan(image), hooks([]));
    expect((res as { reason: string }).reason).toBe('No board in Maskrom mode was found.');
  });
});
