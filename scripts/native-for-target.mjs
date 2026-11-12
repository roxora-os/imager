// Before packaging: make node_modules hold native addons for the target only.
// Prebuilds for other systems and CPUs are removed, and a prebuild built for
// the wrong CPU is replaced by a build from source (lzma-native 8.0.6 ships
// x86-64 files in prebuilds/linux-arm64/). Run on a runner of the target CPU.
//   node scripts/native-for-target.mjs [arch]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { machines } from './lib/machine.mjs';

const platform = process.platform;
const arch = process.argv[2] ?? process.arch;
const target = `${platform}-${arch}`;

function packages(dir = 'node_modules') {
  const out = [];
  for (const n of readdirSync(dir)) {
    if (n.startsWith('.')) continue;
    const p = join(dir, n);
    if (n.startsWith('@')) out.push(...packages(p));
    else if (statSync(p).isDirectory()) out.push(p, ...(existsSync(join(p, 'node_modules')) ? packages(join(p, 'node_modules')) : []));
  }
  return out;
}

const nodeFiles = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.node')).map((f) => join(d, f)) : []);
let failed = false;
for (const pkg of packages()) {
  const pre = join(pkg, 'prebuilds');
  if (!existsSync(pre)) continue;
  for (const d of readdirSync(pre)) {
    if (d !== target) { rmSync(join(pre, d), { recursive: true, force: true }); continue; }
    for (const f of nodeFiles(join(pre, d))) {
      if (machines(f).includes(arch)) continue;
      let built = nodeFiles(join(pkg, 'build', 'Release')).find((b) => machines(b).includes(arch));
      if (!built) {
        console.log(`${pkg}: building from source for ${arch}`);
        execFileSync('npx', ['node-gyp', 'rebuild'], { cwd: pkg, stdio: 'inherit', shell: platform === 'win32' });
        built = nodeFiles(join(pkg, 'build', 'Release')).find((b) => machines(b).includes(arch));
      }
      if (!built) { console.log(`FAIL: ${f} is ${machines(f).join('+')}, and no ${arch} build of ${pkg} could be made`); failed = true; continue; }
      const was = machines(f).join('+') || 'not a native binary';
      copyFileSync(built, f);
      console.log(`${f}: was ${was}, replaced by ${built} (${arch})`);
    }
  }
}
console.log(failed ? 'FAIL' : `native addons are for ${target}`);
process.exit(failed ? 1 : 0);
