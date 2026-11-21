// What Maskrom can write on each board.
//
// Storage codes are rkdeveloptool's "cs" argument; its usage text in
// main.cpp reads "ChangeStorage: cs [storage: 1=EMMC, 2=SD, 9=SPINOR]".
// eMMC on CM5-IO and SPI NOR on ROCK 4D are what edk2-webflash writes and
// has used on the boards. The SD card in the board (cs 2) has not been tried
// on RK3576 yet: the write stops before anything is written when the loader
// does not switch to it (sequence.ts reads the storage back).

export type StorageId = 'emmc' | 'sd' | 'spinor';

export interface Storage {
  id: StorageId;
  label: string;
  /** rkdeveloptool "cs" code. */
  code: number;
  /** What a whole Roxora image on this storage means for the board. */
  note: string;
}

export const STORAGES: Record<StorageId, Storage> = {
  emmc: { id: 'emmc', label: 'eMMC', code: 1, note: 'The board boots Roxora from eMMC.' },
  sd: {
    id: 'sd', label: 'SD card in the board', code: 2,
    note: 'Writes the card in the board\'s own slot. Not yet tested on RK3576; nothing is written if the board cannot switch to its card.',
  },
  spinor: { id: 'spinor', label: 'SPI NOR flash', code: 9, note: 'SPI NOR holds a bootloader only, a few MiB.' },
};

export interface MaskromBoard {
  board: string;
  boardName: string;
  soc: string;
  storages: StorageId[];
  /** Where a whole Roxora image goes by default, if anywhere. */
  imageStorage: StorageId | null;
  /** Every storage a whole Roxora image may go to. */
  wholeImage: StorageId[];
  /** Shown when imageStorage is null. */
  imageNote?: string;
  /** Loader sent with "db"; a file in resources/. */
  loader: string;
  /** Size of the board's SPI NOR flash in bytes, where it has one and the size is known. */
  spiFlashSize?: number;
  /**
   * How Linux running on the board names it (main/board-here.ts): device
   * tree compatible strings, any one of which identifies the board, and the
   * SMBIOS product names its UEFI firmware reports (edk2-rk3576), for a
   * system booted with ACPI.
   */
  compatible: string[];
  smbios: string[];
}

export const MASKROM_BOARDS: MaskromBoard[] = [
  {
    board: 'armsom-cm5-io', boardName: 'ArmSoM CM5-IO', soc: 'rk3576',
    storages: ['emmc', 'sd'], imageStorage: 'emmc', wholeImage: ['emmc', 'sd'], loader: 'rk3576_spl_loader.bin',
    compatible: ['armsom,cm5-io'], smbios: ['CM5-IO'],
  },
  {
    board: 'radxa-rock-4d', boardName: 'Radxa ROCK 4D', soc: 'rk3576',
    storages: ['spinor', 'sd'], imageStorage: null, wholeImage: ['sd'], loader: 'rk3576_spl_loader.bin',
    spiFlashSize: 16 * 1024 * 1024,
    imageNote: 'SPI NOR flash is too small for a Roxora image; it takes the bootloader. '
      + 'Choose the SD card in the board for the whole image.',
    compatible: ['radxa,rock-4d'], smbios: ['ROCK 4D'],
  },
];

export function maskromBoard(board: string): MaskromBoard | undefined {
  return MASKROM_BOARDS.find((b) => b.board === board);
}

/** The board a device tree compatible list or an SMBIOS product name names, if any. */
export function boardFromIds(compatible: string[], smbiosProduct: string | null): MaskromBoard | null {
  for (const b of MASKROM_BOARDS) {
    if (compatible.some((c) => b.compatible.includes(c))) return b;
  }
  const p = smbiosProduct?.trim().toLowerCase();
  if (p) for (const b of MASKROM_BOARDS) if (b.smbios.some((s) => s.toLowerCase() === p)) return b;
  return null;
}

/**
 * What the app may write on the board it runs on: the eMMC where a whole
 * image may go to it, and the SPI NOR flash (a bootloader) where the board
 * has one. The SD card in the board's slot is not among them: it is what
 * such a system usually runs from, and as a drive it is written like any other.
 */
export function onBoardStorages(b: MaskromBoard): Array<'emmc' | 'spinor'> {
  const out: Array<'emmc' | 'spinor'> = [];
  if (b.storages.includes('emmc') && b.wholeImage.includes('emmc')) out.push('emmc');
  if (b.storages.includes('spinor')) out.push('spinor');
  return out;
}
