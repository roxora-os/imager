// Render the DMG window background (1x and 2x) from packaging/dmg/background.svg.
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';

const out = process.argv[2] ?? '.';
const svg = readFileSync('packaging/dmg/background.svg');
for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']]) {
  const png = new Resvg(svg, { fitTo: { mode: 'zoom', value: scale }, font: { loadSystemFonts: true } }).render().asPng();
  writeFileSync(`${out}/${name}`, png);
}
