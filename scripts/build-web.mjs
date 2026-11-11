// Build the web version into web-dist/: the same page and Maskrom worker as
// the desktop app, with the browser adapter (src/web/api.ts) instead of
// Electron's preload. Served from https://roxora-os.github.io/imager/, so
// every path is relative.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const out = 'web-dist';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/resources/xzwasm`, { recursive: true });

const web = { bundle: true, platform: 'browser', target: 'chrome120', format: 'esm', minify: true, logLevel: 'warning' };
await build({
  ...web, entryPoints: { app: 'src/web/main.tsx' }, outdir: out,
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file', '.jpg': 'file' },
  assetNames: 'assets/[name]-[hash]', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: JSON.stringify(version) },
});
await build({ ...web, entryPoints: { 'maskrom-worker': 'src/maskrom/worker.ts' }, outdir: out });
cpSync('src/web/index.html', `${out}/index.html`);
cpSync('src/web/coi-serviceworker.js', `${out}/coi-serviceworker.js`);
cpSync('src/renderer/theme.js', `${out}/theme.js`);
for (const f of ['rk3576_spl_loader.bin', 'roxora-mark.svg', 'sample-catalog.json', 'xzwasm/xzwasm.wasm']) {
  cpSync(`resources/${f}`, `${out}/resources/${f}`);
}
if (!existsSync('vendor/rkdeveloptool-wasm/rkdeveloptool.wasm')) {
  console.error('vendor/rkdeveloptool-wasm/ is missing: run scripts/build-wasm.sh');
  process.exit(1);
}
mkdirSync(`${out}/wasm`, { recursive: true });
cpSync('vendor/rkdeveloptool-wasm/rkdeveloptool.js', `${out}/wasm/rkdeveloptool.js`);
cpSync('vendor/rkdeveloptool-wasm/rkdeveloptool.wasm', `${out}/wasm/rkdeveloptool.wasm`);
console.log(`web build in ${out}/`);
