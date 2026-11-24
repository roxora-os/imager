// A Rockchip firmware package (update.img, as RKDevTool and the vendors'
// "factory image" downloads ship it): an RKFW header, the boot loader
// (MiniLoaderAll.bin, an RKBOOT "LDR " or "BOOT" file) and an RKAF archive of
// the partition images with parameter.txt, which places them on the eMMC.
// Read here to check it is for RK3576 and to list what it holds; nothing is
// unpacked to disk, the partitions are written straight from the file.
//
// Layouts: rkdeveloptool's RKImage.h (STRUCT_RKIMAGE_HEAD) and afptool's
// update_header/update_part. The chip field holds the chip's digits as
// ASCII, last digit first: "6753" for RK3576, as in rk3576_spl_loader.bin.
// From Maskrom Studio (src/woa/rkfw.ts), where it was written to be shared.

import type { ByteSource } from './rkcore';

export const SECTOR = 512;

export interface RkafPart {
  name: string;
  file: string;
  /** Byte offset of the data in the update.img. */
  offset: number;
  size: number;
  /** Where parameter.txt puts this partition, or null for the loader and parameter. */
  lba: number | null;
  /** Its size from parameter.txt in sectors; null for the last, growing one. */
  sectors: number | null;
  /** Android sparse image (wl expands it). */
  sparse: boolean;
}

export interface ParamPart { name: string; lba: number; sectors: number | null; grow: boolean }

export interface UpdateImage {
  /** The chip from the header, as text: "RK3576". */
  chip: string;
  chipCode: number;
  version: string;
  released: string;
  loader: { offset: number; size: number; chip: string } | null;
  model: string;
  manufacturer: string;
  firmwareId: string;
  /** End of the RKFW data; the MD5 (32 hex characters) follows. */
  dataEnd: number;
  md5: string | null;
  parameter: string;
  partitions: ParamPart[];
  parts: RkafPart[];
}

const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const str = (b: Uint8Array) => {
  const z = b.indexOf(0);
  return new TextDecoder('latin1').decode(z >= 0 ? b.subarray(0, z) : b).trim();
};

/** 0x33353736 -> "RK3576"; codes that are not four digits are shown in hex. */
export function chipName(code: number): string {
  const s = String.fromCharCode(code & 0xff, (code >> 8) & 0xff, (code >> 16) & 0xff, (code >>> 24) & 0xff);
  return /^[0-9A-Z]{4}$/.test(s) ? `RK${[...s].reverse().join('')}` : `0x${code.toString(16)}`;
}

export const RK3576 = 0x33353736;

function version(v: number): string {
  return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${v & 0xffff}`;
}

/** mtdparts from parameter.txt's CMDLINE: "0x2000@0x4000(uboot),...,-@0x1234(userdata:grow)". */
export function parseParameter(text: string): ParamPart[] {
  const line = /mtdparts=[^:\s]*:([^\s]+)/.exec(text);
  if (!line) throw new Error('parameter.txt has no mtdparts in its CMDLINE.');
  return line[1].split(',').map((p) => {
    const m = /^(-|0x[0-9a-fA-F]+)@(0x[0-9a-fA-F]+)\(([^)]+)\)$/.exec(p.trim());
    if (!m) throw new Error(`parameter.txt has a partition entry it cannot read: ${p}`);
    const [name, ...flags] = m[3].split(':');
    return { name, lba: parseInt(m[2], 16), sectors: m[1] === '-' ? null : parseInt(m[1], 16), grow: m[1] === '-' || flags.includes('grow') };
  });
}

/** The parameter item's data: plain text, or wrapped as "PARM" + length + text + CRC. */
export function parameterText(data: Uint8Array): string {
  const tag = new TextDecoder('latin1').decode(data.subarray(0, 4));
  const body = tag === 'PARM' ? data.subarray(8, 8 + le32(data, 4)) : data;
  return new TextDecoder('latin1').decode(body).replace(/\0+$/, '');
}

export function readUpdateImage(src: ByteSource): UpdateImage {
  if (src.size < 0x66 + 2048) throw new Error('The file is too small to be a Rockchip update.img.');
  const h = src.read(0, 0x66);
  const magic = new TextDecoder('latin1').decode(h.subarray(0, 4));
  if (magic !== 'RKFW') {
    if (magic === 'RKAF') throw new Error('This is an RKAF archive without its RKFW header (update.img unpacked once). Use the update.img itself.');
    throw new Error('The file is not a Rockchip update.img (no RKFW header).');
  }
  const chipCode = le32(h, 0x15);
  const y = le16(h, 0x0e);
  const released = `${y}-${String(h[0x10]).padStart(2, '0')}-${String(h[0x11]).padStart(2, '0')}`;
  const bootOffset = le32(h, 0x19);
  const bootSize = le32(h, 0x1d);
  const fwOffset = le32(h, 0x21);
  let fwSize = le32(h, 0x25);
  // Packages over 4 GiB keep the high half of the size in the reserved bytes ("HI").
  if (h[0x29 + 14] === 0x48 && h[0x29 + 15] === 0x49) fwSize += le32(h, 0x29 + 16) * 2 ** 32;
  const dataEnd = fwOffset + fwSize;
  if (fwOffset < 0x66 || dataEnd > src.size) throw new Error('The update.img is incomplete: its header says it is larger than the file. Was the download cut short?');
  if (bootOffset + bootSize > src.size) throw new Error('The update.img is incomplete: its loader is cut off.');

  let loader: UpdateImage['loader'] = null;
  if (bootSize >= 0x66) {
    const lh = src.read(bootOffset, 0x19);
    const lm = new TextDecoder('latin1').decode(lh.subarray(0, 4));
    if (lm !== 'LDR ' && lm !== 'BOOT') throw new Error('The loader inside the update.img is not a Rockchip boot loader.');
    loader = { offset: bootOffset, size: bootSize, chip: chipName(le32(lh, 0x15)) };
  }

  const a = src.read(fwOffset, Math.min(8192, src.size - fwOffset));
  if (new TextDecoder('latin1').decode(a.subarray(0, 4)) !== 'RKAF') throw new Error('The update.img has no RKAF archive where its header says.');
  const count = le32(a, 136);
  if (count === 0 || count > 64 || 140 + count * 112 > a.length) throw new Error(`The update.img lists ${count} parts, which cannot be right.`);
  const raw = [...Array(count).keys()].map((i) => {
    const o = 140 + i * 112;
    return { name: str(a.subarray(o, o + 32)), file: str(a.subarray(o + 32, o + 92)), pos: le32(a, o + 96), nandAddr: le32(a, o + 100), size: le32(a, o + 108) };
  });
  for (const p of raw) {
    if (fwOffset + p.pos + p.size > dataEnd) throw new Error(`The part ${p.name} reaches past the end of the update.img.`);
  }
  const param = raw.find((p) => p.name.toLowerCase() === 'parameter' || /parameter/i.test(p.file));
  if (!param) throw new Error('The update.img has no parameter.txt, so where its partitions go is unknown.');
  const parameter = parameterText(src.read(fwOffset + param.pos, param.size));
  const partitions = parseParameter(parameter);

  const parts: RkafPart[] = raw.filter((p) => p.size > 0 && p.file !== 'RESERVED').map((p) => {
    const offset = fwOffset + p.pos;
    const target = partitions.find((x) => x.name === p.name);
    const head = p.size >= 4 ? src.read(offset, 4) : new Uint8Array(4);
    return { name: p.name, file: p.file, offset, size: p.size, lba: target ? target.lba : null, sectors: target ? target.sectors : null, sparse: le32(head, 0) === 0xed26ff3a };
  });

  let md5: string | null = null;
  if (src.size - dataEnd >= 32) {
    const m = new TextDecoder('latin1').decode(src.read(dataEnd, 32));
    if (/^[0-9a-f]{32}$/i.test(m)) md5 = m.toLowerCase();
  }

  return {
    chip: chipName(chipCode), chipCode, version: version(le32(h, 0x06)), released, loader,
    model: str(a.subarray(8, 42)), firmwareId: str(a.subarray(42, 72)), manufacturer: str(a.subarray(72, 128)),
    dataEnd, md5, parameter, partitions, parts,
  };
}

export interface FactoryPlan {
  /** Partition images and where they go, in eMMC order. */
  writes: Array<{ name: string; lba: number; offset: number; size: number; sparse: boolean }>;
  /** Parts that have no place in parameter.txt (besides the loader and parameter): not written. */
  skipped: string[];
  /** The highest sector a fixed-size partition reaches. */
  endLba: number;
}

/** What goes where, or why the package cannot be written to this eMMC. */
export function planFactory(img: UpdateImage, capacity: number | null): FactoryPlan | { stop: string } {
  if (img.chipCode !== RK3576) return { stop: `This update.img is for ${img.chip}, not RK3576.` };
  if (!img.loader) return { stop: 'This update.img has no boot loader.' };
  if (img.loader.chip !== 'RK3576') return { stop: `The loader in this update.img is for ${img.loader.chip}, not RK3576.` };
  const writes: FactoryPlan['writes'] = [];
  const skipped: string[] = [];
  for (const p of img.parts) {
    const n = p.name.toLowerCase();
    if (n === 'parameter' || n === 'bootloader' || /miniloader/i.test(p.file)) continue;
    if (p.lba === null) { skipped.push(p.name); continue; }
    if (!p.sparse && p.sectors !== null && p.size > p.sectors * SECTOR) {
      return { stop: `The image of ${p.name} (${p.size} bytes) is larger than its partition (${p.sectors * SECTOR} bytes).` };
    }
    writes.push({ name: p.name, lba: p.lba, offset: p.offset, size: p.size, sparse: p.sparse });
  }
  if (writes.length === 0) return { stop: 'This update.img has no partition images to write.' };
  writes.sort((x, y) => x.lba - y.lba);
  const endLba = Math.max(...img.partitions.map((x) => x.lba + (x.sectors ?? 0)));
  if (capacity !== null && endLba * SECTOR > capacity) {
    return { stop: `This update.img's partitions need ${endLba * SECTOR} bytes; the eMMC has ${capacity}.` };
  }
  return { writes, skipped, endLba };
}

export function sliceSource(src: ByteSource, offset: number, length: number): ByteSource {
  if (offset < 0 || offset + length > src.size) throw new Error('slice outside its source');
  return { size: length, read: (p, n) => src.read(offset + p, n) };
}

export function bytesSource(data: Uint8Array): ByteSource {
  return { size: data.length, read: (p, n) => data.slice(p, p + n) };
}

/** A part of the storage to write: `source` from sector `lba`. */
export interface Region { lba: number; source: ByteSource; label: string }

export interface UpdateSummary {
  chip: string;
  model: string;
  manufacturer: string;
  version: string;
  released: string;
  partitions: Array<{ name: string; lba: number; bytes: number }>;
  skipped: string[];
  bytes: number;
}

/**
 * The regions of an update.img once the storage size is known, with the
 * package's loader (written with ul) and parameter.txt (gpt), as RKDevTool's
 * "Upgrade Firmware" does: the partition table, the loader, the partitions.
 */
export function planUpdateRegions(file: ByteSource, img: UpdateImage, capacity: number | null):
  { regions: Region[]; loader: Uint8Array; parameter: Uint8Array; summary: UpdateSummary } | { stop: string } {
  const p = planFactory(img, capacity);
  if ('stop' in p) return p;
  return {
    regions: p.writes.map((w) => ({ lba: w.lba, source: sliceSource(file, w.offset, w.size), label: `the ${w.name} partition` })),
    loader: file.read(img.loader!.offset, img.loader!.size),
    parameter: new TextEncoder().encode(img.parameter),
    summary: summarize(img, p),
  };
}

export function summarize(img: UpdateImage, p: FactoryPlan): UpdateSummary {
  return {
    chip: img.chip, model: img.model, manufacturer: img.manufacturer, version: img.version, released: img.released,
    partitions: p.writes.map((w) => ({ name: w.name, lba: w.lba, bytes: w.size })), skipped: p.skipped,
    bytes: p.writes.reduce((s, w) => s + w.size, 0),
  };
}
