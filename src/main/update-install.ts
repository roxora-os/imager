// Getting a new version of the app onto the computer: the release list, the
// download checked against the SHA-256 GitHub lists for the file, and the
// steps that need no Electron (so the tests can run them against a local
// server). main/updater.ts decides which of them applies and asks the user.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppRelease, InstallKind } from '../shared/update';

export const APP_REPO = 'roxora-os/imager';
/** Ten is enough to find the newest normal release behind a few betas. */
export const RELEASES_API = `https://api.github.com/repos/${APP_REPO}/releases?per_page=10`;
/** Release files are only ever downloaded from here. */
export const DOWNLOAD_PREFIX = `https://github.com/${APP_REPO}/releases/download/`;

export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export async function fetchReleases(fetchFn: Fetch, api = RELEASES_API): Promise<AppRelease[]> {
  const r = await fetchFn(api, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'roxora-imager' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const list = await r.json();
  if (!Array.isArray(list)) throw new Error('not a list of releases');
  return list as AppRelease[];
}

export interface Download {
  url: string;
  /** Where the checked file ends up. Until then the data is in `${dest}.part`. */
  dest: string;
  /** The SHA-256 GitHub lists for the file. Without it nothing is downloaded. */
  sha256: string | null;
  fetch: Fetch;
  onProgress?: (bytes: number, total: number) => void;
  signal?: AbortSignal;
  /** Expected size, for the progress bar when the server states none. */
  size?: number;
}

/** Download a file and keep it only if its SHA-256 is the expected one. */
export async function downloadVerified(d: Download): Promise<void> {
  if (!d.sha256 || !/^[0-9a-f]{64}$/.test(d.sha256)) {
    throw new Error(`GitHub lists no SHA-256 for ${basename(d.dest)}, so it cannot be checked. Nothing was downloaded.`);
  }
  const part = `${d.dest}.part`;
  const h = createHash('sha256');
  let done = 0;
  try {
    const r = await d.fetch(d.url, { signal: d.signal });
    if (!r.ok || !r.body) throw new Error(`Download failed: HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length')) || d.size || 0;
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        h.update(chunk);
        done += chunk.length;
        d.onProgress?.(done, Math.max(total, done));
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(r.body as never), count, createWriteStream(part), { signal: d.signal });
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  const got = h.digest('hex');
  if (got !== d.sha256) {
    rmSync(part, { force: true });
    throw new Error(`The download is not the published file: its SHA-256 is ${got}, GitHub lists ${d.sha256}. It was deleted.`);
  }
  renameSync(part, d.dest);
}

/**
 * Put a new AppImage in place of the running one. It is downloaded into the
 * same folder, checked, made executable, and renamed over the old file in
 * one step, so there is never a half-written AppImage under that name. The
 * running app keeps the old file open until it exits.
 */
export async function replaceAppImage(current: string, d: Omit<Download, 'dest'>): Promise<void> {
  const mode = statSync(current).mode & 0o777;
  const next = join(dirname(current), `.${basename(current)}.update`);
  await downloadVerified({ ...d, dest: next });
  try {
    chmodSync(next, mode | 0o111);
    renameSync(next, current);
  } catch (e) {
    rmSync(next, { force: true });
    throw e;
  }
}

/** The package manager command that installs a downloaded .deb or .rpm, as root. */
export function packageInstallCommand(kind: InstallKind, file: string, has: (program: string) => boolean): string[] | null {
  if (kind === 'deb' && has('apt-get')) return ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', file];
  if (kind === 'rpm' && has('dnf')) return ['dnf', 'install', '-y', file];
  if (kind === 'rpm' && has('zypper')) return ['zypper', '--non-interactive', 'install', '--allow-unsigned-rpm', file];
  return null;
}

/** The same for a person to type. */
export function shellCommand(argv: string[]): string {
  const q = (a: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return `sudo ${argv.filter((a) => a !== 'env' && !a.startsWith('DEBIAN_FRONTEND=')).map(q).join(' ')}`;
}

export function programExists(program: string): boolean {
  return ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin'].some((d) => existsSync(join(d, program)));
}

/** Run a command as root through polkit's pkexec. Resolves with its exit status; 126 and 127 mean the user did not authorise it. */
export function pkexec(argv: string[], signal?: AbortSignal): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('pkexec', argv, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = '';
    const add = (b: Buffer) => { output = (output + b.toString()).slice(-4000); };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, output }));
  });
}
