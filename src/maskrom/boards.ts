// What Maskrom can write on each board.
//
// Storage codes are rkdeveloptool's "cs" argument (1 = eMMC, 2 = SD,
// 9 = SPI NOR). Which storage each board has comes from edk2-webflash, which
// writes SPI NOR on ROCK 4D and eMMC on CM5-IO; nothing else is listed until
// it has been tried on the board.

export type StorageId = 'emmc' | 'spinor';

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
  spinor: { id: 'spinor', label: 'SPI NOR flash', code: 9, note: 'SPI NOR holds a bootloader only, a few MiB.' },
};

export interface MaskromBoard {
  board: string;
  boardName: string;
  soc: string;
  storages: StorageId[];
  /** Where a whole Roxora image goes, if anywhere. */
  imageStorage: StorageId | null;
  /** Shown when imageStorage is null. */
  imageNote?: string;
  /** Loader sent with "db"; a file in resources/. */
  loader: string;
}

export const MASKROM_BOARDS: MaskromBoard[] = [
  {
    board: 'armsom-cm5-io', boardName: 'ArmSoM CM5-IO', soc: 'rk3576',
    storages: ['emmc'], imageStorage: 'emmc', loader: 'rk3576_spl_loader.bin',
  },
  {
    board: 'radxa-rock-4d', boardName: 'Radxa ROCK 4D', soc: 'rk3576',
    storages: ['spinor'], imageStorage: null, loader: 'rk3576_spl_loader.bin',
    imageNote: 'ROCK 4D has SPI NOR flash, which is too small for a Roxora image. '
      + 'Write the image to an SD card. Maskrom can write a bootloader file to SPI NOR.',
  },
];

export function maskromBoard(board: string): MaskromBoard | undefined {
  return MASKROM_BOARDS.find((b) => b.board === board);
}
