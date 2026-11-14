import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { exactly, macWrite, MISMATCH, outcomeOf, promptText, rawDevice, rawdiskArgs, RAWDISK_EXIT, type MacWriteOptions } from '../src/main/mac-write';
import type { DriveInfo } from '../src/shared/targets';

describe('macOS device names', () => {
  it('turns a whole disk into its raw device', () => {
    expect(rawDevice('/dev/disk4')).toBe('/dev/rdisk4');
    expect(rawDevice('/dev/disk12')).toBe('/dev/rdisk12');
  });
  it('refuses partitions and anything that is not a disk', () => {
    for (const d of ['/dev/disk4s1', '/dev/rdisk4', '/dev/sdb', 'disk4', '/dev/disk', '/dev/disk4 ', '/dev/disk4/../disk0', '/etc/passwd']) {
      expect(() => rawDevice(d)).toThrow();
    }
  });
  it('builds the helper arguments: raw device, size, prompt', () => {
    expect(rawdiskArgs('/dev/disk4', 1000, 'Generic STORAGE DEVICE'))
      .toEqual(['/dev/rdisk4', '1000', 'Roxora Imager will erase Generic STORAGE DEVICE (disk4) and write the image to it.']);
    expect(() => rawdiskArgs('/dev/disk4', 0, '')).toThrow();
    expect(() => rawdiskArgs('/dev/disk4', 1.5, '')).toThrow();
  });
  it('keeps the prompt short and plain whatever the drive calls itself', () => {
    expect(promptText('/dev/disk4', '')).toBe('Roxora Imager will erase disk4 and write the image to it.');
    const p = promptText('/dev/disk4', `Evil\n‮drive\0 ${'x'.repeat(200)}`);
    expect(p).toMatch(/^[\x20-\x7e]+$/);
    expect(p.length).toBeLessThan(130);
  });
});

describe('what the rawdisk helper ended with', () => {
  const expectd = { size: 10, sha256: 'a'.repeat(64) };
  const end = (code: number | null, more: Partial<Parameters<typeof outcomeOf>[0]> = {}) =>
    outcomeOf({ code, stderr: 'opened 512 100\nwritten\n', readBack: 10, sha256: 'a'.repeat(64), ...more }, expectd);
  it('accepts a read-back that matches the release', () => {
    expect(end(0)).toEqual({ type: 'done', ok: true, sha256: 'a'.repeat(64) });
  });
  it('reports a different or short read-back as a mismatch', () => {
    expect(end(0, { sha256: 'b'.repeat(64) })).toMatchObject({ ok: false, reason: MISMATCH });
    expect(end(0, { readBack: 9 })).toMatchObject({ ok: false, reason: MISMATCH, detail: 'read 9 bytes back, expected 10' });
  });
  it('says nothing was written when the right was refused or the disk not opened', () => {
    expect(end(RAWDISK_EXIT.auth, { stderr: 'authorization for x not granted (cancelled, status -60006)\n' }))
      .toEqual({ type: 'done', ok: false, reason: 'Administrator rights were not granted. Nothing was written.',
        detail: 'authorization for x not granted (cancelled, status -60006)' });
    expect(end(RAWDISK_EXIT.open).ok).toBe(false);
    expect((end(RAWDISK_EXIT.open) as { reason: string }).reason).toMatch(/Nothing was written/);
    expect((end(RAWDISK_EXIT.small) as { reason: string }).reason).toMatch(/smaller than the image/);
  });
  it('passes on write and read errors without the progress lines', () => {
    expect(end(RAWDISK_EXIT.write, { stderr: 'opened 512 100\nwrite at byte 512: Input/output error\n' }))
      .toEqual({ type: 'done', ok: false, reason: 'Writing failed.', detail: 'write at byte 512: Input/output error' });
    expect((end(RAWDISK_EXIT.read) as { reason: string }).reason).toMatch(/could not be read back/);
    expect(end(RAWDISK_EXIT.input, { feedError: 'xz: corrupt' })).toMatchObject({ reason: 'Writing stopped with an error.' });
    expect(end(null)).toMatchObject({ ok: false, reason: 'The writer stopped without saying why.' });
  });
});

describe('the image stream', () => {
  const run = async (data: Buffer, size: number) => {
    const out: Buffer[] = [];
    const seen: number[] = [];
    await pipeline(Readable.from([data.subarray(0, 3), data.subarray(3)]), exactly(size, (n) => seen.push(n)),
      async (src: AsyncIterable<Buffer>) => { for await (const c of src) out.push(c); });
    return { out: Buffer.concat(out), seen };
  };
  it('passes exactly the stated number of bytes and counts them', async () => {
    const r = await run(Buffer.from('0123456789'), 10);
    expect(r.out.toString()).toBe('0123456789');
    expect(r.seen).toEqual([3, 10]);
  });
  it('fails on an image longer or shorter than the release states', async () => {
    await expect(run(Buffer.from('0123456789'), 9)).rejects.toThrow(/more than the 9 bytes/);
    await expect(run(Buffer.from('0123456789'), 11)).rejects.toThrow(/ended after 10 of 11/);
  });
});

// A stand-in for roxora-imager-rawdisk with the same arguments, streams and
// exit statuses; its "disk" is a file.
const work = mkdtempSync(join(tmpdir(), 'mac-write-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const fake = join(work, 'fake-rawdisk');
writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const [raw, sizeArg] = process.argv.slice(2);
const size = Number(sizeArg);
const mode = process.env.FAKE_RAWDISK || '';
fs.writeFileSync(process.env.FAKE_DISK + '.args', JSON.stringify(process.argv.slice(2)));
if (mode === 'deny') { console.error('authorization for sys.openfile.readwrite.' + raw + ' not granted (cancelled, status -60006)'); process.exit(3); }
if (mode === 'dialog') { setInterval(() => {}, 1000); return; }
process.stderr.write('opened 512 1000000\\n');
if (mode === 'stall') { setInterval(() => {}, 1000); return; }
const chunks = []; let got = 0;
process.stdin.on('data', (c) => { chunks.push(c); got += c.length; });
process.stdin.on('end', () => {
  if (got < size) { console.error('the image data ended after ' + got + ' of ' + size + ' bytes'); process.exit(7); }
  process.stderr.write('written\\n');
  const data = Buffer.concat(chunks);
  fs.writeFileSync(process.env.FAKE_DISK, data);
  if (mode === 'corrupt') data[5] ^= 1;
  process.stdout.write(data, () => process.exit(0));
});
`);
chmodSync(fake, 0o755);
const disk = join(work, 'disk.bin');
process.env.FAKE_DISK = disk;

const data = randomBytes(3 * 1024 * 1024 + 517);
const sha = createHash('sha256').update(data).digest('hex');
const drive = (over: Partial<DriveInfo> = {}): DriveInfo => ({
  device: '/dev/disk4', description: 'Generic STORAGE DEVICE', size: 32e9, mountpoints: [], isReadOnly: false,
  isSystem: false, isVirtual: false, isRemovable: true, isCard: true, isUSB: true, ...over,
});

async function write(mode: string, over: Partial<MacWriteOptions> = {}) {
  process.env.FAKE_RAWDISK = mode;
  rmSync(disk, { force: true });
  rmSync(`${disk}.args`, { force: true });
  const progress: string[] = [];
  const unmounted: string[] = [];
  const out = await macWrite({
    image: 'unused', device: '/dev/disk4', extractSize: data.length, extractSha256: sha, helperPath: fake,
    onProgress: (p) => { if (!progress.includes(p.stage)) progress.push(p.stage); },
    drives: async () => [drive()],
    unmount: async (d) => { unmounted.push(d); },
    open: async () => ({ stream: Readable.from((function* () { for (let i = 0; i < data.length; i += 65536) yield data.subarray(i, i + 65536); })()), close: async () => {} }),
    ...over,
  });
  let started: string[] | null = null;
  try { started = JSON.parse(readFileSync(`${disk}.args`, 'utf8')); } catch { /* the helper was not started */ }
  return { out, progress, unmounted, started };
}

describe('writing through the rawdisk helper', () => {
  it('unmounts, writes, reads back and compares with the release', async () => {
    const r = await write('');
    expect(r.out).toEqual({ type: 'done', ok: true, sha256: sha });
    expect(r.unmounted).toEqual(['/dev/disk4']);
    expect(r.started).toEqual(['/dev/rdisk4', String(data.length), 'Roxora Imager will erase Generic STORAGE DEVICE (disk4) and write the image to it.']);
    expect(r.progress).toEqual(['write', 'verify']);
    expect(Buffer.compare(readFileSync(disk), data)).toBe(0);
  });
  it('reports a drive that reads back something else', async () => {
    const r = await write('corrupt');
    expect(r.out).toMatchObject({ ok: false, reason: MISMATCH });
  });
  it('reports the release checksum not matching', async () => {
    const r = await write('', { extractSha256: '0'.repeat(64) });
    expect(r.out).toMatchObject({ ok: false, reason: MISMATCH });
  });
  it('never starts the helper for a system disk, a small disk or a missing one', async () => {
    for (const drives of [[drive({ isSystem: true })], [drive({ mountpoints: [{ path: '/' }] })], [drive({ size: 1024 })],
      [drive({ isVirtual: true })], [drive({ device: '/dev/disk9' })]]) {
      const r = await write('', { drives: async () => drives });
      expect(r.out.ok).toBe(false);
      expect((r.out as { reason: string }).reason).toMatch(/not a drive the imager writes to|no longer connected/);
      expect(r.started).toBeNull();
      expect(r.unmounted).toEqual([]);
    }
  });
  it('writes nothing when the volumes cannot be unmounted', async () => {
    const r = await write('', { unmount: async () => { throw new Error('disk4 is in use'); } });
    expect(r.out).toMatchObject({ ok: false, detail: 'disk4 is in use' });
    expect((r.out as { reason: string }).reason).toMatch(/Nothing was written/);
    expect(r.started).toBeNull();
  });
  it('says so when the password dialog was dismissed', async () => {
    const r = await write('deny');
    expect(r.out).toMatchObject({ ok: false, reason: 'Administrator rights were not granted. Nothing was written.' });
    expect(r.progress).toEqual([]);
  });
  it('cancels while the password dialog is open: nothing written', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await write('dialog', { signal: ac.signal });
    expect(r.out).toEqual({ type: 'done', ok: false, reason: 'Cancelled. Nothing was written.' });
  });
  it('cancels during the write: the drive is partly written', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await write('stall', { signal: ac.signal });
    expect(r.out).toEqual({ type: 'done', ok: false, reason: 'Cancelled. The drive is only partly written.' });
  });
  it('stops when the image is not the size the release states', async () => {
    const r = await write('', { extractSize: data.length + 1 });
    expect(r.out).toMatchObject({ ok: false, reason: 'Writing stopped with an error.' });
    expect((r.out as { detail: string }).detail).toMatch(/ended after/);
  });
  it('says the writer could not be started when the helper is missing', async () => {
    const r = await write('', { helperPath: join(work, 'missing') });
    expect(r.out).toMatchObject({ ok: false, reason: 'The writer could not be started.' });
  });
});
