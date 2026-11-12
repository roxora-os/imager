// The CPU architecture a native binary is built for, from its header:
// ELF (Linux), Mach-O and universal Mach-O (macOS), PE (Windows).
import { closeSync, openSync, readSync } from 'node:fs';

const ELF = { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'ia32', 0x28: 'arm' };
const MACHO = { 0x01000007: 'x64', 0x0100000c: 'arm64', 7: 'ia32' };
const PE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' };

/** The architectures in `path` (several for a universal binary); [] if not a native binary. */
export function machines(path) {
  const fd = openSync(path, 'r');
  const b = Buffer.alloc(4096);
  const n = readSync(fd, b, 0, b.length, 0);
  closeSync(fd);
  if (n < 64) return [];
  if (b.readUInt32BE(0) === 0x7f454c46) return [ELF[b.readUInt16LE(18)] ?? `elf-${b.readUInt16LE(18)}`];
  if (b.readUInt32LE(0) === 0xfeedfacf) return [MACHO[b.readUInt32LE(4)] ?? `macho-${b.readUInt32LE(4)}`];
  if (b.readUInt32BE(0) === 0xcafebabe) {
    const out = [];
    for (let i = 0, c = b.readUInt32BE(4); i < c && 8 + i * 20 + 4 <= n; i++) out.push(MACHO[b.readUInt32BE(8 + i * 20)] ?? 'macho-?');
    return out;
  }
  if (b.toString('latin1', 0, 2) === 'MZ') {
    const pe = b.readUInt32LE(0x3c);
    if (pe + 6 <= n && b.toString('latin1', pe, pe + 4) === 'PE\0\0') return [PE[b.readUInt16LE(pe + 4)] ?? 'pe-?'];
  }
  return [];
}
