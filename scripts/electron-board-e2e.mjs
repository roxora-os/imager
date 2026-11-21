// Running on the board, inside the real Electron app, against pretend
// boards (scripts/lib/pretend-board.mjs: folders laid out like /proc and
// /sys, given as ROXORA_IMAGER_FAKE_ROOT). For each: what the main process
// finds (eMMC by its card type, SPI NOR as an MTD device, the board by its
// device tree or SMBIOS name), what the page offers and refuses, the review,
// and a write that the main process refuses before anything is downloaded
// or elevated: nothing is ever written while the root is pretend. Without a
// pretend root this computer is no board, and This board is not offered.
//   node scripts/electron-board-e2e.mjs     (after npm run build)
import { _electron as electron } from 'playwright-core';
import { PRETEND } from './lib/pretend-board.mjs';

const base = { ...process.env, ROXORA_IMAGER_HIDDEN: '1', ROXORA_IMAGER_SAMPLE: '1', ROXORA_IMAGER_FAKE_DRIVES: '1', ROXORA_IMAGER_FAKE_UPDATE: 'current' };
delete base.ELECTRON_RUN_AS_NODE;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
const next = '.pf-v6-c-wizard__footer button.pf-m-primary';

async function withApp(root, fn) {
  const env = { ...base, ...(root ? { ROXORA_IMAGER_FAKE_ROOT: root } : {}) };
  const app = await electron.launch({ args: ['.', '--dev-sample'], env });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.evaluate(() => { localStorage.setItem('lang', 'en'); localStorage.setItem('theme', 'light'); });
    await page.reload();
    await page.waitForSelector('h2:has-text("Board")');
    const images = await page.evaluate(async () => {
      const c = await window.imager.loadCatalog({ sample: true });
      return Object.fromEntries(c.images.map((i) => [i.board, i.id]));
    });
    await fn(page, images);
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
  } finally {
    await app.close();
  }
}

console.log('-- ArmSoM CM5-IO running from an SD card: its eMMC');
await withApp(PRETEND.cm5io(), async (page, img) => {
  const h = await page.evaluate(() => window.imager.boardHere());
  check(h.boardId === 'armsom-cm5-io' && h.emmc?.device === '/dev/mmcblk1' && h.emmc?.model === 'A3A561' && h.emmcRefusal === null
    && JSON.stringify(h.storages) === '["emmc"]', `boardHere: ${JSON.stringify({ id: h.boardId, emmc: h.emmc, refusal: h.emmcRefusal, storages: h.storages })}`);
  await page.waitForSelector('text=This is the ArmSoM CM5-IO');
  check(await page.locator('tr.pf-m-selected:has-text("ArmSoM CM5-IO")').count() === 1, 'the board is chosen for you');
  await page.click(next);
  await page.click(next);
  await page.waitForSelector('#method-here');
  check(await page.isChecked('#method-here') && await page.isChecked('#here-emmc') && !(await page.isDisabled('#here-emmc')),
    'Destination: This board, its eMMC, chosen');
  check(await page.locator('#here-spinor').count() === 0, 'no SPI NOR flash offered on a board the list gives none');
  await page.click(next);
  await page.waitForSelector('h2:has-text("Review")');
  check(await page.locator('text=This board\'s eMMC (A3A561, /dev/mmcblk1').count() === 1, 'the review names the eMMC');
  check(await page.locator('text=will be erased').count() === 1, 'the review says it will be erased');
  // The sample catalog is never written from the page; the main process is asked directly.
  check(await page.isDisabled('.pf-v6-c-wizard__footer button:has-text("Erase and write")')
    && await page.locator('text=Sample data cannot be written.').count() === 1, 'sample data: the page writes nothing');
  const r = (await page.evaluate((id) => window.imager.writeBoard({ kind: 'emmc', imageId: id, device: '/dev/mmcblk1' }), img['armsom-cm5-io'])).reason;
  check(/pretend board/.test(r) && /Nothing was written/.test(r), `the right request stops at the main process: ${r}`);
  const other = await page.evaluate((id) => window.imager.writeBoard({ kind: 'emmc', imageId: id, device: '/dev/mmcblk1' }), img['radxa-rock-4d']);
  check(!other.ok && /not the Radxa ROCK 4D/.test(other.reason), `another board's image: ${other.reason}`);
  const sd = await page.evaluate((id) => window.imager.writeBoard({ kind: 'emmc', imageId: id, device: '/dev/mmcblk0' }), img['armsom-cm5-io']);
  check(!sd.ok && /is not this board's eMMC/.test(sd.reason), `the SD card it runs from: ${sd.reason}`);
  const spi = await page.evaluate((id) => window.imager.writeBoard({ kind: 'spinor', imageId: id, device: '/dev/mtd0' }), img['armsom-cm5-io']);
  check(!spi.ok && /does not write the SPI NOR flash/.test(spi.reason), `a storage the board list does not give: ${spi.reason}`);
});

console.log('-- ArmSoM CM5-IO running from its eMMC');
await withApp(PRETEND.cm5ioFromEmmc(), async (page, img) => {
  const h = await page.evaluate(() => window.imager.boardHere());
  check(/^The eMMC is in use: \/, \/boot are mounted from it\./.test(h.emmcRefusal ?? ''), `boardHere refuses: ${h.emmcRefusal}`);
  await page.click(next);
  await page.click(next);
  await page.waitForSelector('#here-emmc');
  check(await page.isDisabled('#here-emmc'), 'the eMMC is not offered');
  check(await page.locator('text=If this system runs from the eMMC').count() === 1, 'and the page says why');
  check(await page.isDisabled(next), 'Review cannot be reached');
  const r = await page.evaluate((id) => window.imager.writeBoard({ kind: 'emmc', imageId: id, device: '/dev/mmcblk1' }), img['armsom-cm5-io']);
  check(!r.ok && /^The eMMC is in use/.test(r.reason), `asked anyway: ${r.reason}`);
});

console.log('-- Radxa ROCK 4D found by its SMBIOS name: its SPI NOR flash');
await withApp(PRETEND.rock4d(), async (page, img) => {
  const h = await page.evaluate(() => window.imager.boardHere());
  check(h.boardId === 'radxa-rock-4d' && h.mtd.length === 1 && h.mtd[0].device === '/dev/mtd0' && h.mtd[0].bytes === 16777216
    && JSON.stringify(h.storages) === '["spinor"]', `boardHere: ${JSON.stringify({ id: h.boardId, mtd: h.mtd, storages: h.storages })}`);
  await page.click(next);
  await page.click(next);
  await page.waitForSelector('#here-spinor');
  check(await page.isChecked('#here-spinor') && await page.locator('#here-emmc').count() === 0, 'Destination: its SPI NOR flash, and no eMMC');
  await page.click(next);
  await page.waitForSelector('h2:has-text("Review")');
  check(await page.locator('text=roxora-radxa-rock-4d-noble-edge-2026.11.0-spi.img').count() === 1, 'the review names the SPI bootloader');
  const r = (await page.evaluate((id) => window.imager.writeBoard({ kind: 'spinor', imageId: id, device: '/dev/mtd0' }), img['radxa-rock-4d'])).reason;
  check(/pretend board/.test(r), `the right request stops at the main process: ${r}`);
  const emmc = await page.evaluate((id) => window.imager.writeBoard({ kind: 'emmc', imageId: id, device: '/dev/mmcblk0' }), img['radxa-rock-4d']);
  check(!emmc.ok && /does not write the eMMC/.test(emmc.reason), `no eMMC write on this board: ${emmc.reason}`);
});

console.log('-- Radxa ROCK 4D without the SPI flash driver');
await withApp(PRETEND.rock4dNoMtd(), async (page) => {
  await page.click(next);
  await page.click(next);
  await page.waitForSelector('#here-spinor');
  check(await page.isDisabled('#here-spinor'), 'the SPI NOR flash is not offered');
  check(await page.locator('text=CONFIG_SPI_ROCKCHIP_SFC').count() === 1, 'and the page says what the kernel needs');
});

console.log('-- this computer, no pretend root');
await withApp(null, async (page) => {
  const h = await page.evaluate(() => window.imager.boardHere());
  check(h.boardId === null || process.platform === 'linux', `boardHere: ${h.boardId}`);
  if (h.boardId === null) {
    await page.fill('.board-search input', 'cm5');
    await page.press('.board-search input', 'Enter');
    await page.click(next);
    await page.click(next);
    await page.waitForSelector('#method-sd');
    check(await page.locator('#method-here').count() === 0, 'This board is not offered on a computer that is no board');
  }
});

console.log(failures.length ? `FAIL: ${failures.length} check(s)` : 'PASS: the board this runs on, against four pretend boards');
process.exit(failures.length ? 1 : 0);
