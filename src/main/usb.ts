// WebUSB in Electron.
//
// A browser shows its own device picker for navigator.usb.requestDevice();
// Electron has none and fires "select-usb-device" instead. The imager picks
// the Rockchip device itself when there is exactly one, and asks the window
// to show a choice when there are several.
//
// After "db" the board resets and comes back as a new USB device (Loader
// mode). edk2-webflash has to ask the user to pick it again, because a
// browser only lets a page see devices the user picked. Here the device
// permission handler grants every Rockchip device (vendor 0x2207) to the
// app's own pages, so navigator.usb.getDevices(), which the libusb WebUSB
// backend calls, already lists the board when it comes back.

import { webContents, type Session, type WebContents } from 'electron';

export const ROCKCHIP_VID = 0x2207;

export interface UsbPolicy {
  /** Pages allowed to use WebUSB, e.g. "app://local". */
  origins: string[];
  vendorIds: number[];
}

export interface UsbChoice {
  deviceId: string;
  vendorId: number;
  productId: number;
  productName?: string;
  serialNumber?: string;
}

/** "app://local/", "app://local/index.html" and "app://local" are the same origin. */
// Not URL.origin: for a scheme Node's URL does not know, that is "null".
export function originOf(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

export function allowedDevice(policy: UsbPolicy, origin: string, device: { vendorId?: number } | undefined): boolean {
  return !!device && policy.origins.includes(originOf(origin)) && policy.vendorIds.includes(device.vendorId ?? -1);
}

/**
 * Pick a device for requestDevice(): the only matching one, or ask.
 * Returns '' (no device) when there is none.
 */
export async function chooseDevice(list: UsbChoice[], policy: UsbPolicy,
  ask: (choices: UsbChoice[]) => Promise<string>): Promise<string> {
  const matching = list.filter((d) => policy.vendorIds.includes(d.vendorId));
  if (matching.length === 0) return '';
  if (matching.length === 1) return matching[0].deviceId;
  return ask(matching);
}

export function installUsbHandlers(session: Session, policy: UsbPolicy,
  ask: (wc: WebContents, choices: UsbChoice[]) => Promise<string>): void {
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (permission === 'usb') return policy.origins.includes(originOf(requestingOrigin));
    // Nothing else the app does needs a permission.
    return false;
  });
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setDevicePermissionHandler((details) => {
    if (details.deviceType !== 'usb') return false;
    return allowedDevice(policy, details.origin, details.device as { vendorId?: number });
  });

  session.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const wc = details.frame ? webContents.fromFrame(details.frame) : undefined;
    const origin = originOf(details.frame?.url);
    if (!policy.origins.includes(origin)) { callback(''); return; }
    const list: UsbChoice[] = details.deviceList.map((d) => ({
      deviceId: d.deviceId, vendorId: d.vendorId, productId: d.productId,
      productName: d.productName, serialNumber: d.serialNumber,
    }));
    chooseDevice(list, policy, (c) => (wc ? ask(wc, c) : Promise.resolve(c[0].deviceId)))
      .then(callback, () => callback(''));
  });
}
