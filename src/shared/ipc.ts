// What the preload script exposes to the page as window.imager.
import type { CatalogImage } from './catalog';
import type { HiddenDrive, Target } from './targets';
import type { UpdateCheck, UpdateResult } from './update';
import type { CacheInfo, ClearResult } from '../main/cache';

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
  /**
   * The size of the disk its partition table describes (maskrom/spi-check.ts),
   * 0 without one; missing where the start of the image could not be read.
   */
  diskSize?: number;
}

/** An image file on this computer, chosen for the SD card / USB drive path. */
export interface LocalImage {
  token: string;
  name: string;
  /** Size of the file itself. */
  size: number;
  /** Size once decompressed; 0 when only reading it all tells (gzip, bzip2). */
  extractSize: number;
  /**
   * The catalog image this file is (same name, same SHA-256), or null for a
   * custom image that no release vouches for.
   */
  imageId: string | null;
}

/** What to save as an image file: a release image, or the image file chosen on this computer. */
export type SaveSubject = { imageId: string } | { localToken: string };

/** Where the image is to be saved, chosen in the save dialog. */
export interface SaveTarget {
  token: string;
  /** The full path, shown to the user. */
  path: string;
  /** The folder it is in. */
  dir: string;
  /** Bytes free there, or -1 when the system cannot tell. */
  free: number;
}

export interface ImagerApi {
  platform: string;
  version: string;
  devSample: boolean;
  /** Desktop only: the user data folder (settings, downloads, loaders), for About. */
  dataDir?: string;
  loadCatalog(opts: { sample: boolean }): Promise<CatalogResult>;
  /** `internal`: also offer built-in disks that hold nothing in use (Linux; "Show internal disks"). */
  listDrives(minSize: number, internal?: boolean): Promise<{ targets: Target[]; hidden: HiddenDrive[] }>;
  /** `internal`: the device is a built-in disk the user confirmed; the writer checks it again. */
  writeSd(imageId: string, device: string, internal?: boolean): Promise<JobResult>;
  /** Desktop only: choose an image file on this computer for the SD/USB path. */
  pickLocalImage?(): Promise<LocalImage | { error: string } | null>;
  /** Desktop only: the same for a file dropped onto the window. */
  dropLocalImage?(file: File): Promise<LocalImage | { error: string }>;
  /** Desktop only: write the file chosen with one of the two above. */
  writeLocalImage?(token: string, device: string, internal?: boolean): Promise<JobResult>;
  /**
   * Desktop only: choose where to save the image as a plain .img file, in
   * the system's save dialog. `name` is the name it offers. Null when the
   * dialog was cancelled.
   */
  pickSaveFile?(name: string): Promise<SaveTarget | { error: string } | null>;
  /**
   * Desktop only: download (or read) the image, decompress it and save it
   * where pickSaveFile said, checked against the release. Needs no
   * administrator rights.
   */
  saveImage?(what: SaveSubject, saveToken: string): Promise<JobResult>;
  /** Desktop only: show the saved file in the system's file manager. */
  showSavedFile?(saveToken: string): Promise<void>;
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
  /**
   * The Maskrom loader `name` (boards.ts) as a URL the Maskrom worker can
   * fetch. Built from Rockchip's rkbin files on first use and checked
   * against its pin (maskrom/loaders.ts); the desktop app keeps it in its
   * user data folder.
   */
  getLoader(name: string): Promise<{ url: string } | { error: string }>;
  releaseMaskrom(token: string): Promise<void>;
  onUsbChoice(cb: (choices: { deviceId: string; productName?: string; productId: number }[]) => void): () => void;
  answerUsbChoice(deviceId: string): void;
  getSettings(): Promise<{ updateCheck: boolean; betaUpdates?: boolean; resetAfterMaskrom: boolean }>;
  setSettings(s: { updateCheck?: boolean; betaUpdates?: boolean; resetAfterMaskrom?: boolean }): Promise<void>;
  /** Desktop only: what the downloads and the Maskrom loaders take in the user data folder. */
  cacheInfo?(): Promise<CacheInfo>;
  /** Desktop only: delete them; refused while a write runs. */
  clearCache?(): Promise<ClearResult>;
  /**
   * Is a newer version out? `force`: the user asked; otherwise at most once
   * a day, and null when there is nothing to say. The web build is always
   * the newest and answers null.
   */
  checkUpdate(force: boolean): Promise<UpdateCheck | null>;
  /** Desktop only: download and install the version the last check offered. The page asks the user first. */
  installUpdate?(): Promise<UpdateResult>;
  cancelUpdate?(): Promise<void>;
  restartApp?(): Promise<void>;
  onUpdateProgress?(cb: (p: { bytes: number; total: number }) => void): () => void;
  /**
   * Where an update is: 'download' and 'brew-update' can be cancelled,
   * 'install' and 'brew-upgrade' cannot.
   */
  onUpdateStage?(cb: (stage: string) => void): () => void;
  /** What the programs an update runs print (Homebrew, hdiutil, ditto). */
  onUpdateLog?(cb: (text: string) => void): () => void;
  /**
   * Desktop only: put text on the clipboard through the main process. The
   * page itself has no clipboard permission. The web build uses
   * navigator.clipboard.
   */
  copyText?(text: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  setTheme(theme: 'light' | 'dark'): void;
}
