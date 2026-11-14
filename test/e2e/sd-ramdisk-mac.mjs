// End-to-end SD write to a RAM disk, for CI on macOS (needs sudo).
//
//   node test/e2e/sd-ramdisk-mac.mjs
//
// Runs the real writer the way the app starts it, with sudo instead of the
// password dialog, against `hdiutil attach -nomount ram://N`. The disk is
// zeroed before each write; after it, the read-back must match and the
// bytes on the disk must equal the image. Written once with the app's
// buffer count and once with 2, to tell a buffer problem from others.
import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const work = mkdtempSync(join(tmpdir(), 'sd-mac-'));
await build({ entryPoints: ['src/main/elevate.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'elevate.mjs'), logLevel: 'warning' });
const { helperLaunch, runHelper } = await import(join(work, 'elevate.mjs'));

const writerPath = join(root, 'build-res/writer/roxora-imager-writer');
const BIG = { maxBuffer: 512 * 1024 * 1024 };
const sh = (cmd, args) => execFileSync(cmd, args, BIG).toString().trim();
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`); if (!ok) failures++; };

// Larger than 17 MiB (where the SD card on a Mac stopped matching), odd size.
const img = join(work, 'test.img');
const data = randomBytes(120 * 1024 * 1024 + 4096 * 3 + 512);
writeFileSync(img, data);
const imgSha = createHash('sha256').update(data).digest('hex');
sh('xz', ['-T0', '-1', '-k', img]);
const xz = `${img}.xz`;

const disk = sh('hdiutil', ['attach', '-nomount', `ram://${(256 * 1024 * 1024) / 512}`]).split(/\s+/)[0];
const rdisk = disk.replace('/dev/disk', '/dev/rdisk');
console.log(`RAM disk ${disk}`);

function elevate(extraEnv) {
  return (cmd, env) => new Promise((resolveP, reject) => {
    const vars = Object.entries({ ...env, ...extraEnv }).map(([k, v]) => `${k}=${v}`);
    const p = spawn('sudo', ['env', ...vars, 'sh', '-c', cmd], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('exit', (c) => (c === 0 ? resolveP() : reject(new Error(`exit ${c}`))));
  });
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

async function writeWith(numBuffers) {
  sh('sudo', ['dd', 'if=/dev/zero', `of=${rdisk}`, 'bs=1m', 'count=256']);
  const env = { ROXORA_IMAGER_TEST: '1', ...(numBuffers ? { ROXORA_IMAGER_NUM_BUFFERS: String(numBuffers) } : {}) };
  const t0 = Date.now();
  const out = await runHelper({
    launch: (dir) => helperLaunch({ writerPath, dir }),
    args: (socket, token) => ['--socket', socket, '--token', token, '--image', xz, '--device', disk,
      '--extract-size', String(data.length), '--extract-sha256', imgSha, '--allow-loop'],
    onMessage: () => {},
    elevate: elevate(env),
  });
  const label = numBuffers ? `${numBuffers} buffers` : 'the app\'s buffers';
  console.log(label, `${Date.now() - t0} ms`, JSON.stringify(out));
  const onDisk = execFileSync('sudo', ['dd', `if=${rdisk}`, 'bs=1m', `count=${Math.ceil(data.length / 1048576)}`], { ...BIG, stdio: ['ignore', 'pipe', 'ignore'] })
    .subarray(0, data.length);
  const diff = firstDifference(onDisk, data);
  console.log(`${label}: first difference at ${diff} (${(diff / 1048576).toFixed(2)} MiB)`);
  check(out.ok === true && out.sha256 === imgSha, `${label}: write and read-back match`);
  check(diff === -1, `${label}: disk holds exactly the image`);
}

try {
  await writeWith(undefined);
  await writeWith(2);
} finally {
  execFileSync('hdiutil', ['detach', disk]);
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
