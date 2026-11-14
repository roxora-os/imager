// Screenshots of the app's main steps, light and dark, at the default window
// size and at the minimum width. Runs the built app hidden with the sample
// catalog and stubs the drive list so no real disk appears in a picture.
//   node scripts/shots.mjs OUT_DIR
import { _electron as electron } from 'playwright-core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? 'dev/shots';
mkdirSync(out, { recursive: true });
// No question to GitHub about a newer app version either: the pictures must not depend on what is published.
const env = { ...process.env, ROXORA_IMAGER_HIDDEN: '1', ROXORA_IMAGER_SAMPLE: '1', ROXORA_IMAGER_FAKE_DRIVES: '1', ROXORA_IMAGER_FAKE_UPDATE: 'current' };
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
    if (w >= 768) await page.click('.vendor-list button:has-text("Radxa")');
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
// An image file on this computer that is in no release: chosen on the Board
// step (the app is told which file, there is no dialog to click here), shown
// on the Image step and on the review. Light theme, both window sizes.
for (const [w, h, tag] of [[1100, 760, 'd'], [720, 640, 'm']]) {
  const pick = join(mkdtempSync(join(tmpdir(), 'shots-')), 'my-own-build.img');
  writeFileSync(pick, Buffer.alloc(1024 * 1024, 1));
  const app = await electron.launch({ args: ['.', '--dev-sample'], env: { ...env, ROXORA_IMAGER_TEST_PICK: pick } });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`custom-${tag}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`custom-${tag} console: ${m.text()}`); });
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
  await page.evaluate(() => { localStorage.setItem('theme', 'light'); });
  await page.reload();
  await page.waitForSelector('h2:has-text("Board")');
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await page.waitForTimeout(400);
    const b64 = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    writeFileSync(`${out}/${name}-${tag}-light.png`, Buffer.from(b64, 'base64'));
  };
  await page.click('button:has-text("Use an image file on this computer")');
  // The wizard moves to the Image step by itself.
  await page.waitForSelector('h2:has-text("Image")');
  await page.waitForSelector('text=Not a Roxora release image');
  await page.waitForSelector('text=my-own-build.img, 1.0 MiB');
  await shot('2-image-custom');
  await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
  await page.waitForSelector('text=SanDisk');
  if (!(await page.isDisabled('#method-maskrom'))) throw new Error('Maskrom is offered for a custom image file');
  await page.click('text=SanDisk');
  await page.click('.pf-v6-c-wizard__footer button:has-text("Review")');
  await page.waitForSelector('text=It was not checked against one');
  if (await page.isDisabled('button:has-text("Erase and write")')) throw new Error('a custom image cannot be written from the review');
  await shot('4-review-custom');
  // A release image chosen after all: the custom file goes.
  // With Back: the step list is folded away in a narrow window.
  for (const step of ['Destination', 'Image', 'Board']) {
    await page.click('.pf-v6-c-wizard__footer button:has-text("Back")');
    await page.waitForSelector(`h2:has-text("${step}")`);
  }
  await page.fill('.board-search input', 'rock4d');
  await page.press('.board-search input', 'Enter');
  await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
  await page.waitForSelector('text=Images for');
  if (await page.locator('text=Not a Roxora release image').count()) throw new Error('the custom file stayed after a board was chosen');
  await shot('2-image-after-custom');
  await app.close();
}
// The update notice, the update dialog and the answers to "Check now" in the
// settings, with a made-up answer instead of GitHub (unpackaged builds only).
for (const [w, h, tag] of [[1100, 760, 'd'], [720, 640, 'm']]) {
  for (const fake of ['newer', 'current', 'error']) {
    const app = await electron.launch({ args: ['.', '--dev-sample'], env: { ...env, ROXORA_IMAGER_FAKE_UPDATE: fake } });
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(`update-${fake}-${tag}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`update-${fake}-${tag} console: ${m.text()}`); });
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
    await page.evaluate(() => { localStorage.setItem('theme', 'light'); localStorage.removeItem('updateDismissed'); });
    await page.reload();
    await page.waitForSelector('h2:has-text("Board")');
    const shot = async (name) => {
      await page.mouse.move(1, 1);
      await page.waitForTimeout(400);
      const b64 = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      writeFileSync(`${out}/${name}-${tag}-light.png`, Buffer.from(b64, 'base64'));
    };
    if (fake === 'newer') {
      await page.waitForSelector('text=Roxora Imager 9.9.9 is available');
      await shot('6-update-notice');
      await page.click('.update-notice button:has-text("Update")');
      await page.waitForSelector('#update-title');
      await page.waitForSelector('text=puts it in place of the AppImage you are running');
      await shot('6-update-dialog');
      // Nothing was downloaded: the dialog only says what would happen.
      await page.click('.pf-v6-c-modal-box__footer button:has-text("Cancel")');
    } else if (await page.locator('.update-notice').count()) {
      throw new Error(`an update notice is shown although the check said "${fake}"`);
    }
    await page.click('.pf-v6-c-masthead button:has-text("Settings")');
    await page.waitForSelector('#settings-title');
    await page.click('button:has-text("Check now")');
    await page.waitForSelector({ newer: 'text=Roxora Imager 9.9.9 is available.', current: 'text=You have the newest version (',
      error: 'text=Could not reach GitHub.' }[fake]);
    await shot(`5-settings-check-${fake}`);
    if (fake === 'newer') {
      // Closing the notice hides it; the settings still offer the version.
      await page.click('.pf-v6-c-modal-box__footer button:has-text("Close")');
      await page.click('.update-notice button[aria-label^="Close"]');
      await page.waitForSelector('.update-notice', { state: 'detached' });
    }
    await app.close();
  }
}
console.log(errors.length ? 'errors:\n' + errors.join('\n') : 'no page errors');
