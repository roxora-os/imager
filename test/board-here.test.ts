// The board this app runs on (main/board-here.ts) and the helper that
// writes it (helper/board-write.ts), against pretend boards: folders laid
// out like / with the files Linux has there.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardFromIds, MASKROM_BOARDS, maskromBoard, onBoardStorages } from '../src/maskrom/boards';
import { boardHere, boardRequestProblem, compatibleStrings } from '../src/main/board-here';
import { flashcpProgress, parseJob, runBoardJob, type BoardJob } from '../src/helper/board-write';
import type { HelperArgs, HelperMessage } from '../src/helper/write-helper';
import type { CatalogImage } from '../src/shared/catalog';

type Disk = { name: string; mounts?: string[] };
function lsblk(disks: Disk[]): string {
  return JSON.stringify({
    blockdevices: disks.map((d) => ({
      name: d.name, type: 'disk', rm: false, hotplug: false, tran: null, fstype: null, mountpoints: [null],
      children: [{ name: `${d.name}p1`, type: 'part', fstype: 'ext4', mountpoints: d.mounts?.length ? d.mounts : [null] }],
    })),
  });
}

/** A pretend board: `files` relative to the root. */
function pretend(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'board-'));
  for (const [p, v] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), v);
  }
  return root;
}

const CM5IO = {
  'proc/device-tree/compatible': 'armsom,cm5-io\0armsom,cm5\0rockchip,rk3576\0',
  'sys/block/mmcblk0/device/type': 'SD\n',
  'sys/block/mmcblk0/size': '124735488\n',
  'sys/block/mmcblk1/device/type': 'MMC\n',
  'sys/block/mmcblk1/device/name': 'A3A561\n',
  'sys/block/mmcblk1/size': '122142720\n',
};
const ROCK4D = {
  'proc/device-tree/compatible': 'radxa,rock-4d\0rockchip,rk3576\0',
  'sys/class/mtd/mtd0/type': 'nor\n',
  'sys/class/mtd/mtd0/name': 'sfc_nor\n',
  'sys/class/mtd/mtd0/size': '16777216\n',
  'sys/class/mtd/mtd1/type': 'nand\n',
  'sys/class/mtd/mtd1/size': '268435456\n',
};

const image = (board: string, o: Partial<CatalogImage> = {}): CatalogImage => ({
  id: `${board}-img`, board, boardName: maskromBoard(board)?.boardName ?? board, file: `roxora-${board}.img.xz`,
  size: 400e6, extractSize: 4e9, sample: false, ...o,
} as unknown as CatalogImage);

describe('which board this is', () => {
  it('by device tree compatible strings or SMBIOS product name', () => {
    expect(compatibleStrings('armsom,cm5-io\0armsom,cm5\0rockchip,rk3576\0')).toEqual(['armsom,cm5-io', 'armsom,cm5', 'rockchip,rk3576']);
    expect(boardFromIds(['armsom,cm5-io', 'armsom,cm5', 'rockchip,rk3576'], null)!.board).toBe('armsom-cm5-io');
    expect(boardFromIds(['rockchip,rk3576'], 'ROCK 4D')!.board).toBe('radxa-rock-4d');
    expect(boardFromIds(['rockchip,rk3576'], ' cm5-io\n')!.board).toBe('armsom-cm5-io');
    // The SoC alone names no board, nor does another board of the vendor.
    expect(boardFromIds(['rockchip,rk3576'], null)).toBeNull();
    expect(boardFromIds(['radxa,rock-5b', 'rockchip,rk3588'], 'ROCK 5B')).toBeNull();
  });

  it('writes only what the board list allows on the board', () => {
    expect(onBoardStorages(maskromBoard('armsom-cm5-io')!)).toEqual(['emmc']);
    // ROCK 4D: its SPI NOR flash takes the bootloader only, and no eMMC is listed.
    expect(onBoardStorages(maskromBoard('radxa-rock-4d')!)).toEqual(['spinor']);
    for (const b of MASKROM_BOARDS) expect(b.compatible.length + b.smbios.length).toBeGreaterThan(0);
  });
});

describe('what this board has', () => {
  it('finds the eMMC of a pretend CM5-IO by its card type, not the SD card', async () => {
    const root = pretend({ ...CM5IO, 'lsblk.json': lsblk([{ name: '/dev/mmcblk0', mounts: ['/'] }, { name: '/dev/mmcblk1' }]) });
    const h = await boardHere(root);
    expect(h.board!.board).toBe('armsom-cm5-io');
    expect(h.storages).toEqual(['emmc']);
    expect(h.emmc).toMatchObject({ device: '/dev/mmcblk1', bytes: 122142720 * 512, model: 'A3A561', mounts: [] });
    expect(h.emmcRefusal).toBeNull();
    expect(h.mtd).toEqual([]);
  });

  it('refuses the eMMC while anything on it is mounted', async () => {
    const root = pretend({ ...CM5IO, 'lsblk.json': lsblk([{ name: '/dev/mmcblk0' }, { name: '/dev/mmcblk1', mounts: ['/', '/boot'] }]) });
    const h = await boardHere(root);
    expect(h.emmc!.mounts.sort()).toEqual(['/', '/boot']);
    expect(h.emmcRefusal).toMatch(/^The eMMC is in use: .* are mounted from it\./);
  });

  it('says so when there is no eMMC', async () => {
    const { 'sys/block/mmcblk1/device/type': _t, ...noEmmc } = CM5IO;
    const h = await boardHere(pretend({ ...noEmmc, 'sys/block/mmcblk1/device/type': 'SD\n' }));
    expect(h.emmc).toBeNull();
    expect(h.emmcRefusal).toBe('Linux shows no eMMC on this board.');
  });

  it('finds the SPI NOR flash of a pretend ROCK 4D, and what is mounted from it', async () => {
    let h = await boardHere(pretend(ROCK4D));
    expect(h.board!.board).toBe('radxa-rock-4d');
    expect(h.mtd).toEqual([{ device: '/dev/mtd0', name: 'sfc_nor', bytes: 16777216, mounts: [] }]);
    expect(h.emmc).toBeNull();
    expect(h.emmcRefusal).toBeNull();
    h = await boardHere(pretend({ ...ROCK4D, 'proc/mounts': '/dev/mtdblock0 /mnt/spi jffs2 rw 0 0\n/dev/mmcblk0p1 / ext4 rw 0 0\n' }));
    expect(h.mtd[0].mounts).toEqual(['/mnt/spi']);
  });

  it('is no board of the list on another board or a PC', async () => {
    const h = await boardHere(pretend({ 'proc/device-tree/compatible': 'radxa,rock-5b\0rockchip,rk3588\0' }));
    expect(h.board).toBeNull();
    expect(h.compatible).toEqual(['radxa,rock-5b', 'rockchip,rk3588']);
    expect((await boardHere(pretend({ 'sys/class/dmi/id/product_name': 'ThinkPad X1\n' }))).board).toBeNull();
  });
});

describe('what may be written here', () => {
  it('only this board\'s image, to this board\'s storage, when it is free', async () => {
    const cm5 = await boardHere(pretend({ ...CM5IO, 'lsblk.json': lsblk([{ name: '/dev/mmcblk1' }]) }));
    const req = { kind: 'emmc' as const, imageId: 'x', device: '/dev/mmcblk1' };
    expect(boardRequestProblem(cm5, req, image('armsom-cm5-io'))).toBeNull();
    expect(boardRequestProblem(cm5, req, image('radxa-rock-4d'))).toMatch(/^This board is the ArmSoM CM5-IO, not the Radxa ROCK 4D\./);
    expect(boardRequestProblem(cm5, req, image('armsom-cm5-io', { sample: true }))).toMatch(/not from a published release/);
    expect(boardRequestProblem(cm5, req, image('armsom-cm5-io', { sample: true }), { pretend: true })).toBeNull();
    expect(boardRequestProblem(cm5, { ...req, device: '/dev/mmcblk0' }, image('armsom-cm5-io'))).toMatch(/is not this board's eMMC/);
    expect(boardRequestProblem(cm5, { ...req, kind: 'spinor', device: '/dev/mtd0' }, image('armsom-cm5-io'))).toMatch(/does not write the SPI NOR flash of the ArmSoM CM5-IO/);
    expect(boardRequestProblem(cm5, req, image('armsom-cm5-io', { extractSize: 1e12 }))).toMatch(/does not fit on the eMMC/);
    const busy = await boardHere(pretend({ ...CM5IO, 'lsblk.json': lsblk([{ name: '/dev/mmcblk1', mounts: ['/'] }]) }));
    expect(boardRequestProblem(busy, req, image('armsom-cm5-io'))).toMatch(/^The eMMC is in use/);

    const r4d = await boardHere(pretend(ROCK4D));
    const spi = { kind: 'spinor' as const, imageId: 'x', device: '/dev/mtd0' };
    const withSpi = image('radxa-rock-4d', { spi: { file: 'spi.img', size: 4 << 20, sha256: 'a'.repeat(64), url: '' } } as Partial<CatalogImage>);
    expect(boardRequestProblem(r4d, spi, withSpi)).toBeNull();
    expect(boardRequestProblem(r4d, spi, image('radxa-rock-4d'))).toMatch(/no SPI bootloader/);
    expect(boardRequestProblem(r4d, { ...spi, device: '/dev/mtd1' }, withSpi)).toMatch(/is not an SPI NOR flash on this board/);
    expect(boardRequestProblem(r4d, { ...spi, kind: 'emmc', device: '/dev/mmcblk0' }, withSpi)).toMatch(/does not write the eMMC of the Radxa ROCK 4D/);
  });
});

describe('the helper looks again', () => {
  const run = async (job: BoardJob, root: string) => {
    const sent: HelperMessage[] = [];
    const wrote: HelperArgs[] = [];
    await runBoardJob(job, (m) => sent.push(m), async (a, send) => { wrote.push(a); send({ type: 'done', ok: true, sha256: a.extractSha256 }); }, root);
    return { done: sent.find((m) => m.type === 'done') as Extract<HelperMessage, { type: 'done' }>, wrote };
  };
  const sha = 'b'.repeat(64);

  it('passes the eMMC of the board it is on to the SD writer as a built-in disk', async () => {
    const root = pretend({ ...CM5IO, 'lsblk.json': lsblk([{ name: '/dev/mmcblk1' }]) });
    const job: BoardJob = { kind: 'emmc', boardId: 'armsom-cm5-io', device: '/dev/mmcblk1', image: '/x.img.xz', extractSize: 4e9, extractSha256: sha };
    const { done, wrote } = await run(job, root);
    expect(done.ok).toBe(true);
    expect(wrote).toEqual([expect.objectContaining({ device: '/dev/mmcblk1', image: '/x.img.xz', allowInternal: true, allowLoop: false, extractSha256: sha })]);
  });

  it('writes nothing when the job names another board, another disk, or a disk in use', async () => {
    const free = pretend({ ...CM5IO, 'lsblk.json': lsblk([{ name: '/dev/mmcblk1' }]) });
    const job: BoardJob = { kind: 'emmc', boardId: 'armsom-cm5-io', device: '/dev/mmcblk1', image: '/x.img.xz', extractSize: 4e9, extractSha256: sha };
    for (const [j, root, re] of [
      [{ ...job, boardId: 'radxa-rock-4d' }, free, /not the ArmSoM|not the Radxa/],
      [{ ...job, device: '/dev/mmcblk0' }, free, /is not this board's eMMC/],
      [job, pretend({ ...CM5IO, 'lsblk.json': lsblk([{ name: '/dev/mmcblk1', mounts: ['/home'] }]) }), /^The eMMC is in use/],
      [job, pretend({ 'proc/device-tree/compatible': 'radxa,rock-5b\0rockchip,rk3588\0' }), /not a board the imager knows/],
    ] as Array<[BoardJob, string, RegExp]>) {
      const { done, wrote } = await run(j, root);
      expect(done.ok).toBe(false);
      expect(!done.ok && done.reason).toMatch(re);
      expect(!done.ok && done.reason).toMatch(/Nothing was written\.$/);
      expect(wrote).toEqual([]);
    }
  });

  it('checks the bootloader file and the flash before flashcp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spi-'));
    const file = join(dir, 'spi.img');
    const data = Buffer.alloc(1 << 20, 7);
    writeFileSync(file, data);
    const good = createHash('sha256').update(data).digest('hex');
    const job: BoardJob = { kind: 'spinor', boardId: 'radxa-rock-4d', device: '/dev/mtd0', image: file, size: data.length, sha256: sha };
    let r = await run(job, pretend(ROCK4D));
    expect(!r.done.ok && r.done.reason).toMatch(/^The bootloader file does not match the release\./);
    r = await run({ ...job, sha256: good }, pretend({ ...ROCK4D, 'proc/mounts': '/dev/mtdblock0 /mnt jffs2 rw 0 0\n' }));
    expect(!r.done.ok && r.done.reason).toMatch(/^\/dev\/mtd0 is in use: mounted at \/mnt\./);
    r = await run({ ...job, sha256: good, device: '/dev/mtd1' }, pretend(ROCK4D));
    expect(!r.done.ok && r.done.reason).toMatch(/is not an SPI NOR flash on this board/);
    const small = pretend({ ...ROCK4D, 'sys/class/mtd/mtd0/size': '65536\n' });
    r = await run({ ...job, sha256: good }, small);
    expect(!r.done.ok && r.done.reason).toMatch(/is larger than the SPI NOR flash \(65536 bytes\)/);
  });

  it('reads jobs strictly and follows flashcp', () => {
    const ok = { kind: 'emmc', boardId: 'armsom-cm5-io', device: '/dev/mmcblk1', image: '/x', extractSize: 1, extractSha256: sha };
    expect(parseJob(JSON.stringify(ok)).device).toBe('/dev/mmcblk1');
    expect(() => parseJob(JSON.stringify({ ...ok, device: '/dev/sda' }))).toThrow();
    expect(() => parseJob(JSON.stringify({ ...ok, kind: 'stage' }))).toThrow();
    expect(() => parseJob(JSON.stringify({ ...ok, extractSha256: 'x' }))).toThrow();
    expect(flashcpProgress('Erasing blocks: 8/16 (50%)')).toEqual({ stage: 'write', percent: 25 });
    expect(flashcpProgress('Erasing blocks: 16/16 (100%)\nWriting data: 2k/4k (50%)')).toEqual({ stage: 'write', percent: 75 });
    expect(flashcpProgress('Verifying data: 4k/4k (100%)')).toEqual({ stage: 'verify', percent: 100 });
    expect(flashcpProgress('nothing')).toBeNull();
  });
});
