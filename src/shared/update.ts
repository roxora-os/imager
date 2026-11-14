// Is a newer version of the app out, and how would this copy be updated?
// Pure logic; main/updater.ts and main/update-install.ts do the I/O.

export const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;

/**
 * Compare dotted versions numerically: 0.1.10 is newer than 0.1.9. A version
 * with a suffix (0.1.5-beta.2) is older than the same version without one,
 * and suffixes compare piece by piece, numbers as numbers (beta.10 after
 * beta.2).
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const s = v.replace(/^v/, '');
    const i = s.indexOf('-');
    const main = i < 0 ? s : s.slice(0, i);
    return { nums: main.split('.').map((x) => Number.parseInt(x, 10) || 0), pre: i < 0 ? null : s.slice(i + 1).split('.') };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === q ? 0 : p === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) - Number(q); } else if (p !== q) {
      return pn ? -1 : qn ? 1 : p < q ? -1 : 1;
    }
  }
  return 0;
}

/** Should a check run now? */
export function checkDue(enabled: boolean, last: number, now: number): boolean {
  return enabled && (now - last >= UPDATE_INTERVAL || now < last);
}

export interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
  /** "sha256:<hex>", as GitHub lists it for a release asset. */
  digest?: string | null;
}

export interface AppRelease {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  /** On GitHub a pre-release of Roxora Imager is a beta version. */
  prerelease?: boolean;
  body?: string | null;
  assets?: ReleaseAsset[];
}

const versionOf = (r: AppRelease) => r.tag_name.replace(/^v/, '');
/** A beta: marked as a pre-release on GitHub, or a version with a suffix. */
const isBeta = (r: AppRelease) => r.prerelease === true || versionOf(r).includes('-');

/**
 * The release with the highest version. Drafts never count; betas only
 * when asked for. GitHub's own "latest" is not used: it is by date.
 */
export function newestRelease(list: AppRelease[], opts: { beta: boolean }): AppRelease | null {
  let best: AppRelease | null = null;
  for (const r of list) {
    if (!r || typeof r.tag_name !== 'string' || r.draft || (!opts.beta && isBeta(r))) continue;
    if (!best || compareVersions(versionOf(r), versionOf(best)) > 0) best = r;
  }
  return best;
}

/** One line for the notice: the first item of the release notes. */
export function whatsNew(body: string | null | undefined, max = 180): string {
  const lines = (body ?? '').replace(/\r/g, '').split('\n');
  let i = lines.findIndex((l) => /^\s*[-*] /.test(l));
  let text: string;
  if (i >= 0) {
    text = lines[i].replace(/^\s*[-*] /, '');
    for (i++; i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*[-*] /.test(lines[i]); i++) text += ` ${lines[i].trim()}`;
  } else {
    text = lines.find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';
  }
  text = text.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3).replace(/\s+\S*$/, '')}...` : text;
}

/**
 * How this copy of the app got onto the computer, which decides how it is
 * updated: 'brew' a Homebrew cask, 'dmg' a macOS app from the DMG or
 * install.sh, 'windows' the NSIS installer, 'appimage', 'deb', 'rpm';
 * 'none' for anything the app does not update (a development run, the
 * Windows zip, an unpacked folder).
 */
export type InstallKind = 'brew' | 'dmg' | 'windows' | 'appimage' | 'deb' | 'rpm' | 'none';

export interface InstallFacts {
  platform: string;
  packaged: boolean;
  /** $APPIMAGE, set by the AppImage runtime. */
  appImage?: string;
  /** macOS: the app bundle belongs to a Homebrew cask (brewCaskOwns). */
  brew?: boolean;
  /** Windows: the NSIS uninstaller is next to the app. */
  nsis?: boolean;
  /** Linux: the dpkg or rpm database owns the executable. */
  dpkg?: boolean;
  rpm?: boolean;
}

export function installKind(f: InstallFacts): InstallKind {
  if (!f.packaged) return 'none';
  if (f.platform === 'darwin') return f.brew ? 'brew' : 'dmg';
  if (f.platform === 'win32') return f.nsis ? 'windows' : 'none';
  if (f.platform === 'linux') return f.appImage ? 'appimage' : f.dpkg ? 'deb' : f.rpm ? 'rpm' : 'none';
  return 'none';
}

export const BREW_CASK = 'roxora-imager';
export const BREW_COMMAND = `brew upgrade --cask ${BREW_CASK}`;

/**
 * Is the app bundle at `appPath` one a Homebrew cask installed? Either it
 * lies inside a Caskroom, or (what Homebrew does today: the app is moved to
 * /Applications and a link is left behind) a Caskroom holds a link to it.
 */
export function brewCaskOwns(appPath: string, fs: {
  realpath: (p: string) => string; readdir: (p: string) => string[];
}, prefixes: string[] = ['/opt/homebrew', '/usr/local']): boolean {
  const real = (p: string) => { try { return fs.realpath(p); } catch { return null; } };
  const app = real(appPath) ?? appPath;
  if (/\/Caskroom\/[^/]+\//.test(app) || /\/Caskroom\/[^/]+\//.test(appPath)) return true;
  for (const prefix of prefixes) {
    const room = `${prefix}/Caskroom/${BREW_CASK}`;
    let versions: string[];
    try { versions = fs.readdir(room); } catch { continue; }
    for (const v of versions) {
      let entries: string[];
      try { entries = fs.readdir(`${room}/${v}`); } catch { continue; }
      if (entries.some((e) => e.endsWith('.app') && real(`${room}/${v}/${e}`) === app)) return true;
    }
  }
  return false;
}

/** The release file for this kind of install and CPU ('x64' or 'arm64'), as release.yml names them. */
export function pickAsset(assets: ReleaseAsset[] | undefined, kind: InstallKind, arch: string): ReleaseAsset | null {
  const a64 = arch === 'arm64';
  const pattern: Partial<Record<InstallKind, RegExp>> = {
    dmg: a64 ? /-macos-arm64\.dmg$/ : /-macos-x86_64\.dmg$/,
    windows: /-windows-x64-setup\.exe$/,
    appimage: a64 ? /-linux-arm64\.AppImage$/ : /-linux-x86_64\.AppImage$/,
    deb: a64 ? /_arm64\.deb$/ : /_amd64\.deb$/,
    rpm: a64 ? /\.aarch64\.rpm$/ : /\.x86_64\.rpm$/,
  };
  const re = pattern[kind];
  if (!re || (arch !== 'x64' && arch !== 'arm64') || (kind === 'windows' && a64)) return null;
  return (assets ?? []).find((a) => typeof a?.name === 'string' && re.test(a.name) && !/[\\/]/.test(a.name)) ?? null;
}

/** The SHA-256 GitHub lists for an asset, or null: without it nothing is installed. */
export function assetSha256(a: ReleaseAsset): string | null {
  const m = /^sha256:([0-9a-f]{64})$/.exec(a.digest ?? '');
  return m ? m[1] : null;
}

/** What the page is told about a newer version. */
export interface UpdateOffer {
  version: string;
  /** The release page. */
  url: string;
  /** A beta version (a pre-release on GitHub). */
  beta: boolean;
  /** The first item of the release notes. */
  notes: string;
  kind: InstallKind;
  /** The file the app would download; null when this copy is updated another way. */
  asset: { name: string; size: number } | null;
}

export type UpdateCheck =
  | { state: 'newer'; offer: UpdateOffer }
  /** Nothing newer. `beta`: the running version is a beta; `newerBeta`: a newer beta exists but betas are not asked for. */
  | { state: 'current'; version: string; beta: boolean; newerBeta: string | null }
  | { state: 'error'; message: string };

/** What a release list means for the running version. */
export function judgeReleases(current: string, list: AppRelease[], o: { beta: boolean; kind: InstallKind; arch: string }): UpdateCheck {
  const pick = newestRelease(list, { beta: o.beta });
  if (pick && compareVersions(versionOf(pick), current) > 0) {
    const asset = pickAsset(pick.assets, o.kind, o.arch);
    return { state: 'newer', offer: {
      version: versionOf(pick), url: pick.html_url, beta: isBeta(pick), notes: whatsNew(pick.body), kind: o.kind,
      asset: asset ? { name: asset.name, size: asset.size } : null,
    } };
  }
  const mine = list.find((r) => !r.draft && compareVersions(versionOf(r), current) === 0);
  const any = o.beta ? null : newestRelease(list, { beta: true });
  return {
    state: 'current', version: current, beta: current.includes('-') || (!!mine && isBeta(mine)),
    newerBeta: any && compareVersions(versionOf(any), current) > 0 ? versionOf(any) : null,
  };
}

export type UpdateResult =
  /** `restart`: the new version is in place and starts when the app is restarted. */
  | { ok: true; message: string; restart: boolean }
  /** `command`: what the user can run instead. */
  | { ok: false; reason: string; command?: string };
