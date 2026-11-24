// Scrolling and text selection in the real app window, at small sizes: in
// every step and dialog (Settings, About) exactly one element scrolls, a mouse wheel over the
// content moves it, and the page itself never does. Ctrl+A outside a text
// field selects nothing; a text field's text can be selected. Runs hidden,
// with the sample catalog and the made-up drive list of scripts/shots.mjs.
//   node scripts/electron-scroll-e2e.mjs
import { _electron as electron } from 'playwright-core';

const env = {
  ...process.env, ROXORA_IMAGER_HIDDEN: '1', ROXORA_IMAGER_SAMPLE: '1', ROXORA_IMAGER_FAKE_DRIVES: '1', ROXORA_IMAGER_FAKE_UPDATE: 'current',
};
delete env.ELECTRON_RUN_AS_NODE;
const failures = [];

/** The elements that scroll now, and whether a wheel over (x, y) moves one of them. */
async function check(page, tag, at, within = null) {
  const found = await page.evaluate((within) => {
    const out = [];
    const root = within ? document.querySelector(within) : document;
    for (const el of [...(within ? [root] : []), ...root.querySelectorAll('*')]) {
      if (el.offsetParent === null && el !== document.body) continue;
      const cs = getComputedStyle(el);
      if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(cs.overflowY)) out.push(el.className.toString().split(' ')[0] || el.tagName);
    }
    const d = document.scrollingElement;
    return { out, page: d.scrollHeight > d.clientHeight + 1 };
  }, within);
  // Code and log blocks scroll inside their own box, as they should.
  const big = found.out.filter((c) => !/code-block|log/.test(c));
  if (found.page) failures.push(`${tag}: the page itself scrolls`);
  if (big.length > 1) failures.push(`${tag}: ${big.length} scroll containers (${big.join(', ')})`);
  if (big.length === 1) {
    await page.mouse.move(at[0], at[1]);
    const sum = () => page.evaluate(() => [...document.querySelectorAll('*')].reduce((a, e) => a + e.scrollTop, 0));
    const before = await sum();
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(300);
    const moved = (await sum()) - before;
    if (moved <= 0) failures.push(`${tag}: the wheel did not scroll ${big[0]}`);
    console.log(`${tag}: ${big[0]} scrolls, wheel moved it ${moved}px`);
  } else console.log(`${tag}: fits, nothing to scroll`);
}

for (const [w, h] of [[900, 600], [1024, 700], [720, 480]]) {
  const app = await electron.launch({ args: ['.', '--dev-sample'], env });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => failures.push(`${w}x${h}: ${e.message}`));
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
  await page.reload();
  await page.waitForSelector('h2:has-text("Board")');
  await page.waitForTimeout(500);
  const tag = (s) => `${w}x${h} ${s}`;
  // Over the step content, right of the step nav (or below the collapsed nav toggle when narrow).
  const at = [Math.round(w * 0.7), Math.round(h * 0.6)];
  const next = () => page.click('.pf-v6-c-wizard__footer button.pf-m-primary');
  await check(page, tag('board'), at);

  // Ctrl+A outside a field selects nothing; static step text takes no selection.
  await page.mouse.click(w - 30, Math.round(h * 0.45));
  await page.keyboard.press('Control+A');
  const sel = await page.evaluate(() => String(window.getSelection()));
  if (sel.trim() !== '') failures.push(`${tag('board')}: Ctrl+A selected page text (${sel.slice(0, 40)}...)`);
  const us = await page.evaluate(() => getComputedStyle(document.querySelector('.pf-v6-c-wizard__main-body') ?? document.body).userSelect);
  if (us !== 'none') failures.push(`${tag('board')}: step text is selectable (user-select ${us})`);
  // A text field's text can be selected.
  await page.fill('.board-search input', 'rock4d');
  const inField = await page.evaluate(() => {
    const i = document.querySelector('.board-search input');
    i.focus(); i.select();
    return { us: getComputedStyle(i).userSelect, sel: i.selectionEnd - i.selectionStart };
  });
  if (inField.us === 'none' || inField.sel !== 6) failures.push(`${tag('board')}: the search field's text cannot be selected`);

  await page.press('.board-search input', 'Enter');
  await next();
  await page.waitForSelector('h2:has-text("Image")');
  await page.waitForTimeout(300);
  await check(page, tag('image'), at);
  await next();
  await page.waitForSelector('text=SanDisk');
  await check(page, tag('destination'), at);
  await page.click('text=SanDisk');
  await page.click('.pf-v6-c-wizard__footer button:has-text("Review")');
  await page.waitForSelector('h2:has-text("Review")');
  await page.waitForTimeout(300);
  await check(page, tag('review'), at);

  // Settings, in its own body.
  await page.click('.pf-v6-c-masthead button:has-text("Settings")');
  await page.waitForSelector('.pf-v6-c-modal-box');
  await page.waitForTimeout(300);
  await check(page, tag('settings'), [w / 2, h / 2], '.pf-v6-c-modal-box');
  // About, on the document body: its values (the data folder) can be copied.
  await page.click('#about-open');
  await page.waitForSelector('#about-title');
  await page.waitForTimeout(300);
  await check(page, tag('about'), [w / 2, h / 2], '.about-backdrop');
  const aboutSel = await page.evaluate(() => getComputedStyle(document.querySelector('.about-backdrop .pf-v6-c-description-list__description')).userSelect);
  if (aboutSel === 'none') failures.push(`${tag('about')}: the About values cannot be selected`);
  await page.keyboard.press('Escape');
  if (await page.$('#about-title')) failures.push(`${tag('about')}: Escape did not close About`);
  await app.close();
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('PASS: one scroller per view, the wheel scrolls it, Ctrl+A selects nothing outside a field');
