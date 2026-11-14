import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sourceDestination from 'etcher-sdk/build/source-destination';
import { guardReadsAfterClose } from '../src/helper/read-guard';

function imageFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'read-guard-')), 'image.xz');
  writeFileSync(path, Buffer.alloc(1 << 20, 7));
  return path;
}

describe('reads after the image file is closed', () => {
  it('fail with EBADF in etcher-sdk, as in the macOS writer crash', async () => {
    const file = new sourceDestination.File({ path: imageFile() });
    await file.open();
    await file.close();
    await expect(file.read(Buffer.alloc(16), 0, 16, 0)).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('read as end of file once guarded', async () => {
    const file = new sourceDestination.File({ path: imageFile() });
    guardReadsAfterClose(file);
    await file.open();
    const open = await file.read(Buffer.alloc(16), 0, 16, 0);
    expect(open.bytesRead).toBe(16);
    await file.close();
    const after = await file.read(Buffer.alloc(16), 0, 16, 0);
    expect(after.bytesRead).toBe(0);
  });

  it('end a read stream cleanly when the file closes under it', async () => {
    const file = new sourceDestination.File({ path: imageFile() });
    guardReadsAfterClose(file);
    const stream = await file.createReadStream();
    const errors: unknown[] = [];
    stream.on('error', (e) => errors.push(e));
    await new Promise<void>((resolve) => stream.once('data', () => resolve()));
    stream.pause();
    await file.close();
    stream.resume();
    await new Promise<void>((resolve) => { stream.on('end', resolve); stream.on('close', resolve); });
    expect(errors).toEqual([]);
  });
});
