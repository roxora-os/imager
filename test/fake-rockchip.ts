// A pretend RK3576 board on WebUSB, for testing the Maskrom sequence through
// the real WASM rkdeveloptool and its libusb backend without hardware.
//
// It speaks the subset of the Rockusb protocol rkdeveloptool uses here:
// the Maskrom loader download (vendor control requests 0x471/0x472), then,
// in Loader mode, CBW/CSW commands on the bulk endpoints: change storage,
// read storage, read flash info, write LBA, read LBA, reset. After the loader
// download it "re-enumerates": the old USBDevice goes away and a new one in
// Loader mode appears, as on real hardware.

/* eslint-disable @typescript-eslint/no-explicit-any */

const SECTOR = 512;
const CBW_SIGN = 0x43425355;
const CSW_SIGN = 0x53425355;

export interface FakeOptions {
  /** Storage code -> size in bytes. */
  storages: Record<number, number>;
  /** Storage code the loader starts on. */
  defaultStorage: number;
  /** Change a byte of every read at this offset (simulates a bad write). */
  corruptReadAt?: number;
  /** Return 0xCC filler for reads from this offset on. */
  fillerFrom?: number;
  /** Do not come back after the loader. */
  stayAway?: boolean;
}

class Storage {
  blocks = new Map<number, Uint8Array>();
  constructor(public size: number) {}
  private static BLOCK = 1 << 20;
  write(offset: number, data: Uint8Array) {
    let done = 0;
    while (done < data.length) {
      const pos = offset + done;
      const bi = Math.floor(pos / Storage.BLOCK);
      const bo = pos % Storage.BLOCK;
      let b = this.blocks.get(bi);
      if (!b) { b = new Uint8Array(Storage.BLOCK); this.blocks.set(bi, b); }
      const n = Math.min(Storage.BLOCK - bo, data.length - done);
      b.set(data.subarray(done, done + n), bo);
      done += n;
    }
  }
  read(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const pos = offset + done;
      const bi = Math.floor(pos / Storage.BLOCK);
      const bo = pos % Storage.BLOCK;
      const n = Math.min(Storage.BLOCK - bo, length - done);
      const b = this.blocks.get(bi);
      if (b) out.set(b.subarray(bo, bo + n), done);
      done += n;
    }
    return out;
  }
}

function deviceDescriptor(loader: boolean): DataView {
  const b = new Uint8Array(18);
  const v = new DataView(b.buffer);
  b[0] = 18; b[1] = 1;
  v.setUint16(2, loader ? 0x0201 : 0x0200, true); // bcdUSB: odd = Loader (rkdeveloptool's rule)
  b[7] = 64;
  v.setUint16(8, 0x2207, true);
  v.setUint16(10, 0x350e, true);
  v.setUint16(12, 0x0100, true);
  b[17] = 1;
  return v;
}

function configDescriptor(): DataView {
  const b = new Uint8Array([
    9, 2, 32, 0, 1, 1, 0, 0x80, 50,
    9, 4, 0, 0, 2, 0xff, 6, 5, 0,
    7, 5, 0x81, 2, 0x00, 0x02, 0,
    7, 5, 0x01, 2, 0x00, 0x02, 0,
  ]);
  return new DataView(b.buffer);
}

export class FakeBoard {
  storages = new Map<number, Storage>();
  current: number;
  loaderBytes = 0;
  resets = 0;
  loaderTimer: any = undefined;
  devices: FakeUsbDevice[] = [];
  log: string[] = [];

  constructor(public opts: FakeOptions) {
    for (const [code, size] of Object.entries(opts.storages)) this.storages.set(Number(code), new Storage(size));
    this.current = opts.defaultStorage;
    this.devices = [new FakeUsbDevice(this, false)];
  }

  /** What navigator.usb looks like for this board. */
  usb() {
    return { getDevices: async () => [...this.devices] };
  }

  loaderDone() {
    // The SoC resets into the loader: the Maskrom device disappears, a new
    // Loader device appears a moment later.
    this.devices = [];
    if (this.opts.stayAway) return;
    setTimeout(() => { this.devices = [new FakeUsbDevice(this, true)]; }, 300);
  }

  contents(code: number, length: number): Uint8Array {
    return this.storages.get(code)!.read(0, length);
  }
}

class FakeUsbDevice {
  vendorId = 0x2207;
  productId = 0x350e;
  serialNumber = '';
  opened = false;
  configuration = { configurationValue: 1 };
  usbVersionMajor = 2; usbVersionMinor = 0;
  usbVersionSubminor: number;
  private pending: { op: number; tag: number; addr: number; count: number; reserved: number; len: number } | null = null;
  private inQueue: Uint8Array[] = [];

  constructor(private board: FakeBoard, private loader: boolean) {
    this.usbVersionSubminor = loader ? 1 : 0;
  }

  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async selectConfiguration() {}
  async claimInterface() {}
  async releaseInterface() {}
  async reset() {}
  async clearHalt() {}

  async controlTransferIn(setup: any, length: number) {
    if (setup.requestType === 'standard' && setup.request === 6) {
      const type = setup.value >> 8;
      const d = type === 1 ? deviceDescriptor(this.loader) : type === 2 ? configDescriptor() : null;
      if (!d) return { status: 'stall', data: new DataView(new ArrayBuffer(0)) };
      return { status: 'ok', data: new DataView(d.buffer, 0, Math.min(length, d.byteLength)) };
    }
    return { status: 'stall', data: new DataView(new ArrayBuffer(0)) };
  }

  async controlTransferOut(setup: any, data: DataView) {
    if (!this.loader && setup.requestType === 'vendor' && setup.request === 0x0c) {
      this.board.loaderBytes += data.byteLength;
      if (setup.index === 0x472) {
        // Once the usbplug stops arriving, the SoC starts the loader.
        clearTimeout(this.board.loaderTimer);
        this.board.loaderTimer = setTimeout(() => {
          this.board.log.push('loader started');
          this.board.loaderDone();
        }, 200);
      }
      return { status: 'ok', bytesWritten: data.byteLength };
    }
    return { status: 'stall', bytesWritten: 0 };
  }

  private csw(tag: number, status = 0) {
    const b = new Uint8Array(13);
    const v = new DataView(b.buffer);
    v.setUint32(0, CSW_SIGN, true);
    v.setUint32(4, tag, true);
    b[12] = status;
    this.inQueue.push(b);
  }

  async transferOut(_ep: number, data: DataView) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    if (!this.loader) return { status: 'stall', bytesWritten: 0 };
    if (this.pending && this.pending.op === 0x15) {
      const p = this.pending;
      const st = this.board.storages.get(this.board.current)!;
      if (p.addr * SECTOR + bytes.length > st.size) {
        this.csw(p.tag, 1);
      } else {
        st.write(p.addr * SECTOR, bytes);
        this.csw(p.tag, 0);
      }
      this.pending = null;
      return { status: 'ok', bytesWritten: bytes.length };
    }
    const v = new DataView(bytes.buffer);
    if (bytes.length !== 31 || v.getUint32(0, true) !== CBW_SIGN) return { status: 'stall', bytesWritten: 0 };
    const tag = v.getUint32(4, true);
    const len = v.getUint32(8, true);
    const op = bytes[15];
    const reserved = bytes[16];
    const addr = v.getUint32(17, false);
    const count = v.getUint16(22, false);
    const cmd = { op, tag, addr, count, reserved, len };
    this.board.log.push(`cmd 0x${op.toString(16)}`);
    switch (op) {
      case 0x2a: { // CHANGE_STORAGE
        if (this.board.storages.has(reserved)) this.board.current = reserved;
        this.csw(tag, 0); // like the real loader: no error, read the storage back to know
        break;
      }
      case 0x2b: { // READ_STORAGE
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, 1 << this.board.current, true);
        this.inQueue.push(b);
        this.csw(tag);
        break;
      }
      case 0x1a: { // READ_FLASH_INFO
        const b = new Uint8Array(11);
        const dv = new DataView(b.buffer);
        dv.setUint32(0, this.board.storages.get(this.board.current)!.size / SECTOR, true);
        dv.setUint16(4, 1024, true);
        b[6] = 4; b[10] = 1;
        this.inQueue.push(b);
        this.csw(tag);
        break;
      }
      case 0x15: // WRITE_LBA: the data follows
        this.pending = cmd;
        break;
      case 0x14: { // READ_LBA
        const st = this.board.storages.get(this.board.current)!;
        const off = addr * SECTOR;
        const data = st.read(off, count * SECTOR);
        const { corruptReadAt, fillerFrom } = this.board.opts;
        if (corruptReadAt !== undefined && corruptReadAt >= off && corruptReadAt < off + data.length) {
          data[corruptReadAt - off] ^= 0xff;
        }
        if (fillerFrom !== undefined) {
          for (let i = Math.max(0, fillerFrom - off); i < data.length; i++) data[i] = 0xcc;
        }
        this.inQueue.push(data);
        this.csw(tag);
        break;
      }
      case 0xff: // DEVICE_RESET
        this.board.resets++;
        this.csw(tag);
        break;
      default:
        this.csw(tag, 1);
    }
    return { status: 'ok', bytesWritten: bytes.length };
  }

  async transferIn(_ep: number, length: number) {
    const next = this.inQueue.shift();
    if (!next) return { status: 'stall', data: new DataView(new ArrayBuffer(0)) };
    if (next.length > length) {
      this.inQueue.unshift(next.subarray(length));
      return { status: 'ok', data: new DataView(next.buffer, next.byteOffset, length) };
    }
    return { status: 'ok', data: new DataView(next.buffer, next.byteOffset, next.length) };
  }
}
