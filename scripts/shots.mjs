// Screenshots of the app's main steps, light and dark, at the default window
// size and at the minimum width. Runs the built app hidden with the sample
// catalog and stubs the drive list so no real disk appears in a picture.
//   node scripts/shots.mjs OUT_DIR
import { _electron as electron } from 'playwright-core';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const out = process.argv[2] ?? 'dev/shots';
mkdirSync(out, { recursive: true });
// No question to GitHub about a newer app version either: the pictures must not depend on what is published.
// Where "Save as an image file" saves, instead of the save dialog's answer.
const saveTo = join(mkdtempSync(join(tmpdir(), 'shots-save-')), 'roxora-radxa-rock-4d-noble-edge-2026.11.0.img');
const env = {
  ...process.env, ROXORA_IMAGER_HIDDEN: '1', ROXORA_IMAGER_SAMPLE: '1', ROXORA_IMAGER_FAKE_DRIVES: '1', ROXORA_IMAGER_FAKE_UPDATE: 'current',
  ROXORA_IMAGER_TEST_SAVE: saveTo,
};
delete env.ELECTRON_RUN_AS_NODE;
const errors = [];

for (const [w, h, tag] of [[1100, 760, 'd'], [720, 640, 'm']]) {
  for (const theme of ['light', 'dark']) {
    const app = await electron.launch({ args: ['.', '--dev-sample'], env });
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(`${tag}-${theme}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}-${theme} console: ${m.text()}`); });
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
    await page.evaluate((t) => { localStorage.setItem('theme', t); localStorage.setItem('lang', 'en'); }, theme);
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
    if (process.platform === 'linux') {
      // Built-in disks (Linux): the made-up board runs from its SD card
      // slot and has an eMMC and an NVMe drive. The switch shows the two
      // that hold nothing; the slot with / is never offered; choosing one
      // asks again, naming it.
      if (await page.locator('#drives >> text=A3A561').count()) throw new Error('a built-in disk is offered with the switch off');
      await page.click('label[for=show-internal]');
      await page.waitForSelector('#drives >> text=NVMe drive: Samsung SSD 980 500GB');
      await page.waitForSelector('#drives >> text=eMMC: A3A561');
      if (await page.locator('#drives >> text=SD64G').count()) throw new Error('the SD card slot the system runs from is offered');
      // The layout: the switch in the Drive header, in the window and above
      // the list; removable drives first, then built-in disks; sizes on one line.
      const layout = await page.evaluate(() => {
        const sw = document.querySelector('.show-internal').getBoundingClientRect();
        const table = document.querySelector('#drives').getBoundingClientRect();
        const devices = [...document.querySelectorAll('#drives tbody td[data-label="Device"]')].map((td) => td.textContent.trim());
        const sizeLines = [...document.querySelectorAll('#drives tbody td[data-label="Size"]')].map((td) => {
          const r = document.createRange();
          r.selectNodeContents(td);
          return new Set([...r.getClientRects()].map((c) => Math.round(c.top))).size;
        });
        return { swBottom: sw.bottom, swTop: sw.top, tableTop: table.top, height: window.innerHeight,
          width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, devices, sizeLines };
      });
      if (layout.swTop < 0 || layout.swBottom > layout.height) throw new Error(`the switch is outside the window: ${JSON.stringify(layout)}`);
      if (layout.swBottom > layout.tableTop) throw new Error(`the switch is not above the drive list: ${JSON.stringify(layout)}`);
      if (layout.scrollWidth > layout.width) throw new Error(`the page is wider than the window: ${JSON.stringify(layout)}`);
      const order = ['/dev/roxora-test-mmcblk0', '/dev/roxora-test-sdb', '/dev/roxora-test-mmcblk2', '/dev/roxora-test-nvme0n1'];
      if (JSON.stringify(layout.devices) !== JSON.stringify(order)) throw new Error(`drive order ${layout.devices.join(', ')}`);
      if (layout.sizeLines.some((n) => n !== 1)) throw new Error(`a size wraps: ${layout.sizeLines.join(', ')}`);
      console.log(`internal disks ${tag}-${theme}: ${layout.devices.join(', ')}; switch at ${Math.round(layout.swTop)}-${Math.round(layout.swBottom)} of ${layout.height}, list from ${Math.round(layout.tableTop)}`);
      await shot('3-destination-internal');
      await page.click('#drives >> text=eMMC: A3A561');
      await page.waitForSelector('#internal-title');
      // has-text, not text=: a text= starting with / is read as a regular expression.
      await page.waitForSelector('.pf-v6-c-modal-box__body:has-text("/dev/roxora-test-mmcblk2 is the built-in eMMC of this computer")');
      await shot('3-destination-internal-confirm');
      await page.click('.pf-v6-c-modal-box__footer button:has-text("Cancel")');
      await page.click('label[for=show-internal]');
      await page.waitForSelector('#drives >> text=SanDisk');
    }
    await page.click('text=SanDisk');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Review")');
    await shot('4-review');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Back")');
    await page.click('label[for=method-maskrom]');
    await shot('3-destination-maskrom');
    await page.locator('#src-spi').scrollIntoViewIfNeeded();
    await shot('3-destination-maskrom-source');
    // The live line: no board, then a pretend RK3576 in Maskrom mode.
    await page.locator('#maskrom-live').scrollIntoViewIfNeeded();
    await shot('3-destination-maskrom-none');
    await page.evaluate(() => {
      navigator.usb.getDevices = async () => [{ vendorId: 0x2207, productId: 0x350e, opened: false, open: async () => {}, close: async () => {} }];
    });
    await page.waitForSelector('#maskrom-live.pf-m-success');
    await page.locator('#maskrom-live').scrollIntoViewIfNeeded();
    await shot('3-destination-maskrom-connected');
    await page.evaluate(() => { delete navigator.usb.getDevices; });
    // Save as an image file: the third choice, then a place to save (the
    // app is told where; there is no dialog to click here), then the review.
    await page.click('label[for=method-file]');
    await page.waitForSelector('text=No place chosen');
    await page.locator('h2:has-text("Destination")').scrollIntoViewIfNeeded();
    await shot('3-destination-file');
    await page.click('button:has-text("Choose where to save")');
    await page.waitForSelector(`.file-row:has-text("${saveTo}")`);
    await shot('3-destination-file-chosen');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Review")');
    await page.waitForSelector('h2:has-text("Review")');
    if (await page.locator('text=will be erased').count()) throw new Error('the review of a save says something will be erased');
    if (!(await page.locator('.pf-v6-c-wizard__footer button:has-text("Save")').count())) throw new Error('the review of a save has no Save button');
    await page.waitForSelector('text=Sample data cannot be saved.');
    await shot('4-review-file');
    await page.click('.pf-v6-c-masthead button:has-text("Settings")');
    await page.waitForSelector('#settings-title');
    await shot('5-settings');
    await page.click('#about-open');
    await page.waitForSelector('#about-title');
    await shot('5-about');
    await app.close();
  }
}

// The Maskrom destination as Windows shows it: the WinUSB driver steps with Zadig.
{
  const app = await electron.launch({ args: ['.', '--dev-sample'], env: { ...env, ROXORA_IMAGER_SHOW_PLATFORM: 'win32' } });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`windows: ${e.message}`));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 760));
  await page.evaluate(() => { localStorage.setItem('theme', 'light'); localStorage.setItem('lang', 'en'); });
  await page.reload();
  await page.waitForSelector('h2:has-text("Board")');
  await page.fill('.board-search input', 'rock4d');
  await page.press('.board-search input', 'Enter');
  await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
  await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
  await page.click('label[for=method-maskrom]');
  await page.locator('#zadig-steps').scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  const b64 = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(`${out}/3-destination-maskrom-windows-d-light.png`, Buffer.from(b64, 'base64'));
  await app.close();
}
// Clear cache with a loader built and no image downloaded: only the loader
// is listed (a data folder of its own, through XDG_CONFIG_HOME).
{
  const config = mkdtempSync(join(tmpdir(), 'shots-config-'));
  mkdirSync(join(config, 'Roxora Imager', 'loaders'), { recursive: true });
  writeFileSync(join(config, 'Roxora Imager', 'loaders', 'rk3576_spl_loader.bin'), Buffer.alloc(300000, 1));
  const app = await electron.launch({ args: ['.', '--dev-sample'], env: { ...env, XDG_CONFIG_HOME: config } });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`clear-cache: ${e.message}`));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 760));
  await page.evaluate(() => { localStorage.setItem('theme', 'light'); localStorage.setItem('lang', 'en'); });
  await page.reload();
  await page.waitForSelector('h2:has-text("Board")');
  await page.click('.pf-v6-c-masthead button:has-text("Settings")');
  await page.click('#clear-cache');
  await page.waitForSelector('#clear-title');
  // Only the dialog's list: the settings behind it name both kinds in a sentence.
  const listed = await page.locator('.pf-v6-c-modal-box:has(#clear-title) li').allInnerTexts();
  if (listed.length !== 1 || !listed[0].startsWith('Maskrom loaders built from rkbin')) throw new Error(`Clear cache lists: ${JSON.stringify(listed)}`);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  const b64 = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(`${out}/5-clear-cache-loader-only-d-light.png`, Buffer.from(b64, 'base64'));
  await app.close();
}
// The empty state: no releases (GitHub API answered with an empty list).
{
  const app = await electron.launch({ args: ['.'], env: { ...env, ROXORA_IMAGER_SAMPLE: '0', ROXORA_IMAGER_FAKE_RELEASES: 'none' } });
  const page = await app.firstWindow();
  await page.evaluate(() => { localStorage.setItem('theme', 'light'); localStorage.setItem('lang', 'en'); });
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
  await page.evaluate(() => { localStorage.setItem('theme', 'light'); localStorage.setItem('lang', 'en'); });
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
// Saving an image file for real: a gzip-compressed custom image on this
// computer, saved decompressed through the app (main process, no writer, no
// administrator rights). The file must hold the image and nothing else may
// be left in the folder. Both sizes, both themes.
for (const [w, h, tag] of [[1100, 760, 'd'], [720, 640, 'm']]) {
  for (const theme of ['light', 'dark']) {
    const data = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 4) data.writeUInt32LE(i, i);
    const pick = join(mkdtempSync(join(tmpdir(), 'shots-')), 'my-own-build.img.gz');
    writeFileSync(pick, gzipSync(data));
    const dir = mkdtempSync(join(tmpdir(), 'shots-saved-'));
    const dest = join(dir, 'my-own-build.img');
    const app = await electron.launch({ args: ['.', '--dev-sample'], env: { ...env, ROXORA_IMAGER_TEST_PICK: pick, ROXORA_IMAGER_TEST_SAVE: dest } });
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(`save-${tag}-${theme}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`save-${tag}-${theme} console: ${m.text()}`); });
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
    await page.evaluate((t) => { localStorage.setItem('theme', t); localStorage.setItem('lang', 'en'); }, theme);
    await page.reload();
    await page.waitForSelector('h2:has-text("Board")');
    const shot = async (name) => {
      await page.mouse.move(1, 1);
      await page.waitForTimeout(400);
      const b64 = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      writeFileSync(`${out}/${name}-${tag}-${theme}.png`, Buffer.from(b64, 'base64'));
    };
    await page.click('button:has-text("Use an image file on this computer")');
    await page.waitForSelector('text=Not a Roxora release image');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
    await page.waitForSelector('h2:has-text("Destination")');
    await page.click('label[for=method-file]');
    await page.click('button:has-text("Choose where to save")');
    await page.waitForSelector(`.file-row:has-text("${dest}")`);
    await page.click('.pf-v6-c-wizard__footer button:has-text("Review")');
    await page.waitForSelector('h2:has-text("Review")');
    await shot('4-review-file-custom');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Save")');
    await page.waitForSelector('h2:has-text("Done"), h2:has-text("Stopped")', { timeout: 60000 });
    if (await page.locator('h2:has-text("Stopped")').count()) {
      throw new Error(`the save stopped: ${await page.locator('.pf-v6-c-alert').first().innerText()}`);
    }
    await page.waitForSelector('button:has-text("Show in folder")');
    await shot('7-saved-file');
    const saved = readFileSync(dest);
    if (!saved.equals(data)) throw new Error(`the saved file is not the image (${saved.length} bytes, ${data.length} expected)`);
    const left = readdirSync(dir);
    if (left.length !== 1) throw new Error(`the save left more than the file: ${left.join(', ')}`);
    const sha = createHash('sha256').update(data).digest('hex');
    if (!(await page.locator(`text=${sha}`).count())) throw new Error('the result does not give the SHA-256 of the saved image');
    console.log(`save ${tag}-${theme}: ${dest} holds the ${data.length} bytes of the image, SHA-256 ${sha}; nothing else in ${dir}`);
    await app.close();
  }
}
// A save that fails (the folder cannot be written): the run page offers
// Try again, Back to the steps and Report a problem. Report a problem must
// open a roxora-os/imager issue with nothing of the home folder in it; the
// main process is told to collect the link instead of opening a browser.
for (const [w, h, tag] of [[1100, 760, 'd'], [720, 640, 'm']]) {
  for (const theme of ['light', 'dark']) {
    const pick = join(mkdtempSync(join(tmpdir(), 'shots-')), 'my-own-build.img.gz');
    writeFileSync(pick, gzipSync(Buffer.alloc(1024 * 1024, 7)));
    const dir = mkdtempSync(join(tmpdir(), 'shots-readonly-'));
    chmodSync(dir, 0o555);
    const app = await electron.launch({ args: ['.', '--dev-sample'], env: { ...env, ROXORA_IMAGER_TEST_PICK: pick, ROXORA_IMAGER_TEST_SAVE: join(dir, 'my-own-build.img') } });
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(`save-failed-${tag}-${theme}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`save-failed-${tag}-${theme} console: ${m.text()}`); });
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
    await page.evaluate((t) => { localStorage.setItem('theme', t); localStorage.setItem('lang', 'en'); }, theme);
    await page.reload();
    await page.waitForSelector('h2:has-text("Board")');
    const shot = async (name) => {
      await page.mouse.move(1, 1);
      await page.waitForTimeout(400);
      const b64 = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      writeFileSync(`${out}/${name}-${tag}-${theme}.png`, Buffer.from(b64, 'base64'));
    };
    await page.click('button:has-text("Use an image file on this computer")');
    await page.waitForSelector('text=Not a Roxora release image');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Next")');
    await page.waitForSelector('h2:has-text("Destination")');
    await page.click('label[for=method-file]');
    await page.click('button:has-text("Choose where to save")');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Review")');
    await page.waitForSelector('h2:has-text("Review")');
    await page.click('.pf-v6-c-wizard__footer button:has-text("Save")');
    await page.waitForSelector('h2:has-text("Stopped")', { timeout: 60000 });
    for (const b of ['#try-again', '#back-to-steps', '#report-problem']) {
      if (!(await page.locator(b).count())) throw new Error(`a failed save does not offer ${b}`);
    }
    await shot('7-save-failed');
    if (tag === 'd' && theme === 'light') {
      const caught = await app.evaluate(({ shell }) => {
        try {
          globalThis.openedLinks = [];
          shell.openExternal = async (u) => { globalThis.openedLinks.push(u); };
          return true;
        } catch { return false; }
      });
      if (caught) {
        await page.click('#report-problem');
        await page.waitForTimeout(500);
        const links = await app.evaluate(() => globalThis.openedLinks);
        const link = links[0] ?? '';
        if (!link.startsWith('https://github.com/roxora-os/imager/issues/new?')) throw new Error(`Report a problem opened "${link}"`);
        const body = new URL(link).searchParams.get('body') ?? '';
        if (body.includes(homedir())) throw new Error('the problem report holds the home folder');
        if (!body.includes('Destination: an image file')) throw new Error(`the problem report does not say what was written:\n${body}`);
        console.log(`Report a problem: ${link.length} characters, title "${new URL(link).searchParams.get('title')}"`);
      } else {
        console.log('Report a problem: shell.openExternal could not be replaced here, link not checked');
      }
      // Try again: the same save once more, and the same failure.
      await page.click('#try-again');
      await page.waitForSelector('h2:has-text("Stopped")', { timeout: 60000 });
      // Back to the steps: the review, with every choice kept.
      await page.click('#back-to-steps');
      await page.waitForSelector('h2:has-text("Review")');
      if (!(await page.locator(`text=${join(dir, 'my-own-build.img')}`).count())) throw new Error('Back to the steps lost the place to save');
      await shot('7-save-failed-back');
    }
    await app.close();
    chmodSync(dir, 0o755);
  }
}
// The update notice, the update dialog and the answers to "Check now" in the
// settings, with a made-up answer instead of GitHub (unpackaged builds only).
for (const [w, h, tag] of [[1100, 760, 'd'], [720, 640, 'm']]) {
  for (const fake of ['newer', 'current', 'error', 'brew', 'apt']) {
    const app = await electron.launch({ args: ['.', '--dev-sample'], env: { ...env, ROXORA_IMAGER_FAKE_UPDATE: fake } });
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(`update-${fake}-${tag}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`update-${fake}-${tag} console: ${m.text()}`); });
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
    await page.evaluate(() => { localStorage.setItem('theme', 'light'); localStorage.setItem('lang', 'en'); localStorage.removeItem('updateDismissed'); });
    await page.reload();
    await page.waitForSelector('h2:has-text("Board")');
    const shot = async (name) => {
      await page.mouse.move(1, 1);
      await page.waitForTimeout(400);
      const b64 = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      writeFileSync(`${out}/${name}-${tag}-light.png`, Buffer.from(b64, 'base64'));
    };
    if (fake === 'brew') {
      // A Homebrew install: the plan, then (no Homebrew here) the command to
      // copy. The Copy button must really fill the clipboard.
      await page.waitForSelector('text=Roxora Imager 9.9.9 is available');
      await page.click('.update-notice button:has-text("Update")');
      await page.waitForSelector('text=runs Homebrew for you');
      await shot('6-update-brew');
      await app.evaluate(({ clipboard }) => clipboard.writeText('something else'));
      await page.click('button:has-text("Update with Homebrew")');
      await page.waitForSelector('text=Homebrew was not found on this Mac');
      await page.click('.copy-button');
      await page.waitForSelector('.copy-button:has-text("Copied")');
      const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
      if (copied !== 'brew upgrade --cask roxora-imager') throw new Error(`the Copy button put "${copied}" on the clipboard`);
      console.log(`Copy button: the clipboard holds "${copied}"`);
      // At once: the button says "Copied" only for a moment.
      const b64 = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      writeFileSync(`${out}/6-update-brew-copied-${tag}-light.png`, Buffer.from(b64, 'base64'));
      await app.close();
      continue;
    }
    if (fake === 'apt') {
      // A .deb from an apt repository (a Roxora system): the app says the
      // version is out and that apt brings it, and offers no download.
      await page.waitForSelector('text=Roxora Imager 9.9.9 is available');
      await page.click('.update-notice button:has-text("Update")');
      await page.waitForSelector("text=the system's software updates keep it up to date");
      await page.waitForSelector('text=sudo apt update && sudo apt install --only-upgrade roxora-imager');
      if (await page.locator('.pf-v6-c-modal-box__footer button:has-text("Download and install")').count()) {
        throw new Error('the update dialog offers a download for a copy apt updates');
      }
      await shot('6-update-apt');
      await app.close();
      continue;
    }
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
// Simplified Chinese: the board step, the Maskrom destination, Settings
// and the language dialog. CI installs a CJK font for these (ci.yml).
{
  const app = await electron.launch({ args: ['.', '--dev-sample'], env });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`zh-CN: ${e.message}`));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 760));
  await page.evaluate(() => { localStorage.setItem('theme', 'light'); localStorage.setItem('lang', 'zh-CN'); });
  await page.reload();
  await page.waitForSelector('h2:has-text("开发板")');
  await page.waitForTimeout(800);
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await page.waitForTimeout(400);
    const b64 = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    writeFileSync(`${out}/${name}-zh-CN.png`, Buffer.from(b64, 'base64'));
  };
  await shot('1-board');
  await page.fill('.board-search input', 'cm5');
  await page.press('.board-search input', 'Enter');
  await page.click('.pf-v6-c-wizard__footer button.pf-m-primary');
  await page.click('.pf-v6-c-wizard__footer button.pf-m-primary');
  await page.click('label[for=method-maskrom]');
  await page.waitForSelector('text=写入内容');
  await shot('3-destination-maskrom');
  await page.locator('#maskrom-live').scrollIntoViewIfNeeded();
  await shot('3-destination-maskrom-live');
  await page.click('.pf-v6-c-masthead button:has-text("设置")');
  await page.waitForSelector('#settings-title');
  await shot('5-settings');
  await page.click('.pf-v6-c-modal-box__footer button:has-text("关闭")');
  await page.click('.pf-v6-c-masthead button[aria-label="显示语言"]');
  await page.waitForSelector('#lang-dialog');
  await shot('7-language');
  // Back to English from the dialog: the page follows at once.
  await page.click('#lang-dialog >> text=English');
  await page.click('#lang-dialog button:has-text("选择")');
  await page.waitForSelector('h2:has-text("Destination")');
  await app.close();
}
console.log(errors.length ? 'errors:\n' + errors.join('\n') : 'no page errors');
