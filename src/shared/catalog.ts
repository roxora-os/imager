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
export function flavorRank(flavor: string): number {
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

/**
 * One part of an image that a release carries in parts: GitHub takes no
 * release file of 2 GiB or more, so a larger .img.xz is published as
 * <file>.part1, <file>.part2, ... (releases up to 2026.11.6) or <file>.001,
 * <file>.002, ... (later releases, which 7-Zip opens as one file), listed in
 * images[].parts in the catalog. One image uses one of the two forms. The
 * parts joined in order are the file.
 */
export interface ImagePart {
  file: string;
  url: string;
  size: number;
  sha256: string;
}

/** More parts than this and "<file>.part*" would no longer sort in order. */
export const MAX_PARTS = 9;

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
  /** Where the .img.xz downloads from; empty for an image in parts. */
  url: string;
  /** The parts to download and join, in order; empty for an image that is one file. */
  parts: ImagePart[];
  /** Size and SHA-256 of the .img.xz: for an image in parts, of the joined file. */
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
/** YYYY.MM.N, or YYYY.MM.N-beta.N for a beta (roxora-os/build release.yml). */
const VERSION = /^\d{4}\.\d{2}\.\d+(-beta\.\d+)?$/;
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
  if (version && !VERSION.test(version)) problems.push(`release: version "${version}" is not YYYY.MM.N or YYYY.MM.N-beta.N`);
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
  // An image in parts has "parts" in place of "url".
  const split = raw.parts !== undefined && raw.parts !== null;
  if (split && raw.url !== undefined) problems.push(`${where}: has both "url" and "parts"`);
  const url = split ? '' : str(raw, 'url', problems, where);
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
  if (!split && url !== expectedUrl) problems.push(`${name}: url is not ${expectedUrl}`);
  if (extractSize! < size!) problems.push(`${name}: extract_size is smaller than size`);
  const parts = split ? parseParts(raw.parts, name, release, file!, size!, problems) : [];
  if (problems.length !== n) return null;
  const spi = parseSpi(raw.spi, name, release, file!, problems);

  return {
    id: `${release.tag}/${file}`,
    board: board!, boardName: boardName!, vendor, soc: soc!, release: rel!, ubuntuVersion: ubuntuVersion!,
    branch: branch!, flavor, kernel, file: file!, url: url!, parts, size: size!, sha256: sha256!,
    extractSize: extractSize!, extractSha256: extractSha256!, status: status as ImageStatus,
    verifyUrl, spi, releaseInfo: release, sample,
  };
}

/**
 * The parts of a split image. Any fault drops the image: a part that is
 * wrong makes the whole file wrong.
 */
function parseParts(raw: unknown, name: string, release: CatalogRelease, imageFile: string, size: number,
  problems: string[]): ImagePart[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_PARTS) {
    problems.push(`${name}: "parts" is not a list of 2 to ${MAX_PARTS} parts`);
    return [];
  }
  const parts: ImagePart[] = [];
  let total = 0;
  // The form the first part is named in is the form of every part.
  const first = isObject(raw[0]) ? raw[0].file : undefined;
  const numbered = first === `${imageFile}.001`;
  const partName = (i: number) => numbered ? `${imageFile}.${String(i + 1).padStart(3, '0')}` : `${imageFile}.part${i + 1}`;
  raw.forEach((item, i) => {
    const where = `${name} part ${i + 1}`;
    if (!isObject(item)) {
      problems.push(`${where}: not an object`);
      return;
    }
    const n = problems.length;
    const file = str(item, 'file', problems, where);
    const url = str(item, 'url', problems, where);
    const psize = int(item, 'size', problems, where);
    const sha256 = str(item, 'sha256', problems, where);
    if (problems.length !== n) return;
    const expectedFile = partName(i);
    if (file !== expectedFile) problems.push(`${where}: file name should be ${expectedFile}`);
    // Parts, like whole images, are only ever downloaded from this release.
    const expectedUrl = `${DOWNLOAD_PREFIX}${release.tag}/${file}`;
    if (url !== expectedUrl) problems.push(`${where}: url is not ${expectedUrl}`);
    if (!HEX64.test(sha256!)) problems.push(`${where}: sha256 is not 64 lower-case hex digits`);
    if (problems.length !== n) return;
    total += psize!;
    parts.push({ file: file!, url: url!, size: psize!, sha256: sha256! });
  });
  if (parts.length !== raw.length) return [];
  if (total !== size) {
    problems.push(`${name}: the parts add up to ${total} bytes, not the image's ${size}`);
    return [];
  }
  return parts;
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

/**
 * Orders versions such as 2026.11.5 and 2026.12.1-beta.2: by the numbers,
 * then a release after its own betas, then by beta number.
 */
function compareVersions(a: string, b: string): number {
  const nums = (v: string) => v.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const [ma, sa] = splitSuffix(a);
  const [mb, sb] = splitSuffix(b);
  const pa = nums(ma);
  const pb = nums(mb);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  if (sa === sb) return 0;
  if (sa === null) return 1;
  if (sb === null) return -1;
  const qa = nums(sa.replace(/^[^.\d]*\.?/, ''));
  const qb = nums(sb.replace(/^[^.\d]*\.?/, ''));
  return (qa[0] ?? 0) - (qb[0] ?? 0) || sa.localeCompare(sb);
}

function splitSuffix(v: string): [string, string | null] {
  const i = v.indexOf('-');
  return i < 0 ? [v, null] : [v.slice(0, i), v.slice(i + 1)];
}

/** The Image step's sortable columns. */
export type ImageSortKey = 'release' | 'ubuntu' | 'desktop' | 'kernel' | 'size';

/** Order two images by one column, ascending; ties keep the default order (stable sort). */
export function compareImages(a: CatalogImage, b: CatalogImage, key: ImageSortKey): number {
  switch (key) {
    case 'release': return compareVersions(a.releaseInfo.version, b.releaseInfo.version);
    case 'ubuntu': return ubuntuNumber(a.ubuntuVersion) - ubuntuNumber(b.ubuntuVersion);
    case 'desktop': return flavorRank(a.flavor) - flavorRank(b.flavor);
    case 'kernel': return a.branch.localeCompare(b.branch) || compareVersions(a.kernel ?? '', b.kernel ?? '');
    case 'size': return a.size - b.size;
  }
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

/** One release's images for a board. */
export interface ReleaseImages {
  release: CatalogRelease;
  images: CatalogImage[];
}

/**
 * A board's images split by release: the one the image step shows, the
 * newest normal release (the newest beta when there is no normal one yet),
 * and every other release, newest first, which it folds away. Betas newer
 * than the shown release are among the others: they are optional.
 */
export function splitByRelease(images: CatalogImage[]): { current: ReleaseImages | null; others: ReleaseImages[] } {
  const map = new Map<string, ReleaseImages>();
  for (const img of images) {
    let r = map.get(img.releaseInfo.tag);
    if (!r) {
      r = { release: img.releaseInfo, images: [] };
      map.set(img.releaseInfo.tag, r);
    }
    r.images.push(img);
  }
  const all = [...map.values()].sort((a, b) => compareVersions(b.release.version, a.release.version));
  const current = all.find((r) => !r.release.prerelease) ?? all[0] ?? null;
  return { current, others: all.filter((r) => r !== current) };
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
    // What the release must hold: the image, or every one of its parts.
    const files = img.parts.length > 0 ? img.parts : [{ file: img.file, sha256: img.sha256 }];
    let bad = false;
    for (const f of files) {
      const asset = gh.assets.find((a) => a.name === f.file);
      if (!asset) {
        problems.push(`${f.file}: not attached to release ${gh.tag_name}`);
        bad = true;
        continue;
      }
      const digest = asset.digest ?? '';
      if (digest.startsWith('sha256:') && digest.slice(7) !== f.sha256) {
        problems.push(`${f.file}: catalog sha256 differs from the digest GitHub publishes`);
        bad = true;
      }
    }
    if (bad) continue;
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
