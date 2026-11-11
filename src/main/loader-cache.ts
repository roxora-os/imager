// The Maskrom loader in the user data folder (loaders/<name>): built from
// Rockchip's rkbin files the first time it is needed, checked against its
// pin every time it is used.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLoader, isPinnedLoader, LOADERS } from '../maskrom/loaders';

/** The path of the pinned loader `name` under `dir`, building it on first use. */
export async function ensureLoader(dir: string, name: string, fetchFn: (url: string) => Promise<Response>): Promise<string> {
  const pin = LOADERS[name];
  if (!pin) throw new Error(`No loader is known by the name ${name}.`);
  const path = join(dir, name);
  try {
    if (isPinnedLoader(pin, new Uint8Array(readFileSync(path)))) return path;
  } catch { /* not there yet */ }
  const data = await buildLoader(pin, fetchFn);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${path}.part`, data);
  renameSync(`${path}.part`, path);
  return path;
}

/** The cached loader's bytes, or null unless it is there and matches its pin. */
export function cachedLoader(dir: string, name: string): Uint8Array | null {
  const pin = LOADERS[name];
  if (!pin) return null;
  try {
    const data = new Uint8Array(readFileSync(join(dir, name)));
    return isPinnedLoader(pin, data) ? data : null;
  } catch {
    return null;
  }
}
