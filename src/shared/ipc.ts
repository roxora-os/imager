// What the preload script exposes to the page as window.imager.
import type { CatalogImage } from './catalog';
import type { HiddenDrive, Target } from './targets';

export type CatalogResult =
  | { state: 'ok'; images: CatalogImage[]; problems: string[]; sample: boolean }
  | { state: 'none'; problems: string[]; sample: false }
  | { state: 'error'; message: string; problems: string[]; sample: false };

export type JobProgress = {
  stage: 'download' | 'check' | 'decompress' | 'write' | 'verify';
  bytes: number;
  total: number;
  speed?: number;
};

export type JobResult = { ok: true; sha256: string } | { ok: false; reason: string; detail?: string };

export interface PreparedFile {
  token: string;
  url: string;
  /** Web build: the picked file itself; the worker reads it. */
  file?: File;
  size: number;
  /** SHA-256 the written bytes must have, or null for a local file without one. */
  sha256: string | null;
  name: string;
}

export interface ImagerApi {
  platform: string;
  version: string;
  devSample: boolean;
  loadCatalog(opts: { sample: boolean }): Promise<CatalogResult>;
  listDrives(minSize: number): Promise<{ targets: Target[]; hidden: HiddenDrive[] }>;
  writeSd(imageId: string, device: string): Promise<JobResult>;
  cancel(): Promise<void>;
  onProgress(cb: (p: JobProgress) => void): () => void;
  prepareMaskrom(imageId: string, what?: 'image' | 'spi'): Promise<PreparedFile | { error: string }>;
  pickMaskromFile(): Promise<PreparedFile | { error: string } | null>;
  /**
   * Web build only: the user picks the release file they downloaded; it is
   * checked against the catalog before it is accepted.
   */
  pickReleaseFile?(imageId: string, what: 'image' | 'spi', onProgress: (done: number, total: number) => void):
    Promise<PreparedFile | { error: string } | null>;
  /**
   * Web build with a download proxy: its host name, shown to the user.
   * Null or missing when the build has none.
   */
  downloadProxy?: string | null;
  /**
   * Web build with a download proxy: download the release file through it,
   * checking size and SHA-256 while it streams. An error means the page
   * falls back to pickReleaseFile.
   */
  downloadReleaseFile?(imageId: string, what: 'image' | 'spi', onProgress: (done: number, total: number) => void):
    Promise<PreparedFile | { error: string }>;
  releaseMaskrom(token: string): Promise<void>;
  onUsbChoice(cb: (choices: { deviceId: string; productName?: string; productId: number }[]) => void): () => void;
  answerUsbChoice(deviceId: string): void;
  getSettings(): Promise<{ updateCheck: boolean; resetAfterMaskrom: boolean }>;
  setSettings(s: { updateCheck?: boolean; resetAfterMaskrom?: boolean }): Promise<void>;
  checkUpdate(force: boolean): Promise<{ version: string; url: string } | null>;
  openExternal(url: string): Promise<void>;
  setTheme(theme: 'light' | 'dark'): void;
}
