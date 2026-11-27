// The copy of a board's SPI NOR flash taken over Maskrom before it is
// written (maskrom/sequence.ts FlashPlan.spiNor), kept in a folder of its
// own under the app's data folder, with a note saying what it is and how
// to put it back. From Maskrom Studio's pre-write backup (b8a1e91, 0afaddd).
// Clear cache does not touch it. No Electron here, so the tests use it.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskromBoard } from '../maskrom/boards';

export const SPI_BACKUP_DIR = 'spi-backups';
export const SPI_BACKUP_FILE = 'spi-nor-before.bin';
/** Reads over Maskrom are trusted this far (sequence.ts TRUSTED_READ_BYTES): no copy is larger. */
const MAX_COPY = 32 * 1024 * 1024;

/** Why this copy must not be saved, or null. */
export function spiBackupProblem(board: unknown, data: unknown): string | null {
  const b = typeof board === 'string' ? maskromBoard(board) : undefined;
  if (!b || !b.storages.includes('spinor')) return 'This board has no SPI NOR flash to keep a copy of.';
  if (!(data instanceof Uint8Array) || data.length === 0 || data.length % 512 !== 0 || data.length > MAX_COPY) {
    return 'Not a copy of an SPI NOR flash.';
  }
  return null;
}

/** Save the copy under `dataDir`/spi-backups/<board>-<time>/; returns that folder. */
export function keepSpiBackup(dataDir: string, board: unknown, data: unknown, now = new Date()): { path: string } | { error: string } {
  const why = spiBackupProblem(board, data);
  if (why) return { error: why };
  const bytes = data as Uint8Array;
  try {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const dir = join(dataDir, SPI_BACKUP_DIR, `${board as string}-${stamp}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SPI_BACKUP_FILE), bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(dir, 'backup.txt'), [
      'Roxora Imager: what the SPI NOR flash held before a write over Maskrom.',
      `board: ${board as string}`,
      `taken: ${now.toISOString()}`,
      `${SPI_BACKUP_FILE}: ${bytes.length} bytes from sector 0, sha256 ${sha}`,
      `To put it back, write ${SPI_BACKUP_FILE} to the SPI NOR flash from sector 0: in Roxora Imager, Board storage over USB (Maskrom), SPI NOR flash, A file on this computer; or rkdeveloptool wl 0 ${SPI_BACKUP_FILE}.`,
      '',
    ].join('\n'));
    return { path: dir };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
}
