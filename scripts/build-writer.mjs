// Build what writes SD cards and USB drives, into build-res/writer/.
//
// macOS: roxora-imager-rawdisk, a small C program that has Apple's authopen
// open the raw disk (src/helper/macos/rawdisk.c, src/main/mac-write.ts),
// for both CPUs in one file. The etcher-sdk writer below is not used there.
//
// Linux and Windows: the writer as a standalone executable, the way Etcher
// builds etcher-util: the helper and etcher-sdk bundled into one file,
// packed with @yao-pkg/pkg into a plain Node.js binary, the native addons as
// assets. It cannot run inside Electron's own Node: Electron's V8 memory
// cage aborts on the external buffers @ronomon/direct-io allocates for
// O_DIRECT writes.
//   node scripts/build-writer.mjs [node22-linux-x64]
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

if (process.platform === 'darwin') {
  rmSync('build-res/writer', { recursive: true, force: true });
  mkdirSync('build-res/writer', { recursive: true });
  execFileSync('cc', ['-O2', '-Wall', '-Wextra', '-Werror', '-arch', 'arm64', '-arch', 'x86_64',
    '-mmacosx-version-min=11.0', '-framework', 'Security',
    '-o', 'build-res/writer/roxora-imager-rawdisk', 'src/helper/macos/rawdisk.c'], { stdio: 'inherit' });
  console.log('writer: build-res/writer/roxora-imager-rawdisk (arm64 and x86_64)');
  process.exit(0);
}

const plat = { linux: 'linux', darwin: 'macos', win32: 'win' }[process.platform];
const target = process.argv[2] ?? `node22-${plat}-${process.arch}`;
const exe = target.includes('-win-') ? '.exe' : '';

// Packages with native addons stay outside the bundle; pkg ships them as assets.
// These are only loaded for features the writer does not use, so they stay
// out of it: ext2fs (configuring images), winusb-driver-generator (Windows
// driverless USB boot), and the Raspberry Pi and BeagleBone USB boot modules
// with their firmware blobs (etcher-sdk's device scanner; the helper imports
// only multi-write and source-destination, and etcher-sdk loads
// node-raspberrypi-usbboot lazily, catching its absence).
const unused = ['ext2fs', 'winusb-driver-generator'];
const native = ['drivelist', 'mountutils', 'lzma-native', 'xxhash-addon', '@ronomon/direct-io'];
// A plain external require would still make pkg pack the module and its
// blobs, so the USB boot modules are replaced by a stub that throws.
const stubbed = ['usb', 'node-raspberrypi-usbboot', '@balena/node-beaglebone-usbboot'];
const stub = {
  name: 'stub-usbboot',
  setup(b) {
    const filter = new RegExp(`^(${stubbed.map((m) => m.replace(/[/.]/g, '\\$&')).join('|')})$`);
    b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      contents: `throw new Error(${JSON.stringify(`${a.path} is not included in the Roxora Imager writer`)});`, loader: 'js',
    }));
  },
};
await build({
  entryPoints: ['src/helper/write-helper.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  external: [...native, ...unused], plugins: [stub], outfile: 'build/writer/writer.js', logLevel: 'warning',
});
rmSync('build-res/writer', { recursive: true, force: true });
mkdirSync('build-res/writer', { recursive: true });
execFileSync('npx', ['pkg', 'build/writer/writer.js', '-c', 'packaging/pkg-writer.json', '--no-bytecode', '--public',
  '--public-packages', '*', '--target', target, '--output', `build-res/writer/roxora-imager-writer${exe}`],
{ stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
console.log(`writer: build-res/writer/roxora-imager-writer${exe} (${target})`);
