// End-to-end SD write on macOS, for CI (needs sudo for the setup only).
//
//   npm run writer && node test/e2e/sd-ramdisk-mac.mjs
//
// Runs the app's macOS write path (src/main/mac-write.ts) with the real
// roxora-imager-rawdisk and Apple's authopen against RAM disks from
// `hdiutil attach -nomount ram://N`. Nothing in the path runs as root.
//
// A runner has nobody to answer the password dialog, so the test grants the
// right the helper asks for, sys.openfile.readwrite./dev/rdiskN, in the
// authorization database for the time of the test (and removes it again).
// The device nodes are given to root:operator, mode 640, as those of a real
// card are, so the user cannot open the disk without authopen.
//
// Checks:
//   1. the user cannot open the raw disk directly;
//   2. an .img.xz whose size is not a multiple of the block size is written,
//      the read-back matches, the disk holds the image, the rest of its last
//      block is zero and everything after it is untouched;
//   3. a wrong extract_sha256 is reported as a read-back mismatch;
//   4. a RAM disk is refused without the test switch, the system disks are
//      refused, and no helper is started for them;
//   5. a disk smaller than the image is refused by the helper;
//   6. cancelling during the write stops the helper;
//   7. image files from this computer that are in no release (.img.xz,
//      .img.gz and plain .img): looked at and measured as the app does it
//      (src/main/local-image.ts), written with the size and SHA-256 that
//      gave, and the disk then holds exactly the image;
//   8. without the granted right nothing is written (the dialog cannot be
//      answered here; the write is cancelled after 15 seconds).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const work = mkdtempSync(join(tmpdir(), 'sd-mac-'));
// Inside the checkout, so that etcher-sdk and drivelist are found.
mkdirSync(join(root, 'build/e2e'), { recursive: true });
const bundle = join(root, 'build/e2e/mac-write.cjs');
await build({ entryPoints: ['src/main/mac-write.ts'], bundle: true, platform: 'node', format: 'cjs',
  external: ['etcher-sdk', 'drivelist'], outfile: bundle, logLevel: 'warning' });
const { macWrite } = createRequire(import.meta.url)(bundle);
await build({ entryPoints: ['src/main/local-image.ts'], bundle: true, platform: 'node', format: 'cjs',
  external: ['etcher-sdk'], outfile: join(root, 'build/e2e/local-image.cjs'), logLevel: 'warning' });
const { describeLocal, measureFile } = createRequire(import.meta.url)(join(root, 'build/e2e/local-image.cjs'));

const helperPath = join(root, 'build-res/writer/roxora-imager-rawdisk');
const BIG = { maxBuffer: 512 * 1024 * 1024 };
const sh = (cmd, args) => execFileSync(cmd, args, BIG).toString().trim();
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`); if (!ok) failures++; };

const MIB = 1024 * 1024;
const BLOCK = 512;
const DISK_MIB = 192;
// Larger than 17 MiB (where an SD card on a Mac stopped matching with the
// old writer), and not a multiple of the block size.
const img = join(work, 'test.img');
const data = randomBytes(120 * MIB + 4096 * 3 + 517);
writeFileSync(img, data);
const imgSha = sha256(data);
sh('xz', ['-T0', '-1', '-k', img]);
const xz = `${img}.xz`;
// What the disks hold before a write.
const patternFile = join(work, 'pattern.bin');
const pattern = Buffer.alloc(DISK_MIB * MIB, 0xa5);
writeFileSync(patternFile, pattern);

function ramDisk(mib) {
  const disk = sh('hdiutil', ['attach', '-nomount', `ram://${(mib * MIB) / BLOCK}`]).split(/\s+/)[0];
  const rdisk = disk.replace('/dev/disk', '/dev/rdisk');
  sh('sudo', ['chown', 'root:operator', disk, rdisk]);
  sh('sudo', ['chmod', '640', disk, rdisk]);
  return { disk, rdisk, mib, right: `sys.openfile.readwrite.${rdisk}` };
}
const grant = (d) => sh('sudo', ['security', 'authorizationdb', 'write', d.right, 'allow']);
const revoke = (d) => { try { sh('sudo', ['security', 'authorizationdb', 'remove', d.right]); } catch { /* not there */ } };
const fill = (d) => sh('sudo', ['dd', `if=${patternFile}`, `of=${d.rdisk}`, 'bs=1m', `count=${d.mib}`]);
const contents = (d) => execFileSync('sudo', ['dd', `if=${d.rdisk}`, 'bs=1m'], { ...BIG, stdio: ['ignore', 'pipe', 'ignore'] });

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

async function write(d, over = {}) {
  const progress = [];
  const t0 = Date.now();
  const out = await macWrite({
    image: xz, device: d.disk, extractSize: data.length, extractSha256: imgSha, helperPath, testDisk: true,
    onProgress: (p) => { if (!progress.includes(p.stage)) progress.push(p.stage); },
    ...over,
  });
  console.log(`${Date.now() - t0} ms`, JSON.stringify(out));
  return { out, progress };
}

const big = ramDisk(DISK_MIB);
const small = ramDisk(64);
console.log(`RAM disks ${big.disk} (${big.mib} MiB), ${small.disk} (${small.mib} MiB)`);
console.log(sh('ls', ['-l', big.disk, big.rdisk]));
try {
  let direct = 'opened';
  try { closeSync(openSync(big.rdisk, 'r+')); } catch (e) { direct = e.code; }
  check(direct === 'EACCES', `the user cannot open ${big.rdisk} directly (${direct})`);

  grant(big);
  grant(small);
  fill(big);
  const a = await write(big);
  check(a.out.ok === true && a.out.sha256 === imgSha, 'write and read-back match the release checksum');
  check(a.progress.join() === 'write,verify', `progress reported for write and verify (${a.progress.join()})`);
  const onDisk = contents(big);
  const diff = firstDifference(onDisk.subarray(0, data.length), data);
  check(diff === -1, `the disk holds exactly the image (first difference at ${diff})`);
  const padEnd = Math.ceil(data.length / BLOCK) * BLOCK;
  check(padEnd > data.length && onDisk.subarray(data.length, padEnd).every((b) => b === 0), `the last block is filled with zeros (${padEnd - data.length} bytes)`);
  check(onDisk.length === DISK_MIB * MIB && onDisk.subarray(padEnd).every((b) => b === 0xa5), 'the disk after the image is untouched');

  const b = await write(big, { extractSha256: '0'.repeat(64) });
  check(b.out.ok === false && /does not read back/.test(b.out.reason), 'wrong checksum reported as a read-back mismatch');

  // From here on a missing helper: a refusal must come before it is started.
  fill(big);
  const before = sha256(contents(big));
  const c = await write(big, { testDisk: false, helperPath: join(work, 'not-started') });
  check(c.out.ok === false && /not a drive the imager writes to|no longer connected/.test(c.out.reason) && sha256(contents(big)) === before,
    'a RAM disk is refused without the test switch and unchanged');
  const rootWhole = /<key>ParentWholeDisk<\/key>\s*<string>([^<]+)<\/string>/.exec(sh('diskutil', ['info', '-plist', '/']))?.[1];
  for (const sys of new Set(['/dev/disk0', `/dev/${rootWhole}`])) {
    const s = await write({ disk: sys }, { testDisk: false, helperPath: join(work, 'not-started') });
    check(s.out.ok === false && /not a drive the imager writes to|no longer connected/.test(s.out.reason), `the system disk ${sys} is refused`);
  }

  fill(small);
  const smallBefore = sha256(contents(small));
  const e = await write(small);
  check(e.out.ok === false && /smaller than the image/.test(e.out.reason) && sha256(contents(small)) === smallBefore,
    'a disk smaller than the image is refused by the helper and unchanged');

  const ac = new AbortController();
  const f = await write(big, { signal: ac.signal, onProgress: (p) => { if (p.stage === 'write' && p.bytes >= 8 * MIB) ac.abort(); } });
  check(f.out.ok === false && f.out.reason === 'Cancelled. The drive is only partly written.', 'cancelling during the write stops it and says the drive is partly written');
  let running = '';
  try { running = sh('pgrep', ['-f', 'roxora-imager-rawdisk']); } catch { /* none */ }
  check(running === '', 'no helper is left running after the cancel');

  // Custom images: nothing to compare with but the file itself.
  for (const kind of ['xz', 'gz', 'img']) {
    const custom = randomBytes(24 * MIB + 100 + kind.length);
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
    fill(big);
    const w = await write(big, { image: path, extractSize: m.size, extractSha256: m.sha256 });
    check(w.out.ok === true && w.out.sha256 === sha256(custom), `custom .${kind}: write and read-back match`);
    check(firstDifference(contents(big).subarray(0, custom.length), custom) === -1, `custom .${kind}: disk holds exactly the image`);
  }

  revoke(big);
  fill(big);
  const ac2 = new AbortController();
  const timer = setTimeout(() => ac2.abort(), 15000);
  const g = await write(big, { signal: ac2.signal });
  clearTimeout(timer);
  check(g.out.ok === false && /Nothing was written/.test(g.out.reason) && sha256(contents(big)) === before,
    `without the granted right nothing is written (${ac2.signal.aborted ? 'the dialog was not answered; cancelled' : 'refused'})`);
} finally {
  revoke(big);
  revoke(small);
  for (const d of [big, small]) { try { sh('hdiutil', ['detach', d.disk]); } catch (err) { console.log(String(err.message)); } }
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
