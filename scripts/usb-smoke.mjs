// WebUSB in the Electron app on this machine, with whatever USB device is
// at hand instead of a Rockchip board.
//
//   ROXORA_IMAGER_USB_TEST_VID=0x2e8a node scripts/usb-smoke.mjs
//
// Starts the unpackaged app hidden with one extra USB vendor ID allowed and
// checks, from the app's own page and from a worker of its origin (where the
// Maskrom code runs):
//   1. navigator.usb.getDevices() lists the device without requestDevice(),
//      because of the main process's device permission handler. This is what
//      lets the board come back after "db" without a second pick.
//   2. requestDevice() (with a user gesture) returns it through the
//      main process's select-usb-device handler.
//   3. In a worker: getDevices(), open(), claim and release the first
//      vendor-class interface, close(). A GET_DESCRIPTOR control transfer is
//      tried with a 3 s limit and its outcome reported.
// Nothing else is sent to the device.
import { _electron as electron } from 'playwright-core';
import { rmSync, writeFileSync } from 'node:fs';

const vid = Number(process.env.ROXORA_IMAGER_USB_TEST_VID);
if (!Number.isInteger(vid)) { console.error('set ROXORA_IMAGER_USB_TEST_VID'); process.exit(2); }

const WORKER = `
self.onmessage = async () => {
  const r = { steps: [] };
  const t = (s) => r.steps.push(s);
  try {
    const devs = await navigator.usb.getDevices();
    t('getDevices: ' + devs.map((d) => d.productName).join(', '));
    const d = devs[0];
    await d.open(); t('open: ' + d.opened);
    const desc = await Promise.race([
      d.controlTransferIn({ requestType: 'standard', recipient: 'device', request: 6, value: 0x0100, index: 0 }, 18)
        .then((x) => x.status + ', ' + x.data.byteLength + ' bytes'),
      new Promise((ok) => setTimeout(() => ok('no answer in 3 s'), 3000)),
    ]);
    t('GET_DESCRIPTOR: ' + desc);
    if (d.configuration === null) await d.selectConfiguration(1);
    const iface = d.configuration.interfaces.find((i) => i.alternate.interfaceClass === 0xff);
    if (iface) {
      await d.claimInterface(iface.interfaceNumber); t('claimInterface ' + iface.interfaceNumber + ': ok');
      await d.releaseInterface(iface.interfaceNumber); t('releaseInterface: ok');
    }
    await d.close(); t('close: ok');
  } catch (e) { t('ERROR ' + e.name + ': ' + e.message); }
  postMessage(JSON.stringify(r));
};`;

writeFileSync('build/renderer/usb-smoke-worker.js', WORKER);
const env = { ...process.env, ROXORA_IMAGER_HIDDEN: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], env });
const out = {};
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  out.crossOriginIsolated = await page.evaluate(() => self.crossOriginIsolated);
  out.pageGetDevices = await page.evaluate(async () =>
    (await navigator.usb.getDevices()).map((d) => `${d.vendorId.toString(16)}:${d.productId.toString(16)} ${d.productName}`));
  out.requestDevice = await app.evaluate(({ BrowserWindow }, vid) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
    `navigator.usb.requestDevice({ filters: [{ vendorId: ${vid} }] }).then((d) => 'ok: ' + d.productName, (e) => 'error ' + e.name + ': ' + e.message)`, true), vid);
  out.worker = JSON.parse(await page.evaluate(() => new Promise((res) => {
    const w = new Worker('usb-smoke-worker.js');
    w.onmessage = (e) => res(e.data);
    w.onerror = (e) => res(JSON.stringify({ error: String(e.message ?? e.type) }));
    w.postMessage(0);
  })));
} finally {
  await app.close();
  rmSync('build/renderer/usb-smoke-worker.js', { force: true });
}
console.log(JSON.stringify(out, null, 2));
