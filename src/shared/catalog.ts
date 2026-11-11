// The image catalog, as described in roxora-os/build docs/release-contract.md.
//
// One catalog per release (the release asset roxora-catalog.json). The
// imager reads every release the GitHub API lists, parses each catalog with
// parseCatalog() and merges them with mergeCatalogs(). Nothing here does I/O,
// so the same code runs in the main process, the renderer and the tests.

export const CATALOG_SCHEMA = 1;
export const CATALOG_ASSET = 'roxora-catalog.json';
export const RELEASES_REPO = 'roxora-os/build';
export const DOWNLOAD_PREFIX = `https://github.com/${RELEASES_REPO}/releases/download/`;

export type ImageStatus = 'hardware-tested' | 'ci-only';

export interface CatalogRelease {
  tag: string;
  version: string;
  date: string;
  prerelease: boolean;
  url: string;
  armbianRef: string;
}

export interface CatalogImage {
  /** Stable key: "<tag>/<file>". */
  id: string;
  board: string;
  boardName: string;
  soc: string;
  release: string;
  ubuntuVersion: string;
  branch: string;
  kernel: string;
  file: string;
  url: string;
  size: number;
  sha256: string;
  extractSize: number;
  extractSha256: string;
  status: ImageStatus;
  verifyUrl: string;
  /** The release this image belongs to. */
  releaseInfo: CatalogRelease;
  /** True for entries from the sample catalog. These can never be written. */
  sample: boolean;
}

export interface ParsedCatalog {
  release: CatalogRelease | null;
  images: CatalogImage[];
  /** Problems found, in words. An image with a problem is left out. */
  problems: string[];
  sample: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^\d{4}\.\d{2}\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NAME = /^[a-z0-9][a-z0-9-]*$/;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(o: Json, key: string, problems: string[], where: string): string | null {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) {
    problems.push(`${where}: "${key}" is missing or not a string`);
    return null;
  }
  return v;
}

function int(o: Json, key: string, problems: string[], where: string): number | null {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    problems.push(`${where}: "${key}" is missing or not a positive integer`);
    return null;
  }
  return v;
}

function parseRelease(raw: unknown, problems: string[]): CatalogRelease | null {
  if (!isObject(raw)) {
    problems.push('catalog: "release" is missing');
    return null;
  }
  const n = problems.length;
  const tag = str(raw, 'tag', problems, 'release');
  const version = str(raw, 'version', problems, 'release');
  const date = str(raw, 'date', problems, 'release');
  const url = str(raw, 'url', problems, 'release');
  const armbianRef = typeof raw.armbian_ref === 'string' ? raw.armbian_ref : '';
  const prerelease = raw.prerelease;
  if (typeof prerelease !== 'boolean') problems.push('release: "prerelease" is not a boolean');
  if (version && !VERSION.test(version)) problems.push(`release: version "${version}" is not YYYY.MM.N`);
  if (tag && version && tag !== `v${version}`) problems.push(`release: tag "${tag}" does not match version "${version}"`);
  if (date && !DATE.test(date)) problems.push(`release: date "${date}" is not YYYY-MM-DD`);
  if (problems.length !== n || !tag || !version || !date || !url) return null;
  return { tag, version, date, prerelease: prerelease as boolean, url, armbianRef };
}

function parseImage(raw: unknown, index: number, release: CatalogRelease, sample: boolean,
  problems: string[]): CatalogImage | null {
  const where = `image ${index + 1}`;
  if (!isObject(raw)) {
    problems.push(`${where}: not an object`);
    return null;
  }
  const n = problems.length;
  const board = str(raw, 'board', problems, where);
  const boardName = str(raw, 'board_name', problems, where);
  const soc = str(raw, 'soc', problems, where);
  const rel = str(raw, 'release', problems, where);
  const ubuntuVersion = str(raw, 'ubuntu_version', problems, where);
  const branch = str(raw, 'branch', problems, where);
  const kernel = typeof raw.kernel === 'string' ? raw.kernel : '';
  const file = str(raw, 'file', problems, where);
  const url = str(raw, 'url', problems, where);
  const size = int(raw, 'size', problems, where);
  const sha256 = str(raw, 'sha256', problems, where);
  const extractSize = int(raw, 'extract_size', problems, where);
  const extractSha256 = str(raw, 'extract_sha256', problems, where);
  const status = str(raw, 'status', problems, where);
  const verifyUrl = typeof raw.verify_url === 'string' ? raw.verify_url : '';
  if (problems.length !== n) return null;

  const name = `${where} (${file})`;
  for (const [k, v] of [['board', board], ['release', rel], ['branch', branch], ['soc', soc]] as const) {
    if (!NAME.test(v!)) problems.push(`${name}: ${k} "${v}" has characters a name cannot have`);
  }
  if (!HEX64.test(sha256!)) problems.push(`${name}: sha256 is not 64 lower-case hex digits`);
  if (!HEX64.test(extractSha256!)) problems.push(`${name}: extract_sha256 is not 64 lower-case hex digits`);
  if (status !== 'hardware-tested' && status !== 'ci-only') problems.push(`${name}: status "${status}" is unknown`);
  const expectedFile = `roxora-${board}-${rel}-${branch}-${release.version}.img.xz`;
  if (file !== expectedFile) problems.push(`${name}: file name should be ${expectedFile}`);
  // Images are only ever downloaded from this release of roxora-os/build.
  const expectedUrl = `${DOWNLOAD_PREFIX}${release.tag}/${file}`;
  if (url !== expectedUrl) problems.push(`${name}: url is not ${expectedUrl}`);
  if (extractSize! < size!) problems.push(`${name}: extract_size is smaller than size`);
  if (problems.length !== n) return null;

  return {
    id: `${release.tag}/${file}`,
    board: board!, boardName: boardName!, soc: soc!, release: rel!, ubuntuVersion: ubuntuVersion!,
    branch: branch!, kernel, file: file!, url: url!, size: size!, sha256: sha256!,
    extractSize: extractSize!, extractSha256: extractSha256!, status: status as ImageStatus,
    verifyUrl, releaseInfo: release, sample,
  };
}

/**
 * Parse one catalog. Fields the contract does not know are ignored. A
 * catalog with a newer schema is refused as a whole: its fields may mean
 * something else now.
 */
export function parseCatalog(raw: unknown, opts: { sample?: boolean } = {}): ParsedCatalog {
  const problems: string[] = [];
  if (!isObject(raw)) return { release: null, images: [], problems: ['catalog is not a JSON object'], sample: false };
  const sample = opts.sample === true || '_sample' in raw;
  if (raw.schema !== CATALOG_SCHEMA) {
    const s = typeof raw.schema === 'number' ? `format ${raw.schema}` : 'no format number';
    return {
      release: null, images: [], sample,
      problems: [`catalog has ${s}; this version of the imager reads format ${CATALOG_SCHEMA}`],
    };
  }
  const release = parseRelease(raw.release, problems);
  if (!release) return { release: null, images: [], problems, sample };
  if (!Array.isArray(raw.images)) {
    problems.push('catalog: "images" is not a list');
    return { release, images: [], problems, sample };
  }
  const images: CatalogImage[] = [];
  const seen = new Set<string>();
  raw.images.forEach((item, i) => {
    const img = parseImage(item, i, release, sample, problems);
    if (!img) return;
    if (seen.has(img.id)) {
      problems.push(`image ${i + 1}: ${img.file} is listed twice`);
      return;
    }
    seen.add(img.id);
    images.push(img);
  });
  return { release, images, problems, sample };
}

export interface Board {
  board: string;
  boardName: string;
  soc: string;
  /** Images for this board, newest release first. */
  images: CatalogImage[];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Group images by board; boards sorted by name, images newest first. */
export function groupByBoard(images: CatalogImage[]): Board[] {
  const map = new Map<string, Board>();
  for (const img of images) {
    let b = map.get(img.board);
    if (!b) {
      b = { board: img.board, boardName: img.boardName, soc: img.soc, images: [] };
      map.set(img.board, b);
    }
    b.images.push(img);
  }
  for (const b of map.values()) {
    b.images.sort((x, y) => compareVersions(y.releaseInfo.version, x.releaseInfo.version)
      || x.branch.localeCompare(y.branch) || x.release.localeCompare(y.release));
  }
  return [...map.values()].sort((a, b) => a.boardName.localeCompare(b.boardName));
}

/** The parts of a GitHub release (GET /repos/{repo}/releases) the imager reads. */
export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string; digest?: string | null }[];
}

/**
 * Which catalog asset to fetch for each release, newest first. Drafts and
 * releases without a catalog are skipped.
 */
export function catalogAssets(releases: GithubRelease[]): { tag: string; url: string }[] {
  const out: { tag: string; url: string }[] = [];
  for (const r of releases) {
    if (r.draft) continue;
    const a = r.assets.find((x) => x.name === CATALOG_ASSET);
    if (a) out.push({ tag: r.tag_name, url: a.browser_download_url });
  }
  return out;
}

/**
 * Check a parsed catalog against the GitHub release it came from: same tag,
 * same pre-release flag, and where GitHub publishes an asset digest, the
 * image's sha256 must equal it. Images that disagree are removed.
 */
export function checkAgainstRelease(cat: ParsedCatalog, gh: GithubRelease): ParsedCatalog {
  const problems = [...cat.problems];
  if (!cat.release) return cat;
  if (cat.release.tag !== gh.tag_name) {
    problems.push(`catalog in release ${gh.tag_name} says it belongs to ${cat.release.tag}`);
    return { ...cat, images: [], problems };
  }
  const release = { ...cat.release };
  if (release.prerelease !== gh.prerelease) {
    // GitHub's flag is what people see on the release page; trust it.
    problems.push(`release ${gh.tag_name}: catalog and GitHub disagree about pre-release; using GitHub's`);
    release.prerelease = gh.prerelease;
  }
  const images: CatalogImage[] = [];
  for (const img of cat.images) {
    const asset = gh.assets.find((a) => a.name === img.file);
    if (!asset) {
      problems.push(`${img.file}: not attached to release ${gh.tag_name}`);
      continue;
    }
    const digest = asset.digest ?? '';
    if (digest.startsWith('sha256:') && digest.slice(7) !== img.sha256) {
      problems.push(`${img.file}: catalog sha256 differs from the digest GitHub publishes`);
      continue;
    }
    images.push({ ...img, releaseInfo: release });
  }
  return { ...cat, release, images, problems };
}
