// The Electron main process: the window, the app:// protocol, WebUSB access
// for the Maskrom worker, and everything that touches disks or the network.

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, session, shell, type WebContents } from 'electron';
import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import * as drivelist from 'drivelist';
import { formatBytes } from '../shared/format';
import { classifyDrives, isOfferedTarget, type DriveInfo } from '../shared/targets';
import type { JobProgress, JobResult, LocalImage, PreparedFile } from '../shared/ipc';
import type { CatalogImage } from '../shared/catalog';
import { partitionedSize } from '../maskrom/spi-check';
import { loadReleases, loadSample, writableImage, writableImages, type CatalogState } from './catalog-source';
import { helperLaunch, runHelper, sudoPromptElevate } from './elevate';
import { decompress, detectCompression, fetchImage, forgetFile, serveFile, serveFileAs } from './images';
import { ensureLoader } from './loader-cache';
import { describeLocal, measureFile, sha256OfFile } from './local-image';
import { handleProtocol, ORIGIN, registerScheme } from './protocol';
import { macWrite } from './mac-write';
import { loadSettings, saveSettings } from './settings';
import { checkForUpdate } from './updater';
import { installUsbHandlers, ROCKCHIP_VID, type UsbChoice } from './usb';

registerScheme();

// --dev-sample loads the sample catalog from the release contract instead of
// GitHub. Its entries can be browsed but never written: the write handlers
// only accept ids from the real releases (catalog-source.ts).
const DEV_SAMPLE = process.argv.includes('--dev-sample') || process.env.ROXORA_IMAGER_SAMPLE === '1';
// For screenshots and tests: do not show the window.
const HIDDEN = process.env.ROXORA_IMAGER_HIDDEN === '1';

const appDir = app.getAppPath();
const resourcesDir = join(appDir, 'resources');
const cacheDir = () => join(app.getPath('userData'), 'images');
// Rockchip's Maskrom loaders, built from rkbin on first use (loader-cache.ts).
const loaderDir = () => join(app.getPath('userData'), 'loaders');

const WRITER = process.platform === 'win32' ? 'roxora-imager-writer.exe' : 'roxora-imager-writer';
// On macOS the disk is opened by Apple's authopen instead (mac-write.ts).
const RAWDISK = 'roxora-imager-rawdisk';
function writerPath(name = WRITER): string {
  return app.isPackaged ? join(process.resourcesPath, 'writer', name) : join(appDir, 'build-res', 'writer', name);
}

let win: BrowserWindow | null = null;
let job: AbortController | null = null;
const pendingUsb = new Map<number, (id: string) => void>();

function sendProgress(wc: WebContents, p: JobProgress) {
  if (!wc.isDestroyed()) wc.send('job:progress', p);
}

function askUsb(wc: WebContents, choices: UsbChoice[]): Promise<string> {
  return new Promise((resolve) => {
    pendingUsb.get(wc.id)?.('');
    pendingUsb.set(wc.id, resolve);
    wc.send('usb:choose', choices.map((c) => ({ deviceId: c.deviceId, productName: c.productName, productId: c.productId })));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 720, minHeight: 560,
    show: false,
    title: 'Roxora Imager',
    // The design icon (resources/icons/, from roxora-os/design) for the title
    // bar and task switcher on Linux and Windows; macOS uses the bundle's .icns.
    icon: join(resourcesDir, 'icons', 'png', 'roxora-imager-256.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d21' : '#f0f0f0',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(appDir, 'build', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Hidden runs (screenshots, tests) render off screen so they can be captured.
      ...(HIDDEN ? { offscreen: true } : {}),
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(github\.com\/roxora-os\/|roxora-os\.github\.io\/|zadig\.akeo\.ie\/)/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) e.preventDefault(); });
  if (!HIDDEN) win.once('ready-to-show', () => win?.show());
  win.loadURL(`${ORIGIN}/index.html`);
}

let lastCatalog: CatalogState | null = null;

ipcMain.handle('catalog:load', async (_e, opts: { sample: boolean }) => {
  if (FAKE_NO_RELEASES) return { state: 'none', problems: [], sample: false };
  lastCatalog = opts.sample && DEV_SAMPLE ? loadSample(join(resourcesDir, 'sample-catalog.json')) : await loadReleases();
  return lastCatalog;
});

// For screenshots and UI tests of an unpackaged build only: a made-up drive
// list (device names that cannot exist) and an empty release list.
const FAKE_DRIVES = !app.isPackaged && process.env.ROXORA_IMAGER_FAKE_DRIVES === '1';
const FAKE_NO_RELEASES = !app.isPackaged && process.env.ROXORA_IMAGER_FAKE_RELEASES === 'none';
const fakeDrives: DriveInfo[] = [
  { device: '/dev/roxora-test-sda', description: 'ATA Samsung SSD 870', size: 512e9, mountpoints: [{ path: '/' }],
    isReadOnly: false, isSystem: true, isVirtual: false, isRemovable: false, isCard: false, isUSB: false },
  { device: '/dev/roxora-test-sdb', description: 'SanDisk Ultra 32 GB', size: 31914983424, mountpoints: [{ path: '/media/user/boot' }],
    isReadOnly: false, isSystem: false, isVirtual: false, isRemovable: true, isCard: false, isUSB: true },
  { device: '/dev/roxora-test-mmcblk0', description: 'SD card reader, 2 GB card', size: 1977614336, mountpoints: [],
    isReadOnly: false, isSystem: false, isVirtual: false, isRemovable: true, isCard: true, isUSB: false },
];

ipcMain.handle('drives:list', async (_e, minSize: number) => {
  const drives = FAKE_DRIVES ? fakeDrives : await drivelist.list();
  return classifyDrives(drives as unknown as DriveInfo[], { minSize, platform: process.platform });
});

ipcMain.handle('job:cancel', () => { job?.abort(); });

/** Write an image file to a drive and read it back: macOS through authopen, else the elevated writer. */
async function writeDrive(wc: WebContents, signal: AbortSignal,
  w: { file: string; device: string; extractSize: number; extractSha256: string }): Promise<JobResult> {
  const out = process.platform === 'darwin'
    ? await macWrite({
      signal, image: w.file, device: w.device, extractSize: w.extractSize, extractSha256: w.extractSha256,
      helperPath: writerPath(RAWDISK),
      onProgress: (p) => sendProgress(wc, { stage: p.stage, bytes: p.bytes, total: w.extractSize, speed: p.speed }),
    })
    : await runHelper({
      signal,
      launch: (dir) => helperLaunch({ writerPath: writerPath(), dir, appImage: process.env.APPIMAGE }),
      args: (socket, token) => [
        '--socket', socket, '--token', token, '--image', w.file, '--device', w.device,
        '--extract-size', String(w.extractSize), '--extract-sha256', w.extractSha256,
      ],
      onMessage: (m) => {
        if (m.type === 'progress') {
          sendProgress(wc, { stage: m.stage, bytes: m.bytes, total: w.extractSize, speed: m.speed });
        }
      },
      elevate: sudoPromptElevate,
    });
  if (out.ok) return { ok: true, sha256: out.sha256 };
  return { ok: false, reason: out.reason, ...(out.detail ? { detail: out.detail } : {}) };
}

ipcMain.handle('sd:write', async (e, imageId: string, device: string): Promise<JobResult> => {
  const img = writableImage(imageId);
  if (!img || img.sample) return { ok: false, reason: 'This image is not from a published release and cannot be written.' };
  if (job) return { ok: false, reason: 'Another write is running.' };
  job = new AbortController();
  const wc = e.sender;
  try {
    const file = await fetchImage(img, cacheDir(), (p) => sendProgress(wc, p), job.signal);
    return await writeDrive(wc, job.signal, { file, device, extractSize: img.extractSize, extractSha256: img.extractSha256 });
  } catch (err) {
    if (job?.signal.aborted) return { ok: false, reason: 'Cancelled.' };
    return { ok: false, reason: String((err as Error).message ?? err) };
  } finally {
    job = null;
  }
});

// An image file on this computer for the SD/USB path (local-image.ts). The
// page only holds a token; the path stays here.
let localImage: { token: string; path: string; image: CatalogImage | null; sizeHint: number } | null = null;

async function describeForPage(path: string): Promise<LocalImage | { error: string }> {
  if (job) return { error: 'Another job is running.' };
  job = new AbortController();
  try {
    const d = await describeLocal(path, writableImages(), { signal: job.signal });
    const token = randomBytes(16).toString('hex');
    localImage = { token, path, image: d.image, sizeHint: d.extractSize || d.size };
    return { token, name: d.name, size: d.size, extractSize: d.extractSize, imageId: d.image?.id ?? null };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  } finally {
    job = null;
  }
}

// Unpackaged builds only: the file "chosen" without a dialog, for the screenshots.
const TEST_PICK = !app.isPackaged ? process.env.ROXORA_IMAGER_TEST_PICK : undefined;

ipcMain.handle('sd:pick', async () => {
  if (TEST_PICK) return describeForPage(TEST_PICK);
  const r = await dialog.showOpenDialog(win!, {
    title: 'Choose an image file',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['img', 'xz', 'gz', 'bz2', 'raw'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  return describeForPage(r.filePaths[0]);
});

ipcMain.handle('sd:drop', async (_e, path: unknown) => {
  if (typeof path !== 'string' || !path) return { error: 'That is not a file on this computer.' };
  return describeForPage(path);
});

ipcMain.handle('sd:write-file', async (e, token: string, device: string): Promise<JobResult> => {
  const l = localImage;
  if (!l || l.token !== token) return { ok: false, reason: 'Choose the image file again. Nothing was written.' };
  if (job) return { ok: false, reason: 'Another write is running.' };
  job = new AbortController();
  const wc = e.sender;
  const signal = job.signal;
  try {
    let extractSize: number;
    let extractSha256: string;
    if (l.image) {
      // A release image: checked against the release again, as a download is.
      const total = l.image.size;
      const got = await sha256OfFile(l.path, (bytes) => sendProgress(wc, { stage: 'check', bytes, total }), signal);
      if (got !== l.image.sha256) {
        return { ok: false, reason: 'The file no longer matches the release. Nothing was written.',
          detail: `sha256 ${got}, release ${l.image.sha256}` };
      }
      ({ extractSize, extractSha256 } = l.image);
    } else {
      // A custom image: its own decompressed data is what the drive must read back as.
      const m = await measureFile(l.path, (bytes) => sendProgress(wc, { stage: 'check', bytes, total: Math.max(l.sizeHint, bytes) }), signal);
      extractSize = m.size;
      extractSha256 = m.sha256;
      const drives = await drivelist.list() as unknown as DriveInfo[];
      if (!isOfferedTarget(device, drives, { minSize: m.size, platform: process.platform })) {
        return { ok: false, reason: `${device} is smaller than the image (${formatBytes(m.size)}), or no longer a drive the imager writes to. Nothing was written.` };
      }
    }
    return await writeDrive(wc, signal, { file: l.path, device, extractSize, extractSha256 });
  } catch (err) {
    if (signal.aborted) return { ok: false, reason: 'Cancelled. Nothing was written.' };
    return { ok: false, reason: String((err as Error).message ?? err) };
  } finally {
    job = null;
  }
});

/** The size of the disk a plain image's partition table describes, for the SPI NOR check (maskrom/spi-check.ts). */
async function diskSizeOf(path: string): Promise<number> {
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return partitionedSize(head.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

async function prepare(wc: WebContents, path: string, name: string, expected: { size: number; sha256: string } | null,
  signal: AbortSignal): Promise<PreparedFile> {
  const kind = await detectCompression(path);
  if (kind === null) {
    // A plain image is served as it is; its hash is taken while it is written.
    const s = serveFile(path);
    return { token: s.token, url: `${ORIGIN}/file/${s.token}`, size: s.size, sha256: expected?.sha256 ?? null, name,
      diskSize: await diskSizeOf(path) };
  }
  const out = await decompress(path, join(cacheDir(), 'maskrom'), (p) => sendProgress(wc, p), signal, expected?.size);
  if (expected && (out.size !== expected.size || out.sha256 !== expected.sha256)) {
    forgetFile(serveFile(out.path).token, true);
    throw new Error(`The decompressed image does not match the release (sha256 ${out.sha256}, expected ${expected.sha256}).`);
  }
  const s = serveFile(out.path);
  temporary.add(s.token);
  return { token: s.token, url: `${ORIGIN}/file/${s.token}`, size: s.size, sha256: out.sha256, name,
    diskSize: await diskSizeOf(out.path) };
}

const temporary = new Set<string>();

ipcMain.handle('maskrom:prepare', async (e, imageId: string, what: 'image' | 'spi' = 'image') => {
  const img = writableImage(imageId);
  if (!img || img.sample) return { error: 'This image is not from a published release and cannot be written.' };
  if (what === 'spi' && !img.spi) return { error: 'This release has no SPI bootloader for the board.' };
  if (job) return { error: 'Another job is running.' };
  job = new AbortController();
  try {
    if (what === 'spi') {
      // A plain image: served as it is, and the read-back is compared with its release sha256.
      const spi = img.spi!;
      const file = await fetchImage({ ...spi, sample: img.sample }, cacheDir(), (p) => sendProgress(e.sender, p), job.signal);
      return await prepare(e.sender, file, spi.file, { size: spi.size, sha256: spi.sha256 }, job.signal);
    }
    const file = await fetchImage(img, cacheDir(), (p) => sendProgress(e.sender, p), job.signal);
    return await prepare(e.sender, file, img.file, { size: img.extractSize, sha256: img.extractSha256 }, job.signal);
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  } finally {
    job = null;
  }
});

ipcMain.handle('maskrom:pick', async (e) => {
  const r = await dialog.showOpenDialog(win!, {
    title: 'Choose an image or bootloader file',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['img', 'bin', 'xz', 'gz', 'bz2'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  job = new AbortController();
  try {
    const path = r.filePaths[0];
    return await prepare(e.sender, path, path.split(/[\\/]/).pop() ?? path, null, job.signal);
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  } finally {
    job = null;
  }
});

ipcMain.handle('maskrom:loader', async (_e, name: string) => {
  try {
    await ensureLoader(loaderDir(), name, (url) => net.fetch(url));
    return { url: `${ORIGIN}/loader/${encodeURIComponent(name)}` };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
});

ipcMain.handle('maskrom:release', (_e, token: string) => {
  forgetFile(token, temporary.delete(token));
});

ipcMain.on('usb:answer', (e, deviceId: string) => {
  const r = pendingUsb.get(e.sender.id);
  pendingUsb.delete(e.sender.id);
  r?.(deviceId);
});

ipcMain.handle('settings:get', () => {
  const s = loadSettings();
  return { updateCheck: s.updateCheck, resetAfterMaskrom: s.resetAfterMaskrom };
});
ipcMain.handle('settings:set', (_e, patch: { updateCheck?: boolean; resetAfterMaskrom?: boolean }) => {
  const s = loadSettings();
  saveSettings({
    ...s,
    ...(typeof patch.updateCheck === 'boolean' ? { updateCheck: patch.updateCheck } : {}),
    ...(typeof patch.resetAfterMaskrom === 'boolean' ? { resetAfterMaskrom: patch.resetAfterMaskrom } : {}),
  });
});
ipcMain.handle('update:check', (_e, force: boolean) => checkForUpdate(force === true));
ipcMain.handle('open-external', (_e, url: string) => {
  if (/^https:\/\/(github\.com\/roxora-os\/|roxora-os\.github\.io\/|zadig\.akeo\.ie\/)/.test(url)) return shell.openExternal(url);
});
ipcMain.on('app:info', (e) => {
  e.returnValue = { platform: process.platform, version: app.getVersion(), devSample: DEV_SAMPLE };
});
ipcMain.on('theme', (_e, t: 'light' | 'dark') => { nativeTheme.themeSource = t; });

app.whenReady().then(() => {
  handleProtocol(join(appDir, 'build', 'renderer'), resourcesDir, loaderDir());
  // Unpackaged builds only: let the WebUSB smoke test (scripts/usb-smoke.mjs)
  // reach a device that is not a Rockchip board, and serve it a test file.
  const testVid = !app.isPackaged ? Number(process.env.ROXORA_IMAGER_USB_TEST_VID ?? NaN) : NaN;
  const vendorIds = Number.isInteger(testVid) ? [ROCKCHIP_VID, testVid] : [ROCKCHIP_VID];
  if (!app.isPackaged && process.env.ROXORA_IMAGER_TEST_SERVE) serveFileAs('test', process.env.ROXORA_IMAGER_TEST_SERVE);
  if (!app.isPackaged && process.env.ROXORA_IMAGER_TEST_SERVE_XZ) serveFileAs('xz', process.env.ROXORA_IMAGER_TEST_SERVE_XZ);
  installUsbHandlers(session.defaultSession, { origins: [ORIGIN], vendorIds }, askUsb);
  createWindow();
});

app.on('window-all-closed', () => app.quit());

