// Where the catalog comes from: the GitHub releases of roxora-os/build, the
// same releases the website's Download page and os_list.json are built from.
// No second catalog is kept anywhere.

import { net } from 'electron';
import { readFileSync } from 'node:fs';
import {
  catalogAssets, checkAgainstRelease, parseCatalog, RELEASES_REPO,
  type CatalogImage, type GithubRelease,
} from '../shared/catalog';

export type CatalogState =
  | { state: 'ok'; images: CatalogImage[]; problems: string[]; sample: boolean }
  | { state: 'none'; problems: string[]; sample: false }
  | { state: 'error'; message: string; problems: string[]; sample: false };

const API = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`;

async function getJson(url: string): Promise<unknown> {
  const r = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'roxora-imager' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** Images that may be written: only these ids are accepted by the write handlers. */
const writable = new Map<string, CatalogImage>();

export function writableImage(id: string): CatalogImage | undefined {
  return writable.get(id);
}

export async function loadReleases(): Promise<CatalogState> {
  let releases: GithubRelease[];
  try {
    releases = (await getJson(API)) as GithubRelease[];
    if (!Array.isArray(releases)) throw new Error('GitHub did not return a list of releases');
  } catch (e) {
    return { state: 'error', message: `Could not reach GitHub: ${(e as Error).message}`, problems: [], sample: false };
  }
  const assets = catalogAssets(releases);
  if (assets.length === 0) return { state: 'none', problems: [], sample: false };
  const images: CatalogImage[] = [];
  const problems: string[] = [];
  for (const a of assets) {
    const gh = releases.find((r) => r.tag_name === a.tag)!;
    try {
      const parsed = checkAgainstRelease(parseCatalog(await getJson(a.url)), gh);
      if (parsed.sample) {
        problems.push(`release ${a.tag}: its catalog is marked as sample data; skipped`);
        continue;
      }
      images.push(...parsed.images);
      problems.push(...parsed.problems.map((p) => `release ${a.tag}: ${p}`));
    } catch (e) {
      problems.push(`release ${a.tag}: ${(e as Error).message}`);
    }
  }
  writable.clear();
  for (const img of images) writable.set(img.id, img);
  if (images.length === 0) return { state: 'none', problems, sample: false };
  return { state: 'ok', images, problems, sample: false };
}

/** The sample catalog, for development only. Its entries never reach `writable`. */
export function loadSample(path: string): CatalogState {
  const parsed = parseCatalog(JSON.parse(readFileSync(path, 'utf8')), { sample: true });
  return { state: 'ok', images: parsed.images, problems: parsed.problems, sample: true };
}
