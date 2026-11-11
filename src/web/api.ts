// window.imager for the web build. The browser can reach the catalog (the
// site's CORS-enabled mirror, cross-checked with the GitHub releases API)
// and WebUSB, but not release downloads (no CORS) and not disks: so there
// is no SD/USB writing, and release files are downloaded by the user and
// picked from disk, then checked against the catalog the way
// edk2-webflash's Roxora panel does (src/roxora.js there: the API asset
// digest and extract_sha256).

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  checkAgainstRelease, parseCatalog, RELEASES_REPO, type CatalogImage, type GithubRelease, type ParsedCatalog,
} from '../shared/catalog';
import type { CatalogResult, ImagerApi, PreparedFile } from '../shared/ipc';

declare const __APP_VERSION__: string;

export const MIRROR_INDEX = 'https://roxora-os.github.io/catalog/index.json';
const API = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`;

const writable = new Map<string, CatalogImage>();

async function json(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

interface MirrorIndex { schema: number; releases: { tag: string; catalog: string }[] }

export async function loadWebCatalog(sample: boolean): Promise<CatalogResult> {
  if (sample) {
    const parsed = parseCatalog(await json('resources/sample-catalog.json'), { sample: true });
    return { state: 'ok', images: parsed.images, problems: parsed.problems, sample: true };
  }
  let index: MirrorIndex;
  try {
    index = (await json(MIRROR_INDEX)) as MirrorIndex;
  } catch (e) {
    return { state: 'error', message: `Could not load the list of releases: ${(e as Error).message}`, problems: [], sample: false };
  }
  // The API's asset digests are a second, independent source for the
  // checksums; when GitHub limits requests the mirror alone is used.
  let gh: GithubRelease[] | null = null;
  try { gh = (await json(API)) as GithubRelease[]; } catch { gh = null; }
  const images: CatalogImage[] = [];
  const problems: string[] = gh ? [] : ['GitHub API not reachable: checksums come from the catalog mirror only'];
  for (const r of index.releases ?? []) {
    try {
      let parsed: ParsedCatalog = parseCatalog(await json(r.catalog));
      if (parsed.sample) continue;
      const rel = gh?.find((x) => x.tag_name === r.tag);
      if (gh && !rel) { problems.push(`release ${r.tag}: not listed by GitHub; skipped`); continue; }
      if (rel) parsed = checkAgainstRelease(parsed, rel);
      images.push(...parsed.images);
      problems.push(...parsed.problems.map((p) => `release ${r.tag}: ${p}`));
    } catch (e) {
      problems.push(`release ${r.tag}: ${(e as Error).message}`);
    }
  }
  writable.clear();
  for (const i of images) writable.set(i.id, i);
  if (images.length === 0) return { state: 'none', problems, sample: false };
  return { state: 'ok', images, problems, sample: false };
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

export async function hashFile(file: File, onProgress: (done: number, total: number) => void): Promise<string> {
  const h = sha256.create();
  const reader = file.stream().getReader();
  let done = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    h.update(r.value);
    done += r.value.length;
    onProgress(done, file.size);
  }
  return bytesToHex(h.digest());
}

/**
 * What a picked file must hash to, and what the bytes written will hash to.
 * For the image: the .img.xz (catalog sha256) or the .img extracted from it
 * (extract_sha256); either way the written bytes are the extracted image.
 */
export function expectedHashes(img: CatalogImage, what: 'image' | 'spi'):
  { accept: { sha256: string; size: number; label: string }[]; written: string } {
  if (what === 'spi') {
    const s = img.spi!;
    return { accept: [{ sha256: s.sha256, size: s.size, label: s.file }], written: s.sha256 };
  }
  return {
    accept: [
      { sha256: img.sha256, size: img.size, label: img.file },
      { sha256: img.extractSha256, size: img.extractSize, label: img.file.replace(/\.xz$/, '') },
    ],
    written: img.extractSha256,
  };
}

let tokens = 0;

export const webApi: ImagerApi = {
  platform: 'web',
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
  devSample: typeof location !== 'undefined' && new URLSearchParams(location.search).has('sample'),
  loadCatalog: (opts) => loadWebCatalog(opts.sample),
  listDrives: async () => ({ targets: [], hidden: [] }),
  writeSd: async () => ({ ok: false, reason: 'A browser cannot write SD cards or USB drives.' }),
  cancel: async () => {},
  onProgress: () => () => {},
  prepareMaskrom: async () => ({ error: 'Choose the downloaded file first.' }),
  async pickReleaseFile(imageId, what, onProgress) {
    const img = writable.get(imageId);
    if (!img || img.sample) return { error: 'This image is not from a published release and cannot be written.' };
    if (what === 'spi' && !img.spi) return { error: 'This release has no SPI bootloader for the board.' };
    const exp = expectedHashes(img, what);
    const file = await pickFile(what === 'spi' ? '.img' : '.xz,.img');
    if (!file) return null;
    const bySize = exp.accept.filter((a) => a.size === file.size);
    if (bySize.length === 0) {
      return { error: `${file.name} is not ${exp.accept.map((a) => a.label).join(' or ')} (the size differs).` };
    }
    const got = await hashFile(file, onProgress);
    if (!bySize.some((a) => a.sha256 === got)) {
      return { error: `${file.name} does not match the release checksum. Download it again.` };
    }
    const p: PreparedFile = { token: `web-${++tokens}`, url: '', file, size: file.size, sha256: exp.written, name: file.name };
    return p;
  },
  async pickMaskromFile() {
    const file = await pickFile('.img,.bin,.xz');
    if (!file) return null;
    return { token: `web-${++tokens}`, url: '', file, size: file.size, sha256: null, name: file.name };
  },
  releaseMaskrom: async () => {},
  onUsbChoice: () => () => {},
  answerUsbChoice: () => {},
  getSettings: async () => {
    let reset = true;
    try { reset = localStorage.getItem('resetAfterMaskrom') !== '0'; } catch { /* no storage */ }
    return { updateCheck: false, resetAfterMaskrom: reset };
  },
  setSettings: async (s) => {
    try { if (typeof s.resetAfterMaskrom === 'boolean') localStorage.setItem('resetAfterMaskrom', s.resetAfterMaskrom ? '1' : '0'); } catch { /* no storage */ }
  },
  checkUpdate: async () => null,
  openExternal: async (url) => { window.open(url, '_blank', 'noopener'); },
  setTheme: () => {},
};
