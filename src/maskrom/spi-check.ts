// What may go to SPI NOR flash from a file on this computer.
//
// SPI NOR holds a bootloader, a few MiB; a system image never fits. A wrong
// file used to be refused only after the board was connected and its flash
// size read (sequence.ts). These checks refuse it when it is chosen.

import { formatBytes } from '../shared/format';

/** Used when boards.ts does not state the board's SPI flash size. */
export const SPI_FLASH_FALLBACK = 32 * 1024 * 1024;

const SECTOR = 512;

/**
 * The size of the disk that the partition table at the start of an image
 * describes, from its first 1024 bytes: the end of the last MBR partition,
 * or the last usable sector of a GPT. 0 when there is no partition table
 * with partitions. Firmware images for SPI flash can carry a small GPT of
 * their own, so the table alone does not make a file a disk image; a table
 * that reaches past the flash does.
 */
export function partitionedSize(head: Uint8Array): number {
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let end = 0;
  if (head.length >= 2 * SECTOR && String.fromCharCode(...head.subarray(SECTOR, SECTOR + 8)) === 'EFI PART') {
    const lastUsable = Number(v.getBigUint64(SECTOR + 48, true));
    if (Number.isSafeInteger((lastUsable + 1) * SECTOR)) end = (lastUsable + 1) * SECTOR;
  }
  if (head.length >= SECTOR && head[510] === 0x55 && head[511] === 0xaa) {
    for (let i = 0; i < 4; i++) {
      const e = 446 + 16 * i;
      const type = head[e + 4];
      const sectors = v.getUint32(e + 12, true);
      // 0xee is the protective entry of a GPT, read above.
      if (type === 0 || type === 0xee || sectors === 0) continue;
      end = Math.max(end, (v.getUint32(e + 8, true) + sectors) * SECTOR);
    }
  }
  return end;
}

export interface SpiCandidate {
  name: string;
  /** Decompressed size where it is known, else the size of the file. */
  size: number;
  /** partitionedSize() of its start, where that could be read. */
  diskSize?: number;
}

export interface SpiRules {
  /** The board's SPI flash size, or the fallback. */
  flashSize: number;
  /** File names of the release images in the loaded catalog. */
  imageFiles: string[];
  /** The SPI bootloader of the chosen release, if it has one. */
  spiFile: string | null;
}

/** Why this file must not be written to SPI NOR flash, or null. */
export function spiFileProblem(f: SpiCandidate, r: SpiRules): string | null {
  const plain = f.name.replace(/\.(xz|gz|bz2)$/i, '');
  const releaseImage = r.imageFiles.some((n) => n === f.name || n.replace(/\.(xz|gz|bz2)$/i, '') === plain);
  if (releaseImage || (f.diskSize ?? 0) > r.flashSize) {
    return `${f.name} is a whole disk image, not a bootloader. SPI NOR flash holds only the bootloader`
      + (r.spiFile ? `: choose this release's SPI bootloader (${r.spiFile}) above` : '')
      + '. Write the disk image to an SD card instead.';
  }
  if (f.size > r.flashSize) {
    return `${f.name} is ${formatBytes(f.size)}, more than the board's SPI NOR flash holds (${formatBytes(r.flashSize)}). `
      + 'SPI NOR flash holds only the bootloader.';
  }
  return null;
}
