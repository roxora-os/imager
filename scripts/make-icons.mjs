// Render resources/icons/roxora-imager.svg (and, for 16 and 24 px, the
// design's simplified roxora-imager-small.svg) into the PNG sizes, the .ico
// and the .icns that scripts/icons.mjs lays out for the packagers. Run once
// after changing an SVG; the results are committed. With --check it writes
// nothing and fails when a committed file is not what the SVGs give.
//   node scripts/make-icons.mjs [--check]
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'resources/icons';
const NAME = 'roxora-imager';
const check = process.argv.includes('--check');
const svg = readFileSync(`${SRC}/${NAME}.svg`, 'utf8');
// The small variant leaves out the chip's contacts, which blur below 32 px.
const small = readFileSync(`${SRC}/${NAME}-small.svg`, 'utf8');
const png = (size) => Buffer.from(new Resvg(size <= 24 ? small : svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
const pngs = Object.fromEntries([...sizes, 1024].map((s) => [s, png(s)]));

const out = new Map();
for (const s of sizes) out.set(`${SRC}/png/${NAME}-${s}.png`, pngs[s]);

// .ico with PNG entries (Windows Vista and later read them).
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6 + 16 * icoSizes.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(icoSizes.length, 4);
let offset = header.length;
icoSizes.forEach((s, i) => {
  const e = 6 + i * 16;
  header[e] = s === 256 ? 0 : s; header[e + 1] = s === 256 ? 0 : s;
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(pngs[s].length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += pngs[s].length;
});
out.set(`${SRC}/${NAME}.ico`, Buffer.concat([header, ...icoSizes.map((s) => pngs[s])]));

// .icns with PNG entries: ic07 128, ic08 256, ic09 512, ic10 1024 (512@2x),
// ic11 32 (16@2x), ic12 64 (32@2x), ic13 256 (128@2x), ic14 512 (256@2x).
const parts = [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]
  .map(([t, s]) => {
    const h = Buffer.alloc(8); h.write(t, 0, 'ascii'); h.writeUInt32BE(pngs[s].length + 8, 4);
    return Buffer.concat([h, pngs[s]]);
  });
const body = Buffer.concat(parts);
const top = Buffer.alloc(8); top.write('icns', 0, 'ascii'); top.writeUInt32BE(body.length + 8, 4);
out.set(`${SRC}/${NAME}.icns`, Buffer.concat([top, body]));

if (check) {
  const stale = [...out].filter(([f, data]) => { try { return !readFileSync(f).equals(data); } catch { return true; } }).map(([f]) => f);
  if (stale.length) {
    console.log(`FAIL: not what the SVGs give (run node scripts/make-icons.mjs):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`OK: ${out.size} icon files match the SVGs`);
} else {
  for (const [f, data] of out) writeFileSync(f, data);
  console.log('icons written to', SRC);
}
