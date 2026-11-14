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
}

export const MASKROM_BOARDS: MaskromBoard[] = [
  {
    board: 'armsom-cm5-io', boardName: 'ArmSoM CM5-IO', soc: 'rk3576',
    storages: ['emmc', 'sd'], imageStorage: 'emmc', wholeImage: ['emmc', 'sd'], loader: 'rk3576_spl_loader.bin',
  },
  {
    board: 'radxa-rock-4d', boardName: 'Radxa ROCK 4D', soc: 'rk3576',
    storages: ['spinor', 'sd'], imageStorage: null, wholeImage: ['sd'], loader: 'rk3576_spl_loader.bin',
    spiFlashSize: 16 * 1024 * 1024,
    imageNote: 'SPI NOR flash is too small for a Roxora image; it takes the bootloader. '
      + 'Choose the SD card in the board for the whole image.',
  },
];

export function maskromBoard(board: string): MaskromBoard | undefined {
  return MASKROM_BOARDS.find((b) => b.board === board);
}
