// Lay out the app icon for the packagers. The icon files in resources/icons/
// are roxora-os/design's icons/imager/ copied unchanged, from design commit
// ca04578095f0fbc099d47396ffb64984f29e0ad9 ("Add imager icon PNG sizes");
// nothing is rendered or recoloured here. Writes build-res/ (not committed):
//   icon.icns, icon.ico, icon.png        electron-builder (macOS, Windows, Linux)
//   linux-icons/<n>x<n>.png              electron-builder's AppImage icon set
//   hicolor/...                          what the .deb and .rpm install, named
//                                        after the app ID
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

const APP_ID = 'io.github.roxora_os.imager';
const SRC = 'resources/icons';
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

rmSync('build-res/hicolor', { recursive: true, force: true });
rmSync('build-res/linux-icons', { recursive: true, force: true });
mkdirSync('build-res/linux-icons', { recursive: true });
copyFileSync(`${SRC}/roxora-imager.icns`, 'build-res/icon.icns');
copyFileSync(`${SRC}/roxora-imager.ico`, 'build-res/icon.ico');
copyFileSync(`${SRC}/png/roxora-imager-512.png`, 'build-res/icon.png');
for (const s of SIZES) {
  copyFileSync(`${SRC}/png/roxora-imager-${s}.png`, `build-res/linux-icons/${s}x${s}.png`);
  mkdirSync(`build-res/hicolor/${s}x${s}/apps`, { recursive: true });
  copyFileSync(`${SRC}/png/roxora-imager-${s}.png`, `build-res/hicolor/${s}x${s}/apps/${APP_ID}.png`);
}
mkdirSync('build-res/hicolor/scalable/apps', { recursive: true });
copyFileSync(`${SRC}/roxora-imager.svg`, `build-res/hicolor/scalable/apps/${APP_ID}.svg`);
mkdirSync('build-res/hicolor/symbolic/apps', { recursive: true });
copyFileSync(`${SRC}/roxora-imager-symbolic.svg`, `build-res/hicolor/symbolic/apps/${APP_ID}-symbolic.svg`);
console.log('icons in build-res/');
