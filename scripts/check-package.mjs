// Check a packaged app: the design icon is there, and no firmware blob is:
// no Rockchip loader or rkbin file (the app downloads the loader,
// src/maskrom/loaders.ts) and none of the Raspberry Pi or BeagleBone USB boot
// blobs etcher-sdk depends on (not used; left out by package.json and
// scripts/build-writer.mjs). The writer is one pkg binary, so it is searched
// for the paths those files would have inside it.
// With an architecture it also checks that every native addon (.node) and
// the writer (on macOS roxora-imager-rawdisk, which must be there) are built
// for that CPU.
//   node scripts/check-package.mjs <unpacked app dir or .app/Contents/Resources dir> [x64|arm64]
import { listPackage } from '@electron/asar';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { machines } from './lib/machine.mjs';

const [root, arch] = process.argv.slice(2);
if (!root) { console.error('usage: check-package.mjs DIR'); process.exit(2); }
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else {
      files.push(relative(root, p));
      if (n === 'app.asar') for (const f of listPackage(p, { isPack: false })) files.push(`${relative(root, p)}${f}`);
    }
  }
};
walk(root);
const blob = files.filter((f) => /spl_loader|_loader_v\d|usbplug|rk3\d{3}_|rv1\d{3}_|px30_|rkbin|node-raspberrypi-usbboot|node-beaglebone-usbboot|node_modules[\\/]usb[\\/]/i.test(f));
for (const f of files.filter((x) => /roxora-imager-writer(\.exe)?$/.test(x))) {
  const data = readFileSync(join(root, f));
  for (const needle of ['node-raspberrypi-usbboot/blobs', 'node-beaglebone-usbboot/blobs', 'node_modules/usb/', 'spl_loader']) {
    if (data.includes(needle)) blob.push(`${f} (contains ${needle})`);
  }
  console.log(`  writer: ${f}, ${data.length} bytes, searched for blob paths`);
}
const icon = files.filter((f) => /resources[\\/]icons[\\/]png[\\/]roxora-imager-256\.png$/.test(f));
console.log(`${files.length} files in ${root}`);
for (const f of files.filter((x) => /icon|\.icns$|\.ico$/i.test(x))) console.log(`  icon file: ${f}`);
if (arch) {
  const native = files.filter((f) => !f.includes('app.asar/') && (/\.node$/.test(f) || /roxora-imager-(writer(\.exe)?|rawdisk)$/.test(f)));
  const wrong = [];
  for (const f of native) {
    const m = machines(join(root, f));
    if (!m.includes(arch)) wrong.push(`${f} (${m.join('+') || 'not a native binary'})`);
  }
  console.log(`  ${native.length} native binaries checked for ${arch}`);
  if (process.platform === 'darwin' && !native.some((f) => /roxora-imager-rawdisk$/.test(f))) {
    console.log('FAIL: writer/roxora-imager-rawdisk is missing (scripts/build-writer.mjs)'); process.exit(1);
  }
  if (wrong.length) { console.log(`FAIL: not built for ${arch}:\n  ${wrong.join('\n  ')}`); process.exit(1); }
}
if (blob.length) { console.log(`FAIL: firmware blobs in the package:\n  ${blob.join('\n  ')}`); process.exit(1); }
if (!icon.length) { console.log('FAIL: the window icon (resources/icons/png/roxora-imager-256.png) is missing'); process.exit(1); }
console.log('OK: no Rockchip loader, rkbin file or USB boot blob; window icon present');
