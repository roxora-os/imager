// Every native binary in an unpacked package (.node addons, .exe, .dll,
// unpacked from app.asar or not) is built for the given CPU.
//   node scripts/check-native-arch.mjs dist/win-arm64-unpacked arm64
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { machines } from './lib/machine.mjs';

const [dir, arch] = process.argv.slice(2);
if (!dir || !arch) { console.error('usage: check-native-arch.mjs DIR ARCH'); process.exit(2); }
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
// electron-builder's NSIS elevate.exe is a 32-bit x86 helper on every
// Windows build; Windows runs it on x64 and on arm64 alike.
const ALLOWED = { 'elevate.exe': ['ia32'] };
// winusb-driver-generator carries Microsoft's WDF co-installers for x86 and
// x64 as files it copies into a driver package; the app never loads them.
const DATA = /winusb-driver-generator[\\/]deps[\\/]wdk_10_redist_/;
// The addons the app loads: each must be there, built for this CPU.
const NEEDED = ['drivelist', 'mountutils', 'lzma-native', 'direct-io'];
let bad = 0;
let seen = 0;
for (const f of walk(dir)) {
  if (!/\.(node|exe|dll)$/i.test(f) || DATA.test(f)) continue;
  const m = machines(f);
  if (m.length === 0) continue;
  seen++;
  const ok = m.includes(arch) || (ALLOWED[f.split(/[\\/]/).pop().toLowerCase()] ?? []).some((a) => m.includes(a));
  if (!ok || /\.node$/.test(f)) console.log(`${ok ? 'ok  ' : 'BAD '} ${m.join('+').padEnd(6)} ${f}`);
  if (!ok) bad++;
}
const nodes = walk(dir).filter((f) => f.endsWith('.node') && machines(f).includes(arch));
for (const n of NEEDED) {
  if (!nodes.some((f) => f.includes(`${n}${process.platform === 'win32' ? '\\' : '/'}`) || f.includes(`${n}/`))) { console.log(`MISSING: no ${arch} .node of ${n}`); bad++; }
}
console.log(bad ? `FAIL: ${bad} of ${seen} native binaries are not ${arch}` : `all ${seen} native binaries are ${arch}`);
process.exit(bad ? 1 : 0);
