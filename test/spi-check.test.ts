import { describe, expect, it } from 'vitest';
import { maskromBoard } from '../src/maskrom/boards';
import { partitionedSize, SPI_FLASH_FALLBACK, spiFileProblem } from '../src/maskrom/spi-check';

const MIB = 1024 * 1024;

function mbr(parts: { type: number; start: number; sectors: number }[]): Uint8Array {
  const b = new Uint8Array(1024);
  const v = new DataView(b.buffer);
  parts.forEach((p, i) => {
    b[446 + 16 * i + 4] = p.type;
    v.setUint32(446 + 16 * i + 8, p.start, true);
    v.setUint32(446 + 16 * i + 12, p.sectors, true);
  });
  b[510] = 0x55;
  b[511] = 0xaa;
  return b;
}
function gpt(lastUsableLba: number): Uint8Array {
  const b = mbr([{ type: 0xee, start: 1, sectors: 0xffffffff }]);
  b.set(new TextEncoder().encode('EFI PART'), 512);
  new DataView(b.buffer).setBigUint64(512 + 48, BigInt(lastUsableLba), true);
  return b;
}

describe('the disk a partition table describes', () => {
  it('is nothing for a bootloader without a table', () => {
    expect(partitionedSize(new Uint8Array(1024))).toBe(0);
    expect(partitionedSize(new Uint8Array(100))).toBe(0);
    // The signature alone, with empty entries.
    expect(partitionedSize(mbr([]))).toBe(0);
  });
  it('is the end of the last MBR partition', () => {
    expect(partitionedSize(mbr([{ type: 0x0c, start: 2048, sectors: 4096 }, { type: 0x83, start: 8192, sectors: 1000000 }])))
      .toBe((8192 + 1000000) * 512);
  });
  it('is the last usable sector of a GPT, not the protective entry', () => {
    expect(partitionedSize(gpt(8388574))).toBe(8388575 * 512);
  });
});

describe('a file for SPI NOR flash', () => {
  const rules = { flashSize: 16 * MIB, imageFiles: ['roxora-radxa-rock-4d-noble-edge-2026.11.3.img.xz'], spiFile: 'roxora-radxa-rock-4d-noble-edge-2026.11.3-spi.img' };
  it('knows the ROCK 4D has 16 MiB and falls back to 32 MiB', () => {
    expect(maskromBoard('radxa-rock-4d')?.spiFlashSize).toBe(16 * MIB);
    expect(SPI_FLASH_FALLBACK).toBe(32 * MIB);
  });
  it('accepts a bootloader that fits', () => {
    expect(spiFileProblem({ name: 'u-boot-rockchip-spi.bin', size: 4 * MIB, diskSize: 0 }, rules)).toBeNull();
    expect(spiFileProblem({ name: 'exactly.img', size: 16 * MIB }, rules)).toBeNull();
    // Firmware with a small partition table of its own, inside the flash.
    expect(spiFileProblem({ name: 'RK3576_NOR_FLASH.img', size: 8 * MIB, diskSize: 8 * MIB }, rules)).toBeNull();
  });
  it('refuses a file larger than the flash, saying what SPI flash is for', () => {
    const p = spiFileProblem({ name: 'big.bin', size: 16 * MIB + 1, diskSize: 0 }, rules);
    expect(p).toMatch(/big\.bin is 16\.0 MiB, more than the board's SPI NOR flash holds \(16\.0 MiB\)/);
    expect(p).toMatch(/holds only the bootloader/);
    expect(spiFileProblem({ name: 'big.bin', size: 20 * MIB }, { ...rules, flashSize: SPI_FLASH_FALLBACK })).toBeNull();
  });
  it('refuses a release disk image by name, compressed or not, pointing at the SPI bootloader and the SD card', () => {
    for (const name of ['roxora-radxa-rock-4d-noble-edge-2026.11.3.img.xz', 'roxora-radxa-rock-4d-noble-edge-2026.11.3.img']) {
      const p = spiFileProblem({ name, size: 1 * MIB }, rules);
      expect(p).toMatch(/whole disk image, not a bootloader/);
      expect(p).toContain("this release's SPI bootloader (roxora-radxa-rock-4d-noble-edge-2026.11.3-spi.img)");
      expect(p).toMatch(/SD card instead/);
    }
    // The SPI image of the release itself is not a disk image.
    expect(spiFileProblem({ name: 'roxora-radxa-rock-4d-noble-edge-2026.11.3-spi.img', size: 8 * MIB, diskSize: 0 }, rules)).toBeNull();
  });
  it('refuses a disk image by its partition table even when the file is small', () => {
    const p = spiFileProblem({ name: 'other.img', size: 2 * MIB, diskSize: 4096 * MIB }, { ...rules, spiFile: null });
    expect(p).toMatch(/whole disk image/);
    expect(p).not.toMatch(/this release's SPI bootloader/);
  });
});
