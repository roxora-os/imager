import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawSource, xzSource } from '../src/maskrom/file-source';
import { XzDecoder } from '../src/web/webflash/xz.js';

const wasm = new WebAssembly.Module(readFileSync(new URL('../resources/xzwasm/xzwasm.wasm', import.meta.url)));
const newDecoder = () => new XzDecoder(new WebAssembly.Instance(wasm, {}));

function makeXz(data: Buffer): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'xzsrc-'));
  try {
    writeFileSync(join(dir, 'a.img'), data);
    execFileSync('xz', ['-1', '-k', '--check=crc64', join(dir, 'a.img')]);
    return readFileSync(join(dir, 'a.img.xz'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('byte sources over a picked file', () => {
  // Compressible but not trivial: random blocks repeated.
  const block = randomBytes(256 * 1024);
  const data = Buffer.concat([...Array(23)].map((_, i) => (i % 3 ? block : randomBytes(256 * 1024))).concat([randomBytes(777)]));
  const xz = makeXz(data);
  const read = (p: number, n: number) => new Uint8Array(xz.buffer, xz.byteOffset + p, n);

  it('raw source returns the file', () => {
    const s = rawSource(data.length, (p, n) => data.subarray(p, p + n));
    expect(Buffer.from(s.read(1000, 10)).equals(data.subarray(1000, 1010))).toBe(true);
  });

  it('reads an .xz in order, in odd pieces', () => {
    const s = xzSource(xz.length, data.length, read, newDecoder);
    const out: Buffer[] = [];
    for (let p = 0; p < data.length; p += 300_001) out.push(Buffer.from(s.read(p, Math.min(300_001, data.length - p))));
    expect(Buffer.concat(out).equals(data)).toBe(true);
  });

  it('answers the header twice, then the whole file, then again from the start (read-back)', () => {
    const s = xzSource(xz.length, data.length, read, newDecoder);
    expect(Buffer.from(s.read(0, 4096)).equals(data.subarray(0, 4096))).toBe(true);
    expect(Buffer.from(s.read(0, 4096)).equals(data.subarray(0, 4096))).toBe(true);
    for (let pass = 0; pass < 2; pass++) {
      const out: Buffer[] = [];
      for (let p = 0; p < data.length; p += 512 * 1024) out.push(Buffer.from(s.read(p, Math.min(512 * 1024, data.length - p))));
      expect(Buffer.concat(out).equals(data), `pass ${pass}`).toBe(true);
    }
  });

  it('says so when the .xz is shorter than its size claims', () => {
    const s = xzSource(xz.length, data.length + 512, read, newDecoder);
    expect(() => s.read(data.length, 512)).toThrow(/less than its index says/);
  });
});
