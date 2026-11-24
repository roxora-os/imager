// What the app keeps that can be thrown away, and throwing it away: the
// downloaded release images and their decompressed copies (<data>/images)
// and the Maskrom loaders built from rkbin (<data>/loaders). Both come back
// when needed: images are downloaded again, loaders built again. The
// settings stay. No Electron here; main.ts passes the data folder.

import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

export interface CachePart { dir: string; bytes: number; files: number; names: string[] }
export interface CacheInfo { images: CachePart; loaders: CachePart }

function measure(dir: string): CachePart {
  const out: CachePart = { dir, bytes: 0, files: 0, names: [] };
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else { out.bytes += st.size; out.files++; }
    }
  };
  walk(dir);
  out.names = readdirSync(dir).sort();
  return out;
}

export function cacheInfo(dataDir: string): CacheInfo {
  return { images: measure(join(dataDir, 'images')), loaders: measure(join(dataDir, 'loaders')) };
}

/** Is `path` inside the cache of `dataDir`? */
export function inCache(dataDir: string, path: string): boolean {
  return ['images', 'loaders'].some((d) => {
    const r = relative(join(dataDir, d), path);
    return r !== '' && !r.startsWith('..') && !isAbsolute(r);
  });
}

export type ClearResult = { ok: true; freed: number; kept: CacheInfo } | { ok: false; reason: string };

/**
 * Delete the downloads and the loaders. Refused while a job runs or a
 * cached file is being read for a write: it may be reading or writing them.
 */
export function clearCache(dataDir: string, o: { busy: boolean }): ClearResult {
  if (o.busy) return { ok: false, reason: 'A write is running. Clear the cache when it has finished.' };
  const before = cacheInfo(dataDir);
  for (const p of [before.images, before.loaders]) rmSync(p.dir, { recursive: true, force: true });
  const kept = cacheInfo(dataDir);
  const freed = before.images.bytes + before.loaders.bytes - (kept.images.bytes + kept.loaders.bytes);
  return { ok: true, freed, kept };
}
