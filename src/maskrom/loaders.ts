// Where each Maskrom loader comes from. The app does not ship Rockchip's
// loader blobs: the first Maskrom write downloads the pieces from Rockchip's
// rkbin repository at a pinned commit, checks each against its pinned
// SHA-256, builds the loader (loader-merge.ts) and checks the result against
// the SHA-256 of the loader Rockchip built from the same pieces. The desktop
// app keeps the result in its user data folder.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { blobPaths, mergeLoader, parseIni, type BuildTime } from './loader-merge';

export const RKBIN_HOST = 'raw.githubusercontent.com';

export interface LoaderPin {
  /** File name the app knows the loader by (boards.ts). */
  name: string;
  /** rockchip-linux/rkbin commit every piece is taken from. */
  commit: string;
  ini: string;
  /** SHA-256 of the ini and of every rkbin file it names. */
  files: Record<string, string>;
  /** Build time in the header of Rockchip's own build of this loader. */
  when: BuildTime;
  size: number;
  sha256: string;
}

export const LOADERS: Record<string, LoaderPin> = {
  // rk3576_spl_loader_v1.09.107.bin: DDR v1.09, usbplug v1.04, boost v1.03,
  // SPL v1.07, the loader edk2-webflash proved on RK3576 boards.
  'rk3576_spl_loader.bin': {
    name: 'rk3576_spl_loader.bin',
    commit: 'f43a462e7a1429a9d407ae52b4745033034a6cf9',
    ini: 'RKBOOT/RK3576MINIALL.ini',
    files: {
      'RKBOOT/RK3576MINIALL.ini': '3f058df2a1c5f54ae85e60bc69c366d72ecfd2666b11d5c4fcc513272f090c6e',
      'bin/rk35/rk3576_ddr_lp4_2112MHz_lp5_2736MHz_v1.09.bin': '79bdf7eb259274eec83ea2f6330214b0c0035255bc5563746871f6f8ce7cf089',
      'bin/rk35/rk3576_usbplug_v1.04.bin': '77238d47f10e84844d95707024b8171fc9f198e19ad6500f5e8a5810ca6c680b',
      'bin/rk35/rk3576_boost_v1.03.bin': 'ca525f15e54fabd1c84ce40450a01ecd666db408e1cbf1902d62415d91826915',
      'bin/rk35/rk3576_spl_v1.07.bin': 'bd1a688b0b0238e7ed7fbf2632ac5d1303e75a0c3b0f1ea3833f939f0fe26664',
    },
    when: [2025, 4, 11, 19, 54, 33],
    size: 774649,
    sha256: '9aee33d44ecc4b30e76241a6aa6993e433edb42c4d92909aa55b81c21c142a9e',
  },
};

export const rkbinUrl = (pin: LoaderPin, path: string) => `https://${RKBIN_HOST}/rockchip-linux/rkbin/${pin.commit}/${path}`;

/** Whether `data` is the pinned loader. */
export function isPinnedLoader(pin: LoaderPin, data: Uint8Array): boolean {
  return data.length === pin.size && bytesToHex(sha256(data)) === pin.sha256;
}

/**
 * Download the pieces of `pin` and build the loader. Throws an Error whose
 * message is one sentence for the page.
 */
export async function buildLoader(pin: LoaderPin, fetchFn: (url: string) => Promise<Response> = fetch): Promise<Uint8Array> {
  const get = async (path: string): Promise<Uint8Array> => {
    let r: Response;
    try {
      r = await fetchFn(rkbinUrl(pin, path));
    } catch {
      throw new Error(`Could not download Rockchip's loader from ${RKBIN_HOST}. Check the internet connection and try again.`);
    }
    if (!r.ok) throw new Error(`Could not download Rockchip's loader: ${RKBIN_HOST} answered ${r.status} for ${path}.`);
    const data = new Uint8Array(await r.arrayBuffer());
    if (bytesToHex(sha256(data)) !== pin.files[path]) {
      throw new Error(`Rockchip's loader file ${path} from ${RKBIN_HOST} does not match its pinned checksum.`);
    }
    return data;
  };
  const ini = new TextDecoder().decode(await get(pin.ini));
  const options = parseIni(ini);
  const paths = blobPaths(options);
  for (const p of paths) if (!(p in pin.files)) throw new Error(`The pinned RKBOOT ini names ${p}, which has no pinned checksum.`);
  const blobs = new Map(await Promise.all(paths.map(async (p) => [p, await get(p)] as const)));
  const data = mergeLoader(options, blobs, pin.when);
  if (!isPinnedLoader(pin, data)) throw new Error("The loader built from Rockchip's files does not match its pinned checksum.");
  return data;
}
