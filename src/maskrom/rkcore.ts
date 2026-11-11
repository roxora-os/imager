// rkdeveloptool compiled to WebAssembly, with files that stream.
//
// The WASM build, its libusb WebUSB backend and the way it is driven come
// from edk2-webflash (src/worker.js there). What is new here is how files
// reach it: edk2-webflash mounts a browser File with WORKERFS; the imager
// writes images it downloaded and decompressed itself, and reads the storage
// back to check it, so both directions go through character devices:
//
//   source device  a file rkdeveloptool reads ("wl 0 /dev/rx-src-1"); every
//                  read is answered by a synchronous callback, so a multi-GB
//                  image is never held in memory.
//   sink device    a file rkdeveloptool writes ("rl 0 N /dev/rx-sink-1");
//                  every write goes to a callback (the imager hashes it).
//
// Nothing in this file touches the DOM or Node: the worker and the tests both
// use it.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ByteSource {
  size: number;
  /** Return exactly `length` bytes from `position` (the caller never asks past the end). */
  read(position: number, length: number): Uint8Array;
}

export interface ByteSink {
  write(chunk: Uint8Array): void;
}

export interface RkModuleOptions {
  print: (line: string) => void;
  printErr: (line: string) => void;
  locateFile?: (path: string) => string;
  wasmBinary?: Uint8Array;
}

export type RkFactory = (opts: Record<string, unknown>) => Promise<any>;

const EINVAL = 28;
const EBADF = 8;

export class RkTool {
  private mod: any;
  private nextMinor = 1;
  private readonly major = 64;

  private constructor(mod: any) {
    this.mod = mod;
  }

  static async create(factory: RkFactory, opts: RkModuleOptions): Promise<RkTool> {
    let last = '';
    const mod = await factory({
      noInitialRun: true,
      ...(opts.locateFile ? { locateFile: opts.locateFile } : {}),
      ...(opts.wasmBinary ? { wasmBinary: opts.wasmBinary } : {}),
      print: (text: string) => {
        if (!text) return;
        // The progress line is reprinted for every block; pass on changes only.
        if (/(Write|Read) LBA (from|to) file/.test(text)) {
          if (text === last) return;
          last = text;
        }
        opts.print(text);
      },
      printErr: (text: string) => { if (text) opts.printErr(text); },
    });
    const tool = new RkTool(mod);
    tool.setupFs();
    return tool;
  }

  /** The layout rkdeveloptool expects: it looks for ./config.ini and ./log/ (see edk2-webflash). */
  private setupFs(): void {
    const FS = this.mod.FS;
    const mkdir = (p: string) => { try { FS.mkdir(p); } catch { /* exists */ } };
    mkdir('/tmp');
    try { FS.mount(FS.filesystems.MEMFS, {}, '/tmp'); } catch { /* mounted */ }
    mkdir('/tmp/log');
    FS.writeFile('/tmp/config.ini', '');
    FS.chdir('/tmp');
  }

  /** Put a small file (the loader) into the in-memory file system. */
  writeFile(name: string, data: Uint8Array): string {
    const path = `/tmp/${name}`;
    this.mod.FS.writeFile(path, data);
    return path;
  }

  private makeDevice(prefix: string, ops: Record<string, unknown>): string {
    const FS = this.mod.FS;
    const minor = this.nextMinor++;
    const dev = FS.makedev(this.major, minor);
    FS.registerDevice(dev, ops);
    const path = `/dev/${prefix}-${minor}`;
    FS.mkdev(path, 0o666, dev);
    return path;
  }

  /** A read-only file backed by `src`. Returns its path. */
  mountSource(src: ByteSource): string {
    const FS = this.mod.FS;
    return this.makeDevice('rx-src', {
      open(stream: any) { stream.seekable = true; },
      close() {},
      read(_stream: any, buffer: Int8Array | Uint8Array, offset: number, length: number, position: number) {
        const n = Math.min(length, src.size - position);
        if (n <= 0) return 0;
        const bytes = src.read(position, n);
        if (bytes.length !== n) throw new FS.ErrnoError(EINVAL);
        new Uint8Array(buffer.buffer, buffer.byteOffset + offset, n).set(bytes);
        return n;
      },
      write() { throw new FS.ErrnoError(EBADF); },
      llseek(stream: any, offset: number, whence: number) {
        let pos = offset;
        if (whence === 1) pos += stream.position;
        else if (whence === 2) pos += src.size;
        if (pos < 0) throw new FS.ErrnoError(EINVAL);
        return pos;
      },
    });
  }

  /** A write-only file whose bytes go to `sink`, in order. Returns its path. */
  mountSink(sink: ByteSink): string {
    const FS = this.mod.FS;
    return this.makeDevice('rx-sink', {
      open(stream: any) { stream.seekable = true; },
      close() {},
      read() { throw new FS.ErrnoError(EBADF); },
      write(_stream: any, buffer: Int8Array | Uint8Array, offset: number, length: number) {
        // Emscripten passes its heap as an Int8Array. Copy it as bytes: the
        // heap changes after we return.
        sink.write(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length).slice());
        return length;
      },
      llseek(stream: any, offset: number, whence: number) {
        let pos = offset;
        if (whence === 1) pos += stream.position;
        if (pos < 0) throw new FS.ErrnoError(EINVAL);
        return pos;
      },
    });
  }

  /** Run one rkdeveloptool command. Resolves to its exit code (0 is success). */
  async run(args: string[]): Promise<number> {
    let result: any;
    try {
      result = this.mod.callMain(args.map(String));
    } catch (e: any) {
      // exit() inside main throws ExitStatus.
      if (e && typeof e.status === 'number') return e.status;
      throw e;
    }
    if (result && typeof result.then === 'function') result = await result;
    const asyncify = this.mod.Asyncify;
    if (asyncify?.currData && typeof asyncify.whenDone === 'function') result = await asyncify.whenDone();
    return Number(result ?? 0);
  }
}

/** Progress percentage in an rkdeveloptool line, or null. */
export function progressOf(line: string): number | null {
  const m = /\((\d+)%\)/.exec(line);
  return m ? Math.min(100, Number(m[1])) : null;
}

export const stripAnsi = (s: string): string => s.replace(/\x1b\[[\d;]*[A-Za-z]/g, '');
