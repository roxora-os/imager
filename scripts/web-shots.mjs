// Screenshots of the web build (web-dist/), served under /imager/ as on
// GitHub Pages, in an Electron window used as a plain browser (no app
// code): the board step, the destination step and the review, light and
// dark, 1920, 2560 and 390 px wide. Also reports whether the page became
// cross-origin isolated through coi-serviceworker.js.
//   node scripts/web-shots.mjs OUT_DIR
import { _electron as electron } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const out = process.argv[2] ?? 'dev/web-shots';
mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.bin': 'application/octet-stream' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/imager/')) { res.writeHead(404).end(); return; }
  let p = normalize(join('web-dist', decodeURIComponent(url.pathname.slice('/imager/'.length)) || 'index.html'));
  try { if (statSync(p).isDirectory()) p = join(p, 'index.html'); res.writeHead(200, { 'Content-Type': TYPES[extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/imager/`;

const dir = mkdtempSync(join(tmpdir(), 'webshots-'));
writeFileSync(join(dir, 'main.cjs'), "const { app } = require('electron'); app.whenReady(); app.on('window-all-closed', () => {});\n");
const small = join(dir, 'bootloader.img');
writeFileSync(small, Buffer.alloc(1 << 20, 7));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [];
const facts = {};

for (const [w, h, tag] of [[1920, 1080, 'w'], [2560, 1440, 'x'], [390, 844, 'p']]) {
  for (const theme of ['light', 'dark']) {
    const app = await electron.launch({ args: [join(dir, 'main.cjs')], env });
    await app.evaluate(async ({ app: a, BrowserWindow }, [w, h]) => {
      await a.whenReady();
      const win = new BrowserWindow({ width: w, height: h, show: false, webPreferences: { offscreen: true } });
      win.setContentSize(w, h);
      await win.loadURL('about:blank');
    }, [w, h]);
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(`${tag}-${theme}: ${e.message}`));
    await page.goto(`${base}?sample=1`);
    // The first visit registers coi-serviceworker.js and reloads once.
    for (let i = 0; i < 10; i++) {
      try { await page.waitForFunction(() => self.crossOriginIsolated, null, { timeout: 3000 }); break; } catch { /* reloading */ }
    }
    await page.evaluate((t) => { localStorage.setItem('theme', t); }, theme);
    await page.reload();
    await page.waitForSelector('h2:has-text("Board")', { timeout: 30000 });
    facts[`${tag}-${theme}`] = await page.evaluate(() => ({ isolated: self.crossOriginIsolated, sw: !!navigator.serviceWorker?.controller }));
    const shot = async (name) => {
      await page.mouse.move(1, 1);
      await page.waitForTimeout(500);
      const b64 = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      writeFileSync(`${out}/${name}-${tag}-${theme}.png`, Buffer.from(b64, 'base64'));
    };
    await shot('1-board');
    await page.click('text=Radxa ROCK 4D');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
    await page.waitForSelector('h2:has-text("Destination")');
    await shot('2-destination');
    const chooser = page.waitForEvent('filechooser');
    await page.click('label[for=src-file]');
    await page.click('button:has-text("Choose file")');
    await (await chooser).setFiles(small);
    await page.waitForSelector('text=bootloader.img');
    await page.locator('#src-file').scrollIntoViewIfNeeded();
    await shot('2-destination-file');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Review")');
    await shot('3-review');
    await app.close();
  }
}
// The write itself, which sample data never reaches: the catalog mirror is
// answered with the sample entries minus their sample mark, a small file is
// picked, and the board picker is answered without a board, so the worker
// starts and then stops because no board is there. Screenshots only.
const sample = JSON.parse(readFileSync('resources/sample-catalog.json', 'utf8'));
delete sample._sample;
const fakeIndex = { schema: 1, releases: [{ tag: sample.release.tag, catalog: 'https://roxora-os.github.io/catalog/shots.json' }] };
for (const [w, h, tag] of [[1920, 1080, 'w'], [390, 844, 'p']]) {
  for (const theme of ['light', 'dark']) {
    const app = await electron.launch({ args: [join(dir, 'main.cjs')], env });
    await app.evaluate(async ({ app: a, BrowserWindow, session, net }, [w, h, index, catalog]) => {
      await a.whenReady();
      const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
      session.defaultSession.protocol.handle('https', (req) => {
        if (req.url === 'https://roxora-os.github.io/catalog/index.json') return new Response(index, { headers: cors });
        if (req.url === 'https://roxora-os.github.io/catalog/shots.json') return new Response(catalog, { headers: cors });
        if (req.url.startsWith('https://api.github.com/')) return new Response('{}', { status: 503, headers: cors });
        return net.fetch(req, { bypassCustomProtocolHandlers: true });
      });
      const win = new BrowserWindow({ width: w, height: h, show: false, webPreferences: { offscreen: true } });
      win.setContentSize(w, h);
      await win.loadURL('about:blank');
    }, [w, h, JSON.stringify(fakeIndex), JSON.stringify(sample)]);
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(`run ${tag}-${theme}: ${e.message}`));
    await page.goto(base);
    for (let i = 0; i < 10; i++) {
      try { await page.waitForFunction(() => self.crossOriginIsolated, null, { timeout: 3000 }); break; } catch { /* reloading */ }
    }
    await page.evaluate((t) => { localStorage.setItem('theme', t); }, theme);
    await page.reload();
    await page.waitForSelector('h2:has-text("Board")', { timeout: 30000 });
    const shot = async (name) => {
      await page.mouse.move(1, 1);
      await page.waitForTimeout(500);
      const b64 = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      writeFileSync(`${out}/${name}-${tag}-${theme}.png`, Buffer.from(b64, 'base64'));
    };
    await page.click('text=Radxa ROCK 4D');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
    const chooser = page.waitForEvent('filechooser');
    await page.click('label[for=src-file]');
    await page.click('button:has-text("Choose file")');
    await (await chooser).setFiles(small);
    await page.waitForSelector('text=bootloader.img');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Review")');
    await page.evaluate(() => { navigator.usb.requestDevice = async () => ({}); });
    await page.click('.pf-v6-c-wizard__footer button:has-text("Erase and write")');
    await shot('4-confirm');
    await page.click('.pf-v6-c-modal-box button:has-text("Erase and write")');
    await page.waitForSelector('h2:has-text("Writing")');
    await shot('5-writing');
    await page.waitForSelector('h2:has-text("Stopped"), h2:has-text("Done")', { timeout: 60000 }).catch(() => {});
    await shot('5-stopped');
    await app.close();
  }
}
server.close();
console.log(JSON.stringify(facts));
console.log(errors.length ? 'errors:\n' + errors.join('\n') : 'no page errors');
