// Is a newer version of the app out? Pure logic; main/updater.ts does the I/O.

export const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;

/** Compare dotted versions: 2026.11.2 > 2026.11.10 is false. Pre-release suffixes sort first. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main, pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((x) => Number.parseInt(x, 10) || 0), pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Should a check run now? */
export function checkDue(enabled: boolean, last: number, now: number): boolean {
  return enabled && (now - last >= UPDATE_INTERVAL || now < last);
}

export interface AppRelease {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
}

/** The newer release, if `latest` is newer than `current`. */
export function newerRelease(current: string, latest: AppRelease | null): { version: string; url: string } | null {
  if (!latest || latest.draft || latest.prerelease) return null;
  const v = latest.tag_name.replace(/^v/, '');
  return compareVersions(v, current) > 0 ? { version: v, url: latest.html_url } : null;
}
