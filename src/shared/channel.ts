// Three tiers of Roxora Imager's own releases, chosen in Settings for its
// updates:
//   stable      the newest release that is not a pre-release;
//   prerelease  the newest release, pre-releases included;
//   ci          the rolling release tagged "ci", which the Release workflow
//               replaces on every successful build of main (a pre-release
//               named "CI build <sha> <date>"). It is never a candidate for
//               the other two tiers.
// Newest is by version (compareVersions), not by date. Drafts never count.

import { compareVersions } from './update';

export type Channel = 'stable' | 'prerelease' | 'ci';
export const CHANNELS: Channel[] = ['stable', 'prerelease', 'ci'];
export const CI_TAG = 'ci';

export interface TieredRelease { tag_name: string; name?: string | null; body?: string | null; draft?: boolean; prerelease?: boolean; target_commitish?: string }

const version = (r: TieredRelease) => r.tag_name.replace(/^v/, '');
const isPre = (r: TieredRelease) => r.prerelease === true || version(r).includes('-');

export function isChannel(v: unknown): v is Channel {
  return v === 'stable' || v === 'prerelease' || v === 'ci';
}

/** The release a tier means in this list, or null. */
export function pickRelease<T extends TieredRelease>(list: T[], channel: Channel): T | null {
  const ok = list.filter((r) => r && typeof r.tag_name === 'string' && !r.draft);
  if (channel === 'ci') return ok.find((r) => r.tag_name === CI_TAG) ?? null;
  let best: T | null = null;
  for (const r of ok) {
    if (r.tag_name === CI_TAG) continue;
    if (channel === 'stable' && isPre(r)) continue;
    if (!best || compareVersions(version(r), version(best)) > 0) best = r;
  }
  return best;
}

/** The commit a CI release was built from: its name ("CI build 1a2b3c4 ..."), else "Built from <sha>" in its body. */
export function ciCommit(r: TieredRelease): string | null {
  const n = /\bCI build ([0-9a-f]{7,40})\b/i.exec(r.name ?? '');
  if (n) return n[1].toLowerCase();
  const b = /\bBuilt from ([0-9a-f]{7,40})\b/i.exec(r.body ?? '');
  return b ? b[1].toLowerCase() : null;
}

/** Whether two commit ids (full or short) name the same commit. */
export function sameCommit(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** What the page shows for a release: "0.4.1", or "CI build 1a2b3c4". */
export function releaseLabel(r: TieredRelease): string {
  if (r.tag_name === CI_TAG) return `CI build ${ciCommit(r) ?? '?'}`;
  return r.tag_name;
}
