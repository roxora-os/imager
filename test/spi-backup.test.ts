// The copy of the SPI NOR flash kept before a write over Maskrom (main/spi-backup.ts).
import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepSpiBackup, SPI_BACKUP_DIR, SPI_BACKUP_FILE, spiBackupProblem } from '../src/main/spi-backup';

const MiB = 1024 * 1024;

describe('the SPI NOR copy', () => {
  it('is kept in a folder of its own, with a note saying how to put it back', () => {
    const data = dataDir();
    const copy = new Uint8Array(randomBytes(16 * MiB));
    const r = keepSpiBackup(data, 'radxa-rock-4d', copy, new Date('2026-11-28T01:02:03.004Z'));
    expect(r).toEqual({ path: join(data, SPI_BACKUP_DIR, 'radxa-rock-4d-2026-11-28T01-02-03-004Z') });
    const dir = (r as { path: string }).path;
    expect(readdirSync(dir).sort()).toEqual(['backup.txt', SPI_BACKUP_FILE]);
    expect(readFileSync(join(dir, SPI_BACKUP_FILE)).equals(Buffer.from(copy))).toBe(true);
    const note = readFileSync(join(dir, 'backup.txt'), 'utf8');
    expect(note).toContain(createHash('sha256').update(copy).digest('hex'));
    expect(note).toContain('board: radxa-rock-4d');
    expect(note).toContain(`rkdeveloptool wl 0 ${SPI_BACKUP_FILE}`);
    rmSync(data, { recursive: true, force: true });
  });

  it('is refused for a board without SPI NOR flash, and for anything that is not a copy of one', () => {
    expect(spiBackupProblem('armsom-cm5-io', new Uint8Array(512))).toMatch(/no SPI NOR flash/);
    expect(spiBackupProblem('no-such-board', new Uint8Array(512))).toMatch(/no SPI NOR flash/);
    expect(spiBackupProblem('radxa-rock-4d', 'text')).toMatch(/Not a copy/);
    expect(spiBackupProblem('radxa-rock-4d', new Uint8Array(0))).toMatch(/Not a copy/);
    expect(spiBackupProblem('radxa-rock-4d', new Uint8Array(1000))).toMatch(/Not a copy/);
    expect(spiBackupProblem('radxa-rock-4d', new Uint8Array(32 * MiB + 512))).toMatch(/Not a copy/);
    expect(spiBackupProblem('radxa-rock-4d', new Uint8Array(32 * MiB))).toBeNull();
    const data = dataDir();
    expect(keepSpiBackup(data, '../x', new Uint8Array(512))).toEqual({ error: 'This board has no SPI NOR flash to keep a copy of.' });
    expect(readdirSync(data)).toEqual([]);
    rmSync(data, { recursive: true, force: true });
  });
});

function dataDir() {
  return mkdtempSync(join(tmpdir(), 'spi-backup-'));
}
