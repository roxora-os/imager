// End-to-end SD write to a loop device, for CI on Linux (needs sudo).
//
//   node test/e2e/sd-loop.mjs
//
// Runs the real write helper (build/helper/write-helper.js) the way the app
// starts it (main/elevate.ts: Electron in Node mode, a bootstrap file, a
// socket with a token), with sudo instead of pkexec. Checks:
//   1. an .img.xz is written to a loop device and the read-back matches;
//   2. the bytes on the device equal the image;
//   3. a wrong extract_sha256 is reported as a read-back mismatch;
//   4. the disk holding / is refused, and its first MiB is unchanged;
//   5. a loop device is refused when the test switch is off.
import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const work = mkdtempSync(join(tmpdir(), 'sd-e2e-'));
await build({ entryPoints: ['src/main/elevate.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'elevate.mjs'), logLevel: 'warning' });
const { helperLaunch, runHelper } = await import(join(work, 'elevate.mjs'));

const electronBin = join(root, 'node_modules/electron/dist/electron');
const helperPath = join(root, 'build/helper/write-helper.js');
const BIG = { maxBuffer: 256 * 1024 * 1024 };
const sh = (cmd, args) => execFileSync(cmd, args, BIG).toString().trim();
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`); if (!ok) failures++; };

// An image with an odd size, compressed with xz.
const img = join(work, 'test.img');
const data = randomBytes(40 * 1024 * 1024 + 4096 * 3 + 512);
writeFileSync(img, data);
const imgSha = createHash('sha256').update(data).digest('hex');
sh('xz', ['-T0', '-1', '-k', img]);
const xz = `${img}.xz`;

const backing = join(work, 'disk.bin');
sh('truncate', ['-s', '64M', backing]);
const loop = sh('sudo', ['losetup', '-f', '--show', backing]);
console.log(`loop device ${loop}`);

function elevateWith(extraEnv) {
  return (cmd, env) => new Promise((resolveP, reject) => {
    const vars = Object.entries({ ...env, ...extraEnv }).map(([k, v]) => `${k}=${v}`);
    const p = spawn('sudo', ['env', ...vars, 'sh', '-c', cmd], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('exit', (c) => (c === 0 ? resolveP() : reject(new Error(`exit ${c}`))));
  });
}

async function write(device, sha, extraEnv = { ROXORA_IMAGER_TEST: '1' }, allowLoop = true) {
  const progress = [];
  const out = await runHelper({
    launch: (dir) => helperLaunch({ execPath: electronBin, helperPath, dir, resourcesRelative: '' }),
    args: (socket, token) => ['--socket', socket, '--token', token, '--image', xz, '--device', device,
      '--extract-size', String(data.length), '--extract-sha256', sha, ...(allowLoop ? ['--allow-loop'] : [])],
    onMessage: (m) => { if (m.type === 'progress') progress.push(`${m.stage} ${m.percent}`); },
    elevate: elevateWith(extraEnv),
  });
  return { out, progress };
}

try {
  const a = await write(loop, imgSha);
  console.log(JSON.stringify(a.out));
  check(a.out.ok === true && a.out.sha256 === imgSha, 'write and read-back match the release checksum');
  check(a.progress.some((p) => p.startsWith('write')) && a.progress.some((p) => p.startsWith('verify')), 'progress reported for write and verify');
  const onDisk = execFileSync('sudo', ['head', '-c', String(data.length), loop], BIG);
  check(Buffer.compare(onDisk, data) === 0, 'device holds exactly the image');

  const b = await write(loop, '0'.repeat(64));
  console.log(JSON.stringify(b.out));
  check(b.out.ok === false && /does not read back/.test(b.out.reason), 'wrong checksum reported as a read-back mismatch');

  const rootSource = execFileSync('readlink', ['-f', sh('findmnt', ['-n', '-o', 'SOURCE', '/'])]).toString().trim();
  const pk = sh('lsblk', ['-n', '-d', '-o', 'PKNAME', rootSource]).split('\n')[0];
  const rootDisk = pk ? `/dev/${pk}` : rootSource;
  const before = createHash('sha256').update(execFileSync('sudo', ['head', '-c', '1048576', rootDisk], BIG)).digest('hex');
  const c = await write(rootDisk, imgSha);
  console.log(rootDisk, JSON.stringify(c.out));
  const after = createHash('sha256').update(execFileSync('sudo', ['head', '-c', '1048576', rootDisk], BIG)).digest('hex');
  check(c.out.ok === false && /not a drive the imager writes to|no longer connected/.test(c.out.reason) && before === after,
    `the system disk ${rootDisk} is refused and unchanged`);

  const d = await write(loop, imgSha, {}, true);
  console.log(JSON.stringify(d.out));
  check(d.out.ok === false, 'a loop device is refused without the test switch');
} finally {
  execFileSync('sudo', ['losetup', '-d', loop]);
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
