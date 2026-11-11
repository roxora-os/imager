// The app's Maskrom worker with a pretend board on navigator.usb, for
// running the whole Maskrom path inside Electron without hardware
// (scripts/electron-maskrom-e2e.mjs). Never part of the app.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { FakeBoard } from '../fake-rockchip';

const board = new FakeBoard({ storages: { 1: 64 << 20, 9: 16 << 20 }, defaultStorage: 9 });
Object.defineProperty(navigator, 'usb', { value: board.usb(), configurable: true });

self.addEventListener('message', (e: MessageEvent) => {
  if (e.data?.type === 'dump') {
    const bytes = board.contents(e.data.storage, e.data.size);
    (self as unknown as Worker).postMessage({ type: 'dump', sha256: bytesToHex(sha256(bytes)), resets: board.resets, log: board.log.slice(0, 8) });
  }
});

await import('../../src/maskrom/worker');
