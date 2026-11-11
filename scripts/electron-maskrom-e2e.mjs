// The Maskrom path inside the real Electron app, against a pretend board:
// app:// pages with COOP/COEP and CSP, the worker as a module, the WASM
// rkdeveloptool and its libusb WebUSB backend, synchronous Range reads of
// app://local/file/<token>, the read-back hash. Only navigator.usb is
// replaced (test/fake-rockchip.ts); everything else is the app's code.
//   node scripts/electron-maskrom-e2e.mjs
import { _electron as electron } from 'playwright-core';
import { build } from 'esbuild';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await build({ entryPoints: ['test/electron/fake-flash-worker.ts'], bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome130', outfile: 'build/renderer/fake-flash-worker.js', logLevel: 'warning' });
const dir = mkdtempSync(join(tmpdir(), 'maskrom-e2e-'));
const size = 20 * 1024 * 1024 + 4321;
const data = randomBytes(size);
writeFileSync(join(dir, 'image.img'), data);
const sha = createHash('sha256').update(data).digest('hex');
// The web build's path: the same image as a picked .img.xz, decompressed in
// the worker with edk2-webflash's xz decoder.
execFileSync('xz', ['-1', '-k', '--check=crc64', join(dir, 'image.img')]);

const env = { ...process.env, ROXORA_IMAGER_HIDDEN: '1', ROXORA_IMAGER_TEST_SERVE: join(dir, 'image.img'),
  ROXORA_IMAGER_TEST_SERVE_XZ: join(dir, 'image.img.xz') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], env });
let ok = false;
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const runOne = (picked) => page.evaluate(async ({ size, sha, picked }) => {
    // The app's own loader path: built from rkbin on first use, kept in the
    // user data folder, served at app://local/loader/.
    const loader = await window.imager.getLoader('rk3576_spl_loader.bin');
    if ('error' in loader) return { picked, loaderError: loader.error };
    const w = new Worker('fake-flash-worker.js', { type: 'module' });
    const stages = [];
    let lastWrite = -1;
    const result = await new Promise((resolve) => {
      w.onerror = (e) => resolve({ workerError: String(e.message ?? e.type) });
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'stage') stages.push(m.stage);
        if (m.type === 'progress' && m.stage === 'write') lastWrite = m.percent;
        if (m.type === 'result') resolve(m.result);
      };
      const o = location.origin;
      const go = (src) => w.postMessage({ type: 'start', moduleUrl: `${o}/wasm/rkdeveloptool.js`, wasmUrl: `${o}/wasm/rkdeveloptool.wasm`,
        loaderUrl: loader.url, xzWasmUrl: `${o}/resources/xzwasm/xzwasm.wasm`, size, sha256: sha,
        storageCode: 1, storageLabel: 'eMMC', verify: true, resetAfter: true, ...src });
      if (picked) {
        fetch(`${o}/file/xz`).then((r) => r.blob()).then((b) => go({ file: new File([b], 'image.img.xz') }));
      } else {
        go({ fileUrl: `${o}/file/test` });
      }
    });
    const dump = await new Promise((resolve) => {
      w.onmessage = (e) => { if (e.data.type === 'dump') resolve(e.data); };
      w.postMessage({ type: 'dump', storage: 1, size });
    });
    return { picked, crossOriginIsolated: self.crossOriginIsolated, result, stages, lastWrite, dump };
  }, { size, sha, picked });
  const check = (res) => res.result?.ok === true && res.result.verified === 'match' && res.dump.sha256 === sha && res.dump.resets === 1;
  const a = await runOne(false);
  console.log(JSON.stringify(a, null, 2));
  const b = await runOne(true);
  console.log(JSON.stringify(b, null, 2));
  ok = check(a) && check(b);
} finally {
  await app.close();
  rmSync('build/renderer/fake-flash-worker.js', { force: true });
  rmSync(dir, { recursive: true, force: true });
}
console.log(ok ? 'PASS: image written to the pretend eMMC through the Electron worker and verified, from a served file and from a picked .img.xz' : 'FAIL');
process.exit(ok ? 0 : 1);
