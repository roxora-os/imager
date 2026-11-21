// Is this app running on one of the boards, and what can it write there?
//
// On a board running Linux (a Roxora image or anything else started from an
// SD card or a USB drive) the app writes the board's own eMMC or SPI NOR
// flash directly, with no Maskrom and no second computer. This module only
// looks; the writing is the elevated helper's (helper/board-write.ts), which
// looks again before it writes.
//
// The board is recognised by its device tree compatible strings, or by the
// SMBIOS product name its UEFI firmware reports when Linux booted with ACPI
// (maskrom/boards.ts lists both per board). The eMMC is the mmcblk device
// whose card type in sysfs is "MMC" (an SD card says "SD"). The SPI NOR
// flash is an MTD device of type "nor", present only when the kernel has the
// SPI flash controller driver and the device tree enables the flash. Linux
// only. No Electron here: the helper uses it too.
//
// `root` is for tests and screenshots: a folder laid out like / with the
// files read here (proc/device-tree/compatible, sys/block/..., sys/class/mtd/...,
// proc/mounts) and, in place of running lsblk, lsblk.json holding what
// `lsblk` with LINUX_LSBLK_ARGS would print.

import { readdirSync, readFileSync } from 'node:fs';
import { boardFromIds, onBoardStorages, type MaskromBoard } from '../maskrom/boards';
import { linuxDiskFacts, type LinuxDiskFacts, type LsblkNode } from '../shared/targets';
import type { CatalogImage } from '../shared/catalog';
import type { BoardWriteRequest } from '../shared/ipc';
import { readLinuxDiskFacts } from './linux-disks';

export interface BoardDisk {
  device: string;
  bytes: number;
  model: string;
  /** Mount points on it (all partitions); anything here refuses the disk. */
  mounts: string[];
  /** Something else using it (LVM, RAID, ...), or null. */
  busy: string | null;
}

export interface BoardMtd {
  device: string;
  name: string;
  bytes: number;
  /** Where it is mounted (through mtdblock), if anywhere: then it is not written. */
  mounts: string[];
}

export interface BoardHere {
  /** The board, when one of maskrom/boards.ts is recognised. */
  board: MaskromBoard | null;
  compatible: string[];
  smbiosProduct: string | null;
  /** What the app may write on this board (maskrom/boards.ts, onBoardStorages). */
  storages: Array<'emmc' | 'spinor'>;
  emmc: BoardDisk | null;
  mtd: BoardMtd[];
  /** Why a write to the eMMC is refused, or null when it may be offered. */
  emmcRefusal: string | null;
}

const readText = (p: string): string | null => {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
};

export function compatibleStrings(raw: string | null): string[] {
  return raw ? raw.split('\0').map((s) => s.trim()).filter(Boolean) : [];
}

/** lsblk's view of the disks: the real one, or the lsblk.json of a pretend root (null when there is none). */
async function diskFacts(root: string): Promise<Record<string, LinuxDiskFacts> | null> {
  if (!root) return readLinuxDiskFacts();
  const raw = readText(`${root}/lsblk.json`);
  if (raw === null) return null;
  const tree = JSON.parse(raw) as { blockdevices?: LsblkNode[] };
  const mmcTypes: Record<string, string> = {};
  for (const d of tree.blockdevices ?? []) {
    const m = /^\/dev\/(mmcblk\d+)$/.exec(d.name);
    const type = m && readText(`${root}/sys/block/${m[1]}/device/type`);
    if (type) mmcTypes[d.name] = type;
  }
  return linuxDiskFacts(tree, mmcTypes);
}

/** The mount table: source device to mount points. */
function mountsBySource(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of (readText(`${root}/proc/mounts`) ?? '').split('\n')) {
    const [src, where] = line.split(' ');
    if (!src || !where) continue;
    out.set(src, [...(out.get(src) ?? []), where.replace(/\\040/g, ' ')]);
  }
  return out;
}

export async function boardHere(root = ''): Promise<BoardHere> {
  const none: BoardHere = { board: null, compatible: [], smbiosProduct: null, storages: [], emmc: null, mtd: [], emmcRefusal: null };
  if (process.platform !== 'linux' && !root) return none;
  const compatible = compatibleStrings(readText(`${root}/proc/device-tree/compatible`) ?? readText(`${root}/sys/firmware/devicetree/base/compatible`));
  const smbiosProduct = (readText(`${root}/sys/class/dmi/id/product_name`) ?? '').trim() || null;
  const board = boardFromIds(compatible, smbiosProduct);
  if (!board) return { ...none, compatible, smbiosProduct };
  const storages = onBoardStorages(board);

  let emmc: BoardDisk | null = null;
  let facts: Record<string, LinuxDiskFacts> | null = null;
  if (storages.includes('emmc')) {
    let names: string[] = [];
    try { names = readdirSync(`${root}/sys/block`); } catch { /* none */ }
    facts = await diskFacts(root);
    for (const n of names.sort()) {
      if (!/^mmcblk\d+$/.test(n)) continue;
      if ((readText(`${root}/sys/block/${n}/device/type`) ?? '').trim().toUpperCase() !== 'MMC') continue;
      const sectors = Number((readText(`${root}/sys/block/${n}/size`) ?? '0').trim());
      const device = `/dev/${n}`;
      const f = facts?.[device];
      emmc = {
        device, bytes: sectors * 512, model: (readText(`${root}/sys/block/${n}/device/name`) ?? '').trim() || 'eMMC',
        mounts: f?.allMounts ?? [], busy: f?.busy ?? null,
      };
      break;
    }
  }

  const mtd: BoardMtd[] = [];
  if (storages.includes('spinor')) {
    let mtds: string[] = [];
    try { mtds = readdirSync(`${root}/sys/class/mtd`); } catch { /* none */ }
    const mounts = mountsBySource(root);
    for (const n of mtds.sort()) {
      const m = /^mtd(\d+)$/.exec(n);
      if (!m) continue;
      if ((readText(`${root}/sys/class/mtd/${n}/type`) ?? '').trim() !== 'nor') continue;
      mtd.push({
        device: `/dev/${n}`, name: (readText(`${root}/sys/class/mtd/${n}/name`) ?? '').trim(),
        bytes: Number((readText(`${root}/sys/class/mtd/${n}/size`) ?? '0').trim()),
        mounts: [...(mounts.get(`/dev/${n}`) ?? []), ...(mounts.get(`/dev/mtdblock${m[1]}`) ?? [])],
      });
    }
  }

  let emmcRefusal: string | null = null;
  if (storages.includes('emmc')) {
    // Without lsblk's answer nothing says the eMMC is unused: not offered. A
    // pretend root without lsblk.json counts as nothing mounted.
    if (!emmc) emmcRefusal = 'Linux shows no eMMC on this board.';
    else if (!root && (!facts || Object.keys(facts).length === 0)) emmcRefusal = 'lsblk could not tell what is mounted, so the eMMC is not offered.';
    else if (emmc.mounts.length) emmcRefusal = `The eMMC is in use: ${emmc.mounts.join(', ')} ${emmc.mounts.length === 1 ? 'is' : 'are'} mounted from it. If this system runs from the eMMC, start it from an SD card or a USB drive instead; otherwise unmount it.`;
    else if (emmc.busy) emmcRefusal = `The eMMC is in use by ${emmc.busy}.`;
  }
  return { board, compatible, smbiosProduct, storages, emmc, mtd, emmcRefusal };
}

/**
 * Why a request to write this board must not go on, or null. The main
 * process asks before anything is downloaded; the helper looks again.
 */
export function boardRequestProblem(h: BoardHere, req: BoardWriteRequest, img: CatalogImage | undefined,
  o: { pretend?: boolean } = {}): string | null {
  const nothing = 'Nothing was written.';
  if (!h.board) return `This is not a board the imager knows. ${nothing}`;
  // A pretend board (screenshots, tests) takes the sample catalog: nothing is written there.
  if (!img || (img.sample && !o.pretend)) return 'This image is not from a published release and cannot be written.';
  if (img.board !== h.board.board) return `This board is the ${h.board.boardName}, not the ${img.boardName}. ${nothing}`;
  if (!h.storages.includes(req.kind)) {
    return `The imager does not write the ${req.kind === 'emmc' ? 'eMMC' : 'SPI NOR flash'} of the ${h.board.boardName}. ${nothing}`;
  }
  if (req.kind === 'emmc') {
    if (!h.emmc || h.emmc.device !== req.device) return `${req.device} is not this board's eMMC. ${nothing}`;
    if (h.emmcRefusal) return `${h.emmcRefusal} ${nothing}`;
    if (h.emmc.bytes < img.extractSize) return `The image (${img.extractSize} bytes) does not fit on the eMMC (${h.emmc.bytes} bytes). ${nothing}`;
    return null;
  }
  if (!img.spi) return 'This release has no SPI bootloader for the board.';
  const mtd = h.mtd.find((m) => m.device === req.device);
  if (!mtd) return `${req.device} is not an SPI NOR flash on this board. ${nothing}`;
  if (mtd.mounts.length) return `${req.device} is in use: mounted at ${mtd.mounts.join(', ')}. ${nothing}`;
  if (img.spi.size > mtd.bytes) return `The image (${img.spi.size} bytes) is larger than the SPI NOR flash (${mtd.bytes} bytes). ${nothing}`;
  return null;
}

/** What to do when the SPI NOR flash has no MTD device. */
export const NO_MTD_HELP = 'Linux shows no SPI NOR flash (no /dev/mtd device of type "nor"). The kernel needs the Rockchip SPI flash controller driver (CONFIG_SPI_ROCKCHIP_SFC, and CONFIG_MTD_SPI_NOR), and the device tree must enable the flash. Without it, write the SPI NOR over Maskrom from another computer.';
