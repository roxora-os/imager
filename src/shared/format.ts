// Sizes for people: binary units, one decimal.
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} bytes` : `${v.toFixed(1)} ${units[i]}`;
}

export function statusWords(status: string): string {
  return status === 'hardware-tested' ? 'Tested on hardware' : 'Built and checked in CI, not yet booted on hardware';
}
