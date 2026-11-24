// A Rockchip update.img: reading it (rkfw.ts), planning its writes, writing
// it over Maskrom with the partition table and loader first, and clearing
// the old backup GPT after a whole image. The Maskrom part runs the real
// rkdeveloptool WASM against a pretend board (fake-rockchip.ts) and is
// skipped without vendor/rkdeveloptool-wasm/.
import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkUpdateMd5, inspectUpdateImage } from '../src/main/update-image';
import { pathToFileURL } from 'node:url';
import { bytesSource, chipName, parseParameter, planUpdateRegions, readUpdateImage, RK3576 } from '../src/maskrom/rkfw';
import { BACKUP_GPT_SECTORS, backupGptLba, flash, flashRegions, type Hooks } from '../src/maskrom/sequence';
import { createRunner } from '../src/maskrom/runner';
import { FakeBoard } from './fake-rockchip';
import { syntheticLoader } from './synthetic-loader';

/** A small update.img as afptool and rkImageMaker lay it out. */
function synthUpdateImg(opts: { chip?: number; loaderChip?: number; bigBoot?: boolean } = {}): Uint8Array {
  const parameter = 'FIRMWARE_VER: 14.0\nMACHINE_MODEL: TaishanPi3M\nCMDLINE: mtdparts=:0x00002000@0x00004000(uboot),0x00000800@0x00006000(misc),0x00020000@0x00006800(boot),-@0x00026800(userdata:grow)\n';
  const parm = new Uint8Array(8 + parameter.length + 4);
  parm.set(new TextEncoder().encode('PARM'), 0);
  new DataView(parm.buffer).setUint32(4, parameter.length, true);
  parm.set(new TextEncoder().encode(parameter), 8);
  const uboot = new Uint8Array(4096).fill(0x55);
  const boot = new Uint8Array(opts.bigBoot ? 0x20001 * 512 : 6000).fill(0xbb);
  const sparse = new Uint8Array(64);
  new DataView(sparse.buffer).setUint32(0, 0xed26ff3a, true);
  const parts: Array<[string, string, Uint8Array]> = [['parameter', 'parameter.txt', parm], ['uboot', 'Image/uboot.img', uboot], ['boot', 'Image/boot.img', boot], ['userdata', 'Image/userdata.img', sparse]];
  const header = 2048;
  let pos = header;
  const placed = parts.map(([n, f, d]) => { const at = pos; pos += Math.ceil(d.length / 2048) * 2048; return { n, f, d, at }; });
  const rkaf = new Uint8Array(pos);
  const dv = new DataView(rkaf.buffer);
  rkaf.set(new TextEncoder().encode('RKAF'), 0);
  dv.setUint32(4, pos, true);
  rkaf.set(new TextEncoder().encode('TaishanPi3M'), 8);
  rkaf.set(new TextEncoder().encode('LCKFB'), 72);
  dv.setUint32(136, placed.length, true);
  placed.forEach((p, i) => {
    const o = 140 + i * 112;
    rkaf.set(new TextEncoder().encode(p.n), o);
    rkaf.set(new TextEncoder().encode(p.f), o + 32);
    dv.setUint32(o + 96, p.at, true);
    dv.setUint32(o + 108, p.d.length, true);
    rkaf.set(p.d, p.at);
  });
  const loader = new Uint8Array(4096);
  loader.set(new TextEncoder().encode('LDR '), 0);
  new DataView(loader.buffer).setUint32(0x15, opts.loaderChip ?? RK3576, true);
  const head = new Uint8Array(0x66);
  const hv = new DataView(head.buffer);
  head.set(new TextEncoder().encode('RKFW'), 0);
  hv.setUint16(4, 0x66, true);
  hv.setUint32(6, 0x0e000000, true);
  hv.setUint16(0x0e, 2026, true); head[0x10] = 11; head[0x11] = 2;
  hv.setUint32(0x15, opts.chip ?? RK3576, true);
  hv.setUint32(0x19, 0x66, true);
  hv.setUint32(0x1d, loader.length, true);
  hv.setUint32(0x21, 0x66 + loader.length, true);
  hv.setUint32(0x25, rkaf.length, true);
  const body = new Uint8Array(0x66 + loader.length + rkaf.length);
  body.set(head, 0); body.set(loader, 0x66); body.set(rkaf, 0x66 + loader.length);
  const md5 = new TextEncoder().encode(createHash('md5').update(body).digest('hex'));
  const out = new Uint8Array(body.length + 32);
  out.set(body, 0); out.set(md5, body.length);
  return out;
}

describe('an update.img', () => {
  it('names the chip as the header spells it', () => {
    expect(chipName(RK3576)).toBe('RK3576');
    expect(chipName(0x33353838)).toBe('RK3588');
  });
  it('reads parameter.txt partitions', () => {
    expect(parseParameter('CMDLINE: console=ttyFIQ0 mtdparts=rk29xxnand:0x2000@0x4000(uboot),-@0x26800(userdata:grow)')).toEqual([
      { name: 'uboot', lba: 0x4000, sectors: 0x2000, grow: false }, { name: 'userdata', lba: 0x26800, sectors: null, grow: true },
    ]);
  });
  it('lists what it holds and plans the writes where parameter.txt says', () => {
    const file = synthUpdateImg();
    const img = readUpdateImage(bytesSource(file));
    expect(img).toMatchObject({ chip: 'RK3576', model: 'TaishanPi3M', manufacturer: 'LCKFB', released: '2026-11-02', loader: { chip: 'RK3576' } });
    const plan = planUpdateRegions(bytesSource(file), img, 32e9);
    if ('stop' in plan) throw new Error(plan.stop);
    expect(plan.regions.map((r) => [r.lba, r.source.size])).toEqual([[0x4000, 4096], [0x6800, 6000], [0x26800, 64]]);
    expect(new TextDecoder().decode(plan.parameter)).toMatch(/^FIRMWARE_VER/);
    expect(plan.loader.subarray(0, 4)).toEqual(new TextEncoder().encode('LDR '));
    expect(plan.summary).toMatchObject({ model: 'TaishanPi3M', partitions: [{ name: 'uboot' }, { name: 'boot' }, { name: 'userdata' }] });
  });
  it('refuses another chip, another chip\'s loader, a partition image too large for its place, an RKAF alone, a cut file, a small eMMC', () => {
    const other = synthUpdateImg({ chip: 0x33353838 });
    expect(planUpdateRegions(bytesSource(other), readUpdateImage(bytesSource(other)), null)).toEqual({ stop: 'This update.img is for RK3588, not RK3576.' });
    const loader = synthUpdateImg({ loaderChip: 0x33353838 });
    expect(planUpdateRegions(bytesSource(loader), readUpdateImage(bytesSource(loader)), null)).toMatchObject({ stop: expect.stringMatching(/loader .* RK3588/) });
    const big = synthUpdateImg({ bigBoot: true });
    expect(planUpdateRegions(bytesSource(big), readUpdateImage(bytesSource(big)), null)).toMatchObject({ stop: expect.stringMatching(/boot .* larger than its partition/) });
    const file = synthUpdateImg();
    expect(() => readUpdateImage(bytesSource(file.slice(0x66 + 4096)))).toThrow(/RKAF archive without its RKFW header/);
    expect(() => readUpdateImage(bytesSource(file.slice(0, 5000)))).toThrow(/incomplete/);
    expect(planUpdateRegions(bytesSource(file), readUpdateImage(bytesSource(file)), 1 << 20)).toMatchObject({ stop: expect.stringMatching(/the eMMC has/) });
  });
  it('is read from a file and its MD5 checked, a changed byte refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rkfw-'));
    const p = join(dir, 'update.img');
    writeFileSync(p, synthUpdateImg());
    expect(await checkUpdateMd5(p, inspectUpdateImage(p))).toBeNull();
    const bad = synthUpdateImg();
    bad[0x66 + 4096 + 2048 + 10] ^= 1;
    writeFileSync(p, bad);
    expect(await checkUpdateMd5(p, inspectUpdateImage(p))).toMatch(/does not match the MD5/);
    rmSync(dir, { recursive: true, force: true });
  });
  it('carries the MD5 the packer appended', () => {
    const file = synthUpdateImg();
    const img = readUpdateImage(bytesSource(file));
    expect(img.md5).toBe(createHash('md5').update(file.subarray(0, img.dataEnd)).digest('hex'));
  });
});

describe('the old backup partition table', () => {
  it('is the last 33 sectors, when the image ends before them and the size is known', () => {
    expect(backupGptLba(64 << 20, 1 << 20)).toBe((64 << 20) / 512 - BACKUP_GPT_SECTORS);
    expect(backupGptLba(64 << 20, 64 << 20)).toBeNull();
    expect(backupGptLba(null, 1 << 20)).toBeNull();
  });
});

const WASM_DIR = new URL('../vendor/rkdeveloptool-wasm/', import.meta.url);
const haveWasm = existsSync(new URL('rkdeveloptool.wasm', WASM_DIR));
const MiB = 1 << 20;

async function setup(board: FakeBoard) {
  Object.defineProperty(globalThis.navigator, 'usb', { value: board.usb(), configurable: true });
  const mod = await import(pathToFileURL(new URL('rkdeveloptool.js', WASM_DIR).pathname).href);
  return createRunner(mod.default, { log: () => {}, wasmBinary: readFileSync(new URL('rkdeveloptool.wasm', WASM_DIR)) });
}
const hooks = (stages: string[] = [], log: string[] = []): Hooks => ({
  stage: (s) => stages.push(s), progress: () => {}, log: (l) => log.push(l),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)), cancelled: () => false,
});

describe.skipIf(!haveWasm)('over Maskrom against a pretend board', () => {
  it('writes the regions at their sectors after the commands before them, and reads them back', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1 });
    const runner = await setup(board);
    const a = randomBytes(300 * 1024);
    const b = randomBytes(5000);
    const log: string[] = [];
    const res = await flashRegions(runner, {
      loader: syntheticLoader(), storageCode: 1, storageLabel: 'eMMC', checkHeadBytes: 32 * MiB, resetAfter: true, reconnectTimeout: 5000,
      plan: (capacity) => (capacity === 64 * MiB
        ? { regions: [{ lba: 0x4000, source: bytesSource(a), label: 'the uboot partition' }, { lba: 0x6800, source: bytesSource(b), label: 'the boot partition' }],
          before: [{ what: 'Asking for the storage size', files: [{ name: 'parameter.txt', data: new Uint8Array(8) }], args: () => ['rfi'] }] }
        : { stop: `unexpected capacity ${capacity}` }),
    }, hooks([], log));
    expect(res).toMatchObject({ ok: true, written: a.length + b.length, checks: { headBytes: a.length + b.length } });
    expect(log).toContain('$ rkdeveloptool rfi');
    expect(Buffer.from(board.contents(1, a.length, 0x4000 * 512)).equals(a)).toBe(true);
    expect(Buffer.from(board.contents(1, b.length, 0x6800 * 512)).equals(b)).toBe(true);
    expect(board.resets).toBe(1);
  });
  it('stops before writing when the plan says so', async () => {
    const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1 });
    const runner = await setup(board);
    const res = await flashRegions(runner, {
      loader: syntheticLoader(), storageCode: 1, storageLabel: 'eMMC', checkHeadBytes: 32 * MiB, resetAfter: false, reconnectTimeout: 5000,
      plan: () => ({ stop: 'This update.img is for RK3588, not RK3576.' }),
    }, hooks());
    expect(res).toMatchObject({ ok: false, reason: 'This update.img is for RK3588, not RK3576. Nothing was written.' });
    expect(board.log.filter((l) => l === 'cmd 0x15')).toEqual([]);
  });
  it('clears the old backup GPT after a whole image only when asked', async () => {
    for (const clear of [false, true]) {
      const board = new FakeBoard({ storages: { 1: 64 * MiB }, defaultStorage: 1 });
      const runner = await setup(board);
      // Something at the end of the storage, as an old GPT backup would be.
      await flash(runner, {
        loader: syntheticLoader(), storageCode: 1, storageLabel: 'eMMC', source: bytesSource(new Uint8Array(64 * MiB).fill(0x77)),
        expectedSha256: null, verify: false, resetAfter: false, reconnectTimeout: 5000,
      }, hooks());
      const image = randomBytes(MiB);
      const res = await flash(runner, {
        loader: syntheticLoader(), storageCode: 1, storageLabel: 'eMMC', source: bytesSource(image),
        expectedSha256: createHash('sha256').update(image).digest('hex'), verify: true, resetAfter: false, reconnectTimeout: 5000,
        clearBackupGpt: clear,
      }, hooks());
      expect(res).toMatchObject({ ok: true, verified: 'match', ...(clear ? { clearedBackupGpt: true } : {}) });
      const tail = board.contents(1, BACKUP_GPT_SECTORS * 512, 64 * MiB - BACKUP_GPT_SECTORS * 512);
      expect(tail.every((x) => x === (clear ? 0 : 0x77))).toBe(true);
      // Just before it: untouched either way.
      expect(board.contents(1, 512, 64 * MiB - (BACKUP_GPT_SECTORS + 1) * 512).every((x) => x === 0x77)).toBe(true);
    }
  });
});
