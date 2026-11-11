// Build the web version into web-dist/: the same page and Maskrom worker as
// the desktop app, with the browser adapter (src/web/api.ts) instead of
// Electron's preload. Served from https://roxora-os.github.io/imager/, so
// every path is relative.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const out = 'web-dist';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
rmSync(out, { recursive: true, force: true });

// Has the desktop app been released? Decides where "desktop app" links go.
// pages.yml rebuilds when a release is published.
let hasRelease = false;
try {
  const r = await fetch('https://api.github.com/repos/roxora-os/imager/releases?per_page=1',
    { headers: { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  if (r.ok) hasRelease = (await r.json()).some((x) => !x.draft);
} catch { /* offline: link to the install notes */ }
console.log(`desktop app released: ${hasRelease}`);
// The Roxora download proxy (worker/), e.g. https://roxora-download.<account>.workers.dev.
// Empty: the user downloads release files and chooses them.
const downloadProxy = (process.env.ROXORA_DOWNLOAD_PROXY ?? '').trim();
console.log(`download proxy: ${downloadProxy || 'none'}`);
mkdirSync(`${out}/resources/xzwasm`, { recursive: true });

const web = { bundle: true, platform: 'browser', target: 'chrome120', format: 'esm', minify: true, logLevel: 'warning' };
await build({
  ...web, entryPoints: { app: 'src/web/main.tsx' }, outdir: out,
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file', '.jpg': 'file' },
  assetNames: 'assets/[name]-[hash]', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: JSON.stringify(version), __APP_HAS_RELEASE__: JSON.stringify(hasRelease), __DOWNLOAD_PROXY__: JSON.stringify(downloadProxy) },
});
await build({ ...web, entryPoints: { 'maskrom-worker': 'src/maskrom/worker.ts' }, outdir: out });
cpSync('src/web/index.html', `${out}/index.html`);
cpSync('src/web/coi-serviceworker.js', `${out}/coi-serviceworker.js`);
cpSync('src/renderer/theme.js', `${out}/theme.js`);
// Rockchip's loader is not copied: the page builds it from rkbin (src/maskrom/loaders.ts).
for (const f of ['roxora-mark.svg', 'sample-catalog.json', 'xzwasm/xzwasm.wasm']) {
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
