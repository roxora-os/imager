// Screenshots of the app's main steps, light and dark, at the default window
// size and at the minimum width. Runs the built app hidden with the sample
// catalog and stubs the drive list so no real disk appears in a picture.
//   node scripts/shots.mjs OUT_DIR
import { _electron as electron } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'dev/shots';
mkdirSync(out, { recursive: true });
const env = { ...process.env, ROXORA_IMAGER_HIDDEN: '1', ROXORA_IMAGER_SAMPLE: '1', ROXORA_IMAGER_FAKE_DRIVES: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [];

for (const [w, h, tag] of [[1100, 760, 'd'], [720, 640, 'm']]) {
  for (const theme of ['light', 'dark']) {
    const app = await electron.launch({ args: ['.', '--dev-sample'], env });
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(`${tag}-${theme}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}-${theme} console: ${m.text()}`); });
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
    await page.evaluate((t) => { localStorage.setItem('theme', t); }, theme);
    await page.reload();
    await page.waitForSelector('h2:has-text("Board")');
    await page.waitForTimeout(800);
    const shot = async (name) => {
      await page.mouse.move(1, 1); // no hover highlight in the pictures
      await page.waitForTimeout(400);
      // The window is hidden, so Playwright cannot screenshot it; ask Electron.
      const b64 = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      writeFileSync(`${out}/${name}-${tag}-${theme}.png`, Buffer.from(b64, 'base64'));
    };
    await shot('1-board');
    // A vendor selected: the menu on wide windows, the select on narrow ones.
    if (w >= 768) await page.click('.vendor-pane button:has-text("Radxa")');
    else await page.selectOption('.vendor-select select', 'Radxa');
    await shot('1-board-vendor');
    await page.fill('.board-search input', 'rock 4d');
    await shot('1-board-search');
    await page.fill('.board-search input', 'pinebook');
    await shot('1-board-search-none');
    await page.fill('.board-search input', 'rock4d');
    await page.press('.board-search input', 'Enter');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
    await shot('2-image');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
    await page.waitForSelector('text=SanDisk');
    await shot('3-destination-sd');
    await page.click('text=SanDisk');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Review")');
    await shot('4-review');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Back")');
    await page.click('label[for=method-maskrom]');
    await shot('3-destination-maskrom');
    await page.locator('#src-spi').scrollIntoViewIfNeeded();
    await shot('3-destination-maskrom-source');
    await page.click('.pf-v6-c-masthead button:has-text("Settings")');
    await page.waitForSelector('#settings-title');
    await shot('5-settings');
    await app.close();
  }
}

// The empty state: no releases (GitHub API answered with an empty list).
{
  const app = await electron.launch({ args: ['.'], env: { ...env, ROXORA_IMAGER_SAMPLE: '0', ROXORA_IMAGER_FAKE_RELEASES: 'none' } });
  const page = await app.firstWindow();
  await page.evaluate(() => { localStorage.setItem('theme', 'light'); });
  await page.reload();
  await page.waitForSelector('text=No Roxora releases yet');
  await page.waitForTimeout(500);
  const b64 = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(`${out}/0-no-releases-d-light.png`, Buffer.from(b64, 'base64'));
  await app.close();
}
console.log(errors.length ? 'errors:\n' + errors.join('\n') : 'no page errors');
