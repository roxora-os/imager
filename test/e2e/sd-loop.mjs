// End-to-end SD write to a loop device, for CI on Linux (needs sudo).
//
//   node test/e2e/sd-loop.mjs
//
// Runs the real writer (build-res/writer/, from scripts/build-writer.mjs) the
// way the app starts it (main/elevate.ts: a socket with a token), with sudo
// instead of pkexec. Checks:
//   1. an .img.xz is written to a loop device and the read-back matches;
//   2. the bytes on the device equal the image;
//   3. a wrong extract_sha256 is reported as a read-back mismatch;
//   4. the disk holding / is refused, and its first MiB is unchanged;
//   5. a loop device is refused when the test switch is off;
//   6. image files from this computer that are in no release (.img.xz,
//      .img.gz and plain .img): looked at and measured as the app does it
//      (src/main/local-image.ts), written with the size and SHA-256 that
//      gave, and the device then holds exactly the image.
import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const work = mkdtempSync(join(tmpdir(), 'sd-e2e-'));
await build({ entryPoints: ['src/main/elevate.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'elevate.mjs'), logLevel: 'warning' });
const { helperLaunch, runHelper } = await import(join(work, 'elevate.mjs'));
// Inside the checkout, so that etcher-sdk is found.
mkdirSync(join(root, 'build/e2e'), { recursive: true });
await build({ entryPoints: ['src/main/local-image.ts'], bundle: true, platform: 'node', format: 'cjs',
  external: ['etcher-sdk'], outfile: join(root, 'build/e2e/local-image.cjs'), logLevel: 'warning' });
const { describeLocal, measureFile } = createRequire(import.meta.url)(join(root, 'build/e2e/local-image.cjs'));

const writerPath = join(root, 'build-res/writer/roxora-imager-writer');
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

async function write(device, sha, extraEnv = { ROXORA_IMAGER_TEST: '1' }, allowLoop = true, image = xz, size = data.length) {
  const progress = [];
  const out = await runHelper({
    launch: (dir) => helperLaunch({ writerPath, dir }),
    args: (socket, token) => ['--socket', socket, '--token', token, '--image', image, '--device', device,
      '--extract-size', String(size), '--extract-sha256', sha, ...(allowLoop ? ['--allow-loop'] : [])],
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

  // Custom images: nothing to compare with but the file itself.
  const sha256 = (b) => createHash('sha256').update(b).digest('hex');
  for (const kind of ['xz', 'gz', 'img']) {
    const custom = randomBytes(24 * 1024 * 1024 + 512 * (kind.length + 1));
    const plain = join(work, `custom-${kind}.img`);
    writeFileSync(plain, custom);
    if (kind === 'xz') sh('xz', ['-T0', '-1', '-k', plain]);
    if (kind === 'gz') sh('gzip', ['-1', '-k', plain]);
    const path = kind === 'img' ? plain : `${plain}.${kind}`;
    const desc = await describeLocal(path, []);
    const wantSize = kind === 'gz' ? 0 : custom.length;
    check(desc.image === null && desc.extractSize === wantSize && desc.compression === { xz: 'xz', gz: 'gzip', img: null }[kind],
      `custom .${kind}: taken as a custom image, size before reading ${desc.extractSize}`);
    const m = await measureFile(path, () => {});
    check(m.size === custom.length && m.sha256 === sha256(custom), `custom .${kind}: measured size and SHA-256 are those of the image`);
    const w = await write(loop, m.sha256, { ROXORA_IMAGER_TEST: '1' }, true, path, m.size);
    console.log(JSON.stringify(w.out));
    check(w.out.ok === true && w.out.sha256 === sha256(custom), `custom .${kind}: write and read-back match`);
    const got = execFileSync('sudo', ['head', '-c', String(custom.length), loop], BIG);
    check(Buffer.compare(got, custom) === 0, `custom .${kind}: device holds exactly the image`);
  }
} finally {
  execFileSync('sudo', ['losetup', '-d', loop]);
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
