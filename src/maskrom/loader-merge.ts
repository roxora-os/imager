// Builds a Rockchip Loader (the file rkdeveloptool's `db` sends) from the
// pieces in Rockchip's rkbin repository, the way rkbin's boot_merger does,
// so the app never ships the blob itself. Ported from
// gahingwoo/RKDevelopTool-GUI (rkdeveloptool-gui/loader_merge.py), which
// follows the open-source boot_merger.c; only the newer "LDR " format of
// NEWIDB chips (RK35xx) is here. With the build time of a Rockchip-built
// loader it gives that loader byte for byte.

import { sha256 } from '@noble/hashes/sha2.js';

export class LoaderMergeError extends Error {}

const HEADER_SIZE = 102;
const ENTRY_SIZE = 57;
const NAME_CHARS = 20;
const SECTOR = 512;
const DEFAULT_ALIGN = 2048;
const MERGER_VERSION_LDR = 0x01000000;
const ENTRY_471 = 1;
const ENTRY_472 = 2;
const ENTRY_LOADER = 4;
const RKNS_HASH_AT = 0x600;
const RKNS_WORDS_AT = 0x58;
const RKNS_IMAGES_AT = 0x78;
const RKNS_IMAGE_SIZE = 88;
const RKNS_MAX_IMAGES = 4;
const RC4_KEY = [124, 78, 3, 4, 85, 5, 9, 7, 45, 44, 123, 56, 23, 13, 23, 17];

export interface LoaderOptions {
  chip: string;
  major: number;
  minor: number;
  code471: string[];
  code471Sleep: number;
  code472: string[];
  code472Sleep: number;
  loaders: { name: string; path: string; address: number; flag: number }[];
  output: string;
  align: number;
  rc4On471: boolean;
  words: number[];
}

function rc4Stream(length: number): Uint8Array {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + RC4_KEY[i % RC4_KEY.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(length);
  let i = 0;
  j = 0;
  for (let x = 0; x < length; x++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[x] = s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

/** Rockchip's P_RC4 over the whole buffer (its own inverse). */
export function rc4(data: Uint8Array): Uint8Array {
  const k = rc4Stream(data.length);
  return data.map((b, i) => b ^ k[i]);
}

/** P_RC4 restarted every 512 bytes, as boot_merger stores loader entries. */
export function rc4Sectors(data: Uint8Array): Uint8Array {
  const k = rc4Stream(SECTOR);
  return data.map((b, i) => b ^ k[i % SECTOR]);
}

let crcTable: Uint32Array | null = null;
/** Rockchip's CRC-32 (polynomial 0x04C10DB7, not reflected; not zlib's). */
export function rkcrc32(data: Uint8Array, crc = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i << 24;
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c10db7 : c << 1;
      crcTable[i] = c >>> 0;
    }
  }
  for (const b of data) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc >>> 0;
}

function pad(data: Uint8Array, align: number): Uint8Array {
  const n = Math.ceil(data.length / align) * align;
  if (n === data.length) return data;
  const out = new Uint8Array(n);
  out.set(data);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const int = (v: string | undefined, dflt = 0) => {
  const s = (v ?? '').trim();
  if (!s) return dflt;
  const n = Number(s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10));
  if (Number.isNaN(n)) throw new LoaderMergeError(`not a number in the RKBOOT ini: ${s}`);
  return n;
};

/** The parts of an RKBOOT .ini that decide what goes into the Loader. */
export function parseIni(text: string): LoaderOptions {
  const cfg: Record<string, Record<string, string>> = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) { section = m[1].trim(); cfg[section] ??= {}; continue; }
    const eq = line.indexOf('=');
    if (eq > 0 && section) cfg[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const get = (s: string, k: string) => cfg[s]?.[k];
  const need = (s: string, k: string) => {
    const v = get(s, k);
    if (v === undefined) throw new LoaderMergeError(`incomplete RKBOOT ini: no ${k} in [${s}]`);
    return v;
  };
  const paths = (s: string) => {
    const out: string[] = [];
    for (let i = 1; i <= int(get(s, 'NUM')); i++) {
      const p = get(s, `Path${i}`);
      if (!p) throw new LoaderMergeError(`[${s}] lists fewer paths than NUM`);
      out.push(p);
    }
    return out;
  };
  if ((get('SYSTEM', 'NEWIDB') ?? '').toLowerCase() !== 'true') {
    throw new LoaderMergeError('only NEWIDB ("LDR ") loaders are built here');
  }
  const loaders = [];
  for (let i = 1; i <= int(get('LOADER_OPTION', 'NUM')); i++) {
    const name = need('LOADER_OPTION', `LOADER${i}`);
    loaders.push({
      name, path: need('LOADER_OPTION', name),
      address: int(get(`LOADER${i}_PARAM`, 'LOAD_ADDR'), 0xffffffff),
      flag: int(get(`LOADER${i}_PARAM`, 'FLAG')),
    });
  }
  const o: LoaderOptions = {
    chip: need('CHIP_NAME', 'NAME'),
    major: int(need('VERSION', 'MAJOR')),
    minor: int(get('VERSION', 'MINOR')),
    code471: paths('CODE471_OPTION'),
    code471Sleep: int(get('CODE471_OPTION', 'Sleep')),
    code472: paths('CODE472_OPTION'),
    code472Sleep: int(get('CODE472_OPTION', 'Sleep')),
    loaders,
    output: need('OUTPUT', 'PATH'),
    align: int(get('SYSTEM', 'ALIGN')) * SECTOR || DEFAULT_ALIGN,
    rc4On471: (get('FLAG', '471_RC4_OFF') ?? '').toLowerCase() !== 'true',
    words: Array.from({ length: 8 }, (_, i) => int(get('BOOT1_PARAM', `WORD_${i}`))),
  };
  if (!o.code471.length || !o.code472.length || !o.loaders.length) {
    throw new LoaderMergeError('the RKBOOT ini has no DDR, usbplug or loader entries');
  }
  if (Math.max(o.code471.length + o.code472.length, o.loaders.length) > RKNS_MAX_IMAGES) {
    throw new LoaderMergeError('more images than an RKNS header holds');
  }
  return o;
}

/** Every rkbin file the Loader is built from, without duplicates. */
export function blobPaths(o: LoaderOptions): string[] {
  return [...new Set([...o.code471, ...o.code472, ...o.loaders.map((l) => l.path)])];
}

// "rk3576_usbplug_v1.04.bin" -> "rk3576_usbplug_v1": the current boot_merger
// stops at the first dot.
const entryName = (path: string) => path.slice(path.lastIndexOf('/') + 1).split('.')[0].slice(0, NAME_CHARS);

function rknsHeader(images: [Uint8Array, number, number][], size: number, words: number[]): Uint8Array {
  const h = new Uint8Array(size);
  const v = new DataView(h.buffer);
  h.set([0x52, 0x4b, 0x4e, 0x53]); // RKNS
  v.setUint32(8, (images.length << 16) + 384, true);
  v.setUint32(12, 1, true); // 1: SHA-256
  words.forEach((w, i) => v.setUint32(RKNS_WORDS_AT + 4 * i, w >>> 0, true));
  let sector = size / SECTOR;
  images.forEach(([data, address, flag], i) => {
    const at = RKNS_IMAGES_AT + i * RKNS_IMAGE_SIZE;
    const count = data.length / SECTOR;
    v.setUint32(at, ((count << 16) + sector) >>> 0, true);
    v.setUint32(at + 4, address >>> 0, true);
    v.setUint32(at + 8, flag >>> 0, true);
    v.setUint32(at + 12, i + 1, true);
    h.set(sha256(data), at + 24);
    sector += count;
  });
  h.set(sha256(h.subarray(0, RKNS_HASH_AT)), RKNS_HASH_AT);
  return h;
}

/** The header's build time: year, month (1 to 12), day, hour, minute, second. */
export type BuildTime = [number, number, number, number, number, number];

/** Build the Loader from the ini's options and the rkbin files it names. */
export function mergeLoader(o: LoaderOptions, blobs: Map<string, Uint8Array>, when: BuildTime): Uint8Array {
  const read = (p: string) => {
    const b = blobs.get(p);
    if (!b) throw new LoaderMergeError(`missing rkbin file ${p}`);
    return b;
  };
  const usb = [...o.code471, ...o.code472].map((p) => pad(read(p), o.align));
  const flash: [Uint8Array, number, number][] = o.loaders.map((l) => [pad(pad(read(l.path), SECTOR), o.align), l.address, l.flag]);
  const entries: [number, string, number, Uint8Array][] = [];
  entries.push([ENTRY_471, 'UsbHead', o.code471Sleep, rknsHeader(usb.map((d) => [d, 0xffffffff, 0]), o.align, o.words)]);
  o.code471.forEach((p, i) => entries.push([ENTRY_471, entryName(p), o.code471Sleep, o.rc4On471 ? rc4(usb[i]) : usb[i]]));
  o.code472.forEach((p, i) => {
    const d = usb[o.code471.length + i];
    entries.push([ENTRY_472, entryName(p), o.code472Sleep, o.rc4On471 ? rc4(d) : d]);
  });
  entries.push([ENTRY_LOADER, 'FlashHead', 0, rc4Sectors(rknsHeader(flash, o.align, o.words))]);
  o.loaders.forEach((l, i) => entries.push([ENTRY_LOADER, l.name.slice(0, NAME_CHARS), 0, rc4Sectors(flash[i][0])]));

  const header = new Uint8Array(HEADER_SIZE);
  const hv = new DataView(header.buffer);
  header.set([0x4c, 0x44, 0x52, 0x20]); // "LDR "
  hv.setUint16(4, HEADER_SIZE, true);
  hv.setUint32(6, ((o.major << 8) | (o.minor & 0xff)) >>> 0, true);
  hv.setUint32(10, MERGER_VERSION_LDR, true);
  hv.setUint16(14, when[0], true);
  when.slice(1).forEach((x, i) => hv.setUint8(16 + i, x));
  const chip = (o.chip.slice(2, 6) + '\0\0\0\0').slice(0, 4);
  hv.setUint32(21, [...chip].reduce((n, c) => (n << 8) | c.charCodeAt(0), 0) >>> 0, true);
  let offset = HEADER_SIZE;
  let at = 25;
  for (const t of [ENTRY_471, ENTRY_472, ENTRY_LOADER]) {
    const count = entries.filter((e) => e[0] === t).length;
    hv.setUint8(at, count);
    hv.setUint32(at + 1, offset, true);
    hv.setUint8(at + 5, ENTRY_SIZE);
    offset += count * ENTRY_SIZE;
    at += 6;
  }
  header[at + 1] = 1; // rc4Flag: no --rc4
  header[at + 2] = 1;
  header[at + 3] = o.align !== DEFAULT_ALIGN ? 1 : 0;

  const table = new Uint8Array(entries.length * ENTRY_SIZE);
  const tv = new DataView(table.buffer);
  let dataAt = offset;
  entries.forEach(([kind, name, delay, stored], i) => {
    const e = i * ENTRY_SIZE;
    tv.setUint8(e, ENTRY_SIZE);
    tv.setUint32(e + 1, kind, true);
    for (let c = 0; c < name.length; c++) tv.setUint16(e + 5 + 2 * c, name.charCodeAt(c), true);
    tv.setUint32(e + 45, dataAt, true);
    tv.setUint32(e + 49, stored.length, true);
    tv.setUint32(e + 53, delay, true);
    dataAt += stored.length;
  });
  const body = concat([header, table, ...entries.map((e) => e[3])]);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, rkcrc32(body), true);
  return concat([body, crc]);
}
