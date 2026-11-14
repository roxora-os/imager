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

/**
 * What an image is, images[].flavor in the catalog: a command line image or
 * one with a desktop. Catalogs from before the desktop images have no
 * flavor; their images are command line images. A flavor this version does
 * not know is shown by its catalog name.
 */
export const FLAVOR_NAMES: Record<string, string> = {
  cli: 'Command line',
  'gnome-minimal': 'GNOME desktop, minimal',
  gnome: 'GNOME desktop',
};

export function flavorWords(flavor: string): string {
  return FLAVOR_NAMES[flavor] ?? flavor;
}

/** Command line first, then the desktops from small to full, then flavors not known here. */
function flavorRank(flavor: string): number {
  const i = Object.keys(FLAVOR_NAMES).indexOf(flavor);
  return i < 0 ? Object.keys(FLAVOR_NAMES).length : i;
}

export interface CatalogRelease {
  tag: string;
  version: string;
  date: string;
  prerelease: boolean;
  url: string;
  armbianRef: string;
}

export interface SpiImage {
  file: string;
  url: string;
  size: number;
  sha256: string;
}

export interface CatalogImage {
  /** Stable key: "<tag>/<file>". */
  id: string;
  board: string;
  boardName: string;
  /** Board maker. Catalogs before 2026.11.1 have none: then the first word of boardName. */
  vendor: string;
  soc: string;
  release: string;
  ubuntuVersion: string;
  branch: string;
  /** "cli", "gnome-minimal" or "gnome"; "cli" when the catalog names none. */
  flavor: string;
  kernel: string;
  file: string;
  url: string;
  size: number;
  sha256: string;
  extractSize: number;
  extractSha256: string;
  status: ImageStatus;
  verifyUrl: string;
  /** The SPI bootloader image of the same build, for boards that boot from SPI NOR. */
  spi: SpiImage | null;
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
  const vendor = typeof raw.vendor === 'string' && raw.vendor.trim() ? raw.vendor.trim() : vendorFallback(boardName!);
  const flavor = typeof raw.flavor === 'string' && raw.flavor ? raw.flavor : 'cli';

  const name = `${where} (${file})`;
  for (const [k, v] of [['board', board], ['release', rel], ['branch', branch], ['soc', soc], ['flavor', flavor]] as const) {
    if (!NAME.test(v!)) problems.push(`${name}: ${k} "${v}" has characters a name cannot have`);
  }
  if (!HEX64.test(sha256!)) problems.push(`${name}: sha256 is not 64 lower-case hex digits`);
  if (!HEX64.test(extractSha256!)) problems.push(`${name}: extract_sha256 is not 64 lower-case hex digits`);
  if (status !== 'hardware-tested' && status !== 'ci-only') problems.push(`${name}: status "${status}" is unknown`);
  // A command line image has no flavor in its file name.
  const expectedFile = `roxora-${board}-${rel}-${branch}${flavor === 'cli' ? '' : `-${flavor}`}-${release.version}.img.xz`;
  if (file !== expectedFile) problems.push(`${name}: file name should be ${expectedFile}`);
  // Images are only ever downloaded from this release of roxora-os/build.
  const expectedUrl = `${DOWNLOAD_PREFIX}${release.tag}/${file}`;
  if (url !== expectedUrl) problems.push(`${name}: url is not ${expectedUrl}`);
  if (extractSize! < size!) problems.push(`${name}: extract_size is smaller than size`);
  if (problems.length !== n) return null;
  const spi = parseSpi(raw.spi, name, release, file!, problems);

  return {
    id: `${release.tag}/${file}`,
    board: board!, boardName: boardName!, vendor, soc: soc!, release: rel!, ubuntuVersion: ubuntuVersion!,
    branch: branch!, flavor, kernel, file: file!, url: url!, size: size!, sha256: sha256!,
    extractSize: extractSize!, extractSha256: extractSha256!, status: status as ImageStatus,
    verifyUrl, spi, releaseInfo: release, sample,
  };
}

/** Vendor for catalogs that have no vendor field: the first word of the board name. */
export function vendorFallback(boardName: string): string {
  return boardName.trim().split(/\s+/)[0] || boardName;
}

/**
 * The optional SPI image. A broken one is dropped (with a problem) and the
 * disk image kept: the SD card path does not need it.
 */
function parseSpi(raw: unknown, name: string, release: CatalogRelease, imageFile: string, problems: string[]): SpiImage | null {
  if (raw === undefined || raw === null) return null;
  const where = `${name} spi`;
  if (!isObject(raw)) {
    problems.push(`${where}: not an object`);
    return null;
  }
  const n = problems.length;
  const file = str(raw, 'file', problems, where);
  const url = str(raw, 'url', problems, where);
  const size = int(raw, 'size', problems, where);
  const sha256 = str(raw, 'sha256', problems, where);
  if (problems.length !== n) return null;
  const expectedFile = imageFile.replace(/\.img\.xz$/, '-spi.img');
  if (file !== expectedFile) problems.push(`${where}: file name should be ${expectedFile}`);
  const expectedUrl = `${DOWNLOAD_PREFIX}${release.tag}/${file}`;
  if (url !== expectedUrl) problems.push(`${where}: url is not ${expectedUrl}`);
  if (!HEX64.test(sha256!)) problems.push(`${where}: sha256 is not 64 lower-case hex digits`);
  if (size! > 256 * 1024 * 1024) problems.push(`${where}: size is too large for SPI flash`);
  if (problems.length !== n) return null;
  return { file: file!, url: url!, size: size!, sha256: sha256! };
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
  vendor: string;
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

/** Ubuntu LTS releases are April releases of even years (24.04, 26.04). */
export function isLts(ubuntuVersion: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(ubuntuVersion);
  return !!m && m[2] === '04' && Number(m[1]) % 2 === 0;
}

const ubuntuNumber = (v: string) => {
  const m = /^(\d+)\.(\d+)/.exec(v);
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
};

/**
 * Group images by board; boards sorted by name. Within a board: newest Roxora
 * release first, then the newest Ubuntu LTS (the default a user gets), then
 * newer Ubuntu before older, then the edge kernel before others, then the
 * command line image before the desktop ones.
 */
export function groupByBoard(images: CatalogImage[]): Board[] {
  const map = new Map<string, Board>();
  for (const img of images) {
    let b = map.get(img.board);
    if (!b) {
      b = { board: img.board, boardName: img.boardName, vendor: img.vendor, soc: img.soc, images: [] };
      map.set(img.board, b);
    }
    b.images.push(img);
  }
  for (const b of map.values()) {
    b.images.sort((x, y) => compareVersions(y.releaseInfo.version, x.releaseInfo.version)
      || Number(isLts(y.ubuntuVersion)) - Number(isLts(x.ubuntuVersion))
      || ubuntuNumber(y.ubuntuVersion) - ubuntuNumber(x.ubuntuVersion)
      || (x.branch === 'edge' ? 0 : 1) - (y.branch === 'edge' ? 0 : 1)
      || x.branch.localeCompare(y.branch) || x.release.localeCompare(y.release)
      || flavorRank(x.flavor) - flavorRank(y.flavor) || x.flavor.localeCompare(y.flavor));
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
    let spi = img.spi;
    if (spi) {
      const sa = gh.assets.find((a) => a.name === spi!.file);
      const sd = sa?.digest ?? '';
      if (!sa) {
        problems.push(`${spi.file}: not attached to release ${gh.tag_name}`);
        spi = null;
      } else if (sd.startsWith('sha256:') && sd.slice(7) !== spi.sha256) {
        problems.push(`${spi.file}: catalog sha256 differs from the digest GitHub publishes`);
        spi = null;
      }
    }
    images.push({ ...img, spi, releaseInfo: release });
  }
  return { ...cat, release, images, problems };
}
