// Render the app icon from roxora-os/design's avatar (resources/roxora-avatar.svg,
// copied unchanged) into build-res/icon.png for electron-builder, and the
// hicolor PNGs the Linux packages install. Nothing generated is committed.
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync('resources/roxora-avatar.svg');
const render = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
mkdirSync('build-res', { recursive: true });
writeFileSync('build-res/icon.png', render(1024));
for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) {
  mkdirSync(`build-res/hicolor/${s}x${s}/apps`, { recursive: true });
  writeFileSync(`build-res/hicolor/${s}x${s}/apps/roxora-imager.png`, render(s));
}
console.log('icons in build-res/');
