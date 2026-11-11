import { describe, expect, it } from 'vitest';
import { blobPaths, LoaderMergeError, parseIni, rc4, rc4Sectors, rkcrc32 } from '../src/maskrom/loader-merge';
import { buildLoader, LOADERS } from '../src/maskrom/loaders';
import { SYNTHETIC_INI, syntheticLoader } from './synthetic-loader';

describe('loader merge', () => {
  it("uses Rockchip's CRC-32, not zlib's", () => {
    expect(rkcrc32(new Uint8Array([1]))).toBe(0x04c10db7);
    expect(rkcrc32(new TextEncoder().encode('123456789'))).toBe(0x889a9615); // as rkfw.rkcrc32 in RKDevelopTool-GUI
  });
  it('RC4 is its own inverse, whole and per sector', () => {
    const d = new Uint8Array(1500).map((_, i) => i & 0xff);
    expect(rc4(rc4(d))).toEqual(d);
    expect(rc4Sectors(rc4Sectors(d))).toEqual(d);
    expect(rc4Sectors(d).subarray(512, 1024)).toEqual(rc4(d.subarray(512, 1024)));
  });
  it('reads an RKBOOT ini', () => {
    const o = parseIni(SYNTHETIC_INI);
    expect(o.chip).toBe('RK3576');
    expect(o.align).toBe(4096);
    expect(o.rc4On471).toBe(false);
    expect(blobPaths(o)).toEqual(['bin/ddr_test.bin', 'bin/usbplug_test.bin', 'bin/boost_test.bin', 'bin/spl_test.bin']);
    expect(o.words[2]).toBe(0x100);
  });
  it('refuses old-format loaders and incomplete inis', () => {
    expect(() => parseIni(SYNTHETIC_INI.replace('NEWIDB=true', 'NEWIDB=false'))).toThrow(LoaderMergeError);
    expect(() => parseIni(SYNTHETIC_INI.replace('[CHIP_NAME]\nNAME=RK3576\n', ''))).toThrow(LoaderMergeError);
  });
  it('builds an LDR loader whose last four bytes are the CRC of the rest', () => {
    const l = syntheticLoader();
    expect(new TextDecoder().decode(l.subarray(0, 4))).toBe('LDR ');
    const v = new DataView(l.buffer, l.byteOffset);
    expect(v.getUint32(l.length - 4, true)).toBe(rkcrc32(l.subarray(0, l.length - 4)));
    // One 471 entry plus UsbHead, one 472, FlashHead plus three loaders.
    expect([l[25], l[31], l[37]]).toEqual([2, 1, 4]);
  });
});

describe('loader pins', () => {
  const pin = LOADERS['rk3576_spl_loader.bin'];
  it('pins every piece to one rkbin commit', () => {
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(pin.files)).toContain(pin.ini);
    for (const h of [...Object.values(pin.files), pin.sha256]) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('fails in one sentence when offline', async () => {
    await expect(buildLoader(pin, () => Promise.reject(new TypeError('fetch failed'))))
      .rejects.toThrow("Could not download Rockchip's loader from raw.githubusercontent.com. Check the internet connection and try again.");
  });
  it('refuses a piece that does not match its pin', async () => {
    await expect(buildLoader(pin, async () => new Response('not the ini')))
      .rejects.toThrow('does not match its pinned checksum');
  });
});
