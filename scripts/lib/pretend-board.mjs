// A pretend board for screenshots and tests: a folder laid out like / with
// the files main/board-here.ts reads on a real board, given to the app as
// ROXORA_IMAGER_FAKE_ROOT (unpackaged builds only; nothing is written while
// it is set).
//
//   compatible   device tree compatible strings (proc/device-tree/compatible)
//   smbios       SMBIOS product name (sys/class/dmi/id/product_name)
//   mmc          mmcblk devices: { name, type: 'MMC' | 'SD', model, bytes, mounts }
//                (sys/block/<name>/..., and lsblk.json with what is mounted)
//   mtd          MTD devices: { name, type: 'nor' | 'nand', label, bytes, mounted }
//                (sys/class/mtd/<name>/..., and proc/mounts for mtdblock)
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function pretendBoard({ compatible = [], smbios = null, mmc = [], mtd = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pretend-board-'));
  const put = (p, v) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), v); };
  if (compatible.length) put('proc/device-tree/compatible', `${compatible.join('\0')}\0`);
  if (smbios) put('sys/class/dmi/id/product_name', `${smbios}\n`);
  const mounts = [];
  for (const d of mmc) {
    put(`sys/block/${d.name}/device/type`, `${d.type}\n`);
    put(`sys/block/${d.name}/device/name`, `${d.model ?? ''}\n`);
    put(`sys/block/${d.name}/size`, `${Math.floor(d.bytes / 512)}\n`);
    for (const m of d.mounts ?? []) mounts.push(`/dev/${d.name}p1 ${m} ext4 rw 0 0`);
  }
  put('lsblk.json', JSON.stringify({
    blockdevices: mmc.map((d) => ({
      name: `/dev/${d.name}`, type: 'disk', rm: false, hotplug: d.type === 'SD', tran: null, fstype: null, mountpoints: [null],
      children: [{ name: `/dev/${d.name}p1`, type: 'part', fstype: 'ext4', mountpoints: d.mounts?.length ? d.mounts : [null] }],
    })),
  }));
  mtd.forEach((m) => {
    put(`sys/class/mtd/${m.name}/type`, `${m.type ?? 'nor'}\n`);
    put(`sys/class/mtd/${m.name}/name`, `${m.label ?? ''}\n`);
    put(`sys/class/mtd/${m.name}/size`, `${m.bytes}\n`);
    if (m.mounted) mounts.push(`/dev/${m.name.replace('mtd', 'mtdblock')} ${m.mounted} jffs2 rw 0 0`);
  });
  put('proc/mounts', mounts.length ? `${mounts.join('\n')}\n` : '');
  return root;
}

// The boards of src/maskrom/boards.ts as Linux shows them, running from an SD card.
const SD_CARD = { name: 'mmcblk0', type: 'SD', model: 'SD64G', bytes: 63864569856, mounts: ['/', '/boot'] };
export const PRETEND = {
  /** ArmSoM CM5-IO: an eMMC with nothing mounted. */
  cm5io: () => pretendBoard({
    compatible: ['armsom,cm5-io', 'armsom,cm5', 'rockchip,rk3576'],
    mmc: [SD_CARD, { name: 'mmcblk1', type: 'MMC', model: 'A3A561', bytes: 62537072640 }],
  }),
  /** ArmSoM CM5-IO running from its eMMC: the eMMC is not offered. */
  cm5ioFromEmmc: () => pretendBoard({
    compatible: ['armsom,cm5-io', 'armsom,cm5', 'rockchip,rk3576'],
    mmc: [{ name: 'mmcblk1', type: 'MMC', model: 'A3A561', bytes: 62537072640, mounts: ['/', '/boot'] }],
  }),
  /** Radxa ROCK 4D, found by its SMBIOS name as under UEFI with ACPI: 16 MiB SPI NOR flash. */
  rock4d: () => pretendBoard({
    compatible: [], smbios: 'ROCK 4D',
    mmc: [SD_CARD], mtd: [{ name: 'mtd0', type: 'nor', label: 'sfc_nor', bytes: 16 * 1024 * 1024 }],
  }),
  /** Radxa ROCK 4D whose kernel has no SPI flash driver: no MTD device. */
  rock4dNoMtd: () => pretendBoard({ compatible: ['radxa,rock-4d', 'rockchip,rk3576'], mmc: [SD_CARD] }),
};
