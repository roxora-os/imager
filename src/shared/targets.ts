// Which drives may be offered as SD/USB targets.
//
// Input is drivelist's view of the machine (etcher-sdk uses the same
// module). A drive is offered only when nothing suggests it holds the running
// system. The rule errs on the side of hiding: a hidden drive costs the user a
// moment, an offered system disk can cost them their computer.

export interface DriveInfo {
  device: string;
  raw?: string;
  description: string;
  size: number | null;
  mountpoints: { path: string; label?: string | null }[];
  isReadOnly: boolean;
  isSystem: boolean;
  isVirtual: boolean | null;
  isRemovable: boolean | null;
  isCard: boolean | null;
  isUSB: boolean | null;
  busType?: string;
}

export interface Target {
  device: string;
  description: string;
  size: number;
  mountpoints: string[];
  kind: 'sd' | 'usb' | 'disk';
  /** Set when the drive is offered but is not a good choice. */
  warning: string | null;
  /** Set when the drive is listed but cannot be chosen (too small). */
  disabled: string | null;
}

export interface HiddenDrive {
  device: string;
  description: string;
  reason: string;
}

/** Mount points that only a system disk has. */
const SYSTEM_MOUNTS = [
  /^\/$/, /^\/boot(\/|$)/, /^\/usr(\/|$)/, /^\/var(\/|$)/, /^\/home(\/|$)/, /^\/etc(\/|$)/,
  /^\/opt(\/|$)/, /^\/srv(\/|$)/, /^\/nix(\/|$)/, /^\[SWAP\]$/i,
  /^\/System(\/|$)/, /^\/private(\/|$)/, /^\/Library(\/|$)/, /^\/Applications(\/|$)/,
  /^[A-Za-z]:\\?$/, // a Windows drive letter: see below
];

/** Above this size a drive is offered with a warning: few SD cards or sticks are this large. */
export const LARGE_DRIVE = 128 * 1024 ** 3;

function systemMount(path: string, platform: string): boolean {
  if (/^[A-Za-z]:\\?$/.test(path)) {
    // Removable media get drive letters too; only the Windows drive counts.
    return platform === 'win32' && /^C:\\?$/i.test(path);
  }
  return SYSTEM_MOUNTS.some((re) => re.test(path));
}

export function classifyDrives(drives: DriveInfo[], opts: { minSize?: number; platform?: string } = {}):
  { targets: Target[]; hidden: HiddenDrive[] } {
  const platform = opts.platform ?? 'linux';
  const targets: Target[] = [];
  const hidden: HiddenDrive[] = [];
  for (const d of drives) {
    const hide = (reason: string) => hidden.push({ device: d.device, description: d.description, reason });
    const mounts = d.mountpoints.map((m) => m.path);
    if (d.isSystem) { hide('system disk'); continue; }
    const sys = mounts.find((m) => systemMount(m, platform));
    if (sys) { hide(`holds ${sys}`); continue; }
    if (d.isReadOnly) { hide('read-only'); continue; }
    if (d.isVirtual) { hide('virtual disk'); continue; }
    if (!d.size || d.size <= 0) { hide('size unknown'); continue; }
    if (platform === 'linux' && /^\/dev\/(loop|ram|zram|dm-|md|nbd|sr)/.test(d.device)) {
      hide('not a physical drive'); continue;
    }
    const kind: Target['kind'] = d.isCard ? 'sd' : d.isUSB ? 'usb' : 'disk';
    let warning: string | null = null;
    if (!d.isRemovable && !d.isUSB && !d.isCard) warning = 'This drive is not removable. Make sure it is not a disk you use.';
    else if (d.size > LARGE_DRIVE) warning = 'This drive is larger than most SD cards and USB sticks. Make sure it is the one you mean.';
    const disabled = opts.minSize && d.size < opts.minSize ? 'Too small for this image' : null;
    targets.push({ device: d.device, description: d.description, size: d.size, mountpoints: mounts, kind, warning, disabled });
  }
  targets.sort((a, b) => a.device.localeCompare(b.device));
  return { targets, hidden };
}

/** Is this device one classifyDrives() would offer? Used again just before writing. */
export function isOfferedTarget(device: string, drives: DriveInfo[], opts: { minSize?: number; platform?: string } = {}): boolean {
  const { targets } = classifyDrives(drives, opts);
  return targets.some((t) => t.device === device && !t.disabled);
}
