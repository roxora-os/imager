// What the Maskrom destination says about the USB devices it sees, from
// Maskrom Studio's src/shared/maskrom-detect.ts. A Rockchip device (vendor
// 0x2207) with the chip's Maskrom product ID is a board ready to be
// written; another Rockchip product ID is another chip; on Windows, a
// device that cannot be opened has no WinUSB driver yet. Every board with
// the same chip answers with the same IDs, so the page names the board the
// user chose and says the chip, not the board, was seen.
// No browser APIs here, so the tests use it directly.

export const ROCKCHIP_VID = 0x2207;

/** The USB product ID a chip answers with in Maskrom mode (and with the loader). */
export const MASKROM_PIDS: Record<string, number> = {
  rk3576: 0x350e,
};

export interface SeenDevice {
  vendorId: number;
  productId: number;
  /** Windows: could the device be opened (false: no WinUSB driver)? null when not tried. */
  opens: boolean | null;
}

export type MaskromStatus =
  | { kind: 'none' }
  | { kind: 'ready' }
  | { kind: 'no-driver' }
  | { kind: 'other-soc'; pid: string }
  | { kind: 'several'; count: number };

const hex = (n: number) => n.toString(16).padStart(4, '0');

/** What the devices seen mean for a board with chip `soc` (e.g. "rk3576"). */
export function maskromStatus(devices: SeenDevice[], soc: string): MaskromStatus {
  const rk = devices.filter((d) => d.vendorId === ROCKCHIP_VID);
  if (rk.length === 0) return { kind: 'none' };
  if (rk.length > 1) return { kind: 'several', count: rk.length };
  const d = rk[0];
  if (d.productId !== MASKROM_PIDS[soc]) return { kind: 'other-soc', pid: `${hex(ROCKCHIP_VID)}:${hex(d.productId)}` };
  if (d.opens === false) return { kind: 'no-driver' };
  return { kind: 'ready' };
}
