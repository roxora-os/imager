// A read on the image file that arrives after the file was closed.
//
// etcher-sdk closes the image file as soon as the decompressed data has
// ended, while its BlockReadStream can still have a read ahead pending on the
// compressed file. That read then fails with EBADF ("file closed") on a
// stream nobody listens to any more, and the error ends the writer before it
// reads the drive back. Seen on macOS writing an SD card with 0.1.1.
//
// guardReadsAfterClose() makes such a read return end of file instead. A read
// that fails while the file is still open fails as before, and the read-back
// against the release SHA-256 would catch anything that went missing.

export interface ClosableReader<R> {
  read(buffer: Buffer, bufferOffset: number, length: number, sourceOffset: number): Promise<R>;
  close(): Promise<void>;
}

export function guardReadsAfterClose<R>(file: ClosableReader<R>): void {
  let closed = false;
  const close = file.close.bind(file);
  const read = file.read.bind(file);
  file.close = async () => {
    closed = true;
    await close();
  };
  file.read = async (buffer, bufferOffset, length, sourceOffset) => {
    try {
      return await read(buffer, bufferOffset, length, sourceOffset);
    } catch (e) {
      if (closed && (e as NodeJS.ErrnoException)?.code === 'EBADF') {
        return { bytesRead: 0, buffer } as unknown as R;
      }
      throw e;
    }
  };
}
