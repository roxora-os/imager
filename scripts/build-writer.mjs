// Build the SD/USB writer as a standalone executable (build-res/writer/),
// the way Etcher builds etcher-util: the helper and etcher-sdk bundled into
// one file, packed with @yao-pkg/pkg into a plain Node.js binary, the native
// addons as assets. It cannot run inside Electron's own Node: Electron's V8
// memory cage aborts on the external buffers @ronomon/direct-io allocates for
// O_DIRECT writes.
//   node scripts/build-writer.mjs [node22-linux-x64]
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const plat = { linux: 'linux', darwin: 'macos', win32: 'win' }[process.platform];
const target = process.argv[2] ?? `node22-${plat}-${process.arch}`;
const exe = target.includes('-win-') ? '.exe' : '';

// Packages with native addons stay outside the bundle; pkg ships them as assets.
// ext2fs and winusb-driver-generator are only loaded for features the writer
// does not use (configuring images, Windows driverless USB boot).
const unused = ['ext2fs', 'winusb-driver-generator'];
const native = ['drivelist', 'mountutils', 'lzma-native', 'xxhash-addon', '@ronomon/direct-io', 'usb', 'node-raspberrypi-usbboot', '@balena/node-beaglebone-usbboot'];
await build({
  entryPoints: ['src/helper/write-helper.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  external: [...native, ...unused], outfile: 'build/writer/writer.js', logLevel: 'warning',
});
rmSync('build-res/writer', { recursive: true, force: true });
mkdirSync('build-res/writer', { recursive: true });
execFileSync('npx', ['pkg', 'build/writer/writer.js', '-c', 'packaging/pkg-writer.json', '--no-bytecode', '--public',
  '--public-packages', '*', '--target', target, '--output', `build-res/writer/roxora-imager-writer${exe}`],
{ stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
console.log(`writer: build-res/writer/roxora-imager-writer${exe} (${target})`);
