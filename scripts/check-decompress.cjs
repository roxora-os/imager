// Run inside a packaged app's own Node (ELECTRON_RUN_AS_NODE=1): load
// etcher-sdk's source-destination from the app.asar, as the main process does
// for a Maskrom write of a release .img.xz, and decompress a small .img.xz
// with it, so the packaged lzma-native is the one that works on this CPU.
//   ELECTRON_RUN_AS_NODE=1 <app binary> scripts/check-decompress.cjs <app.asar>
const { execFileSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

(async () => {
  const asar = process.argv[2];
  const sd = require(join(asar, 'node_modules/etcher-sdk/build/source-destination'));
  const dir = mkdtempSync(join(tmpdir(), 'decompress-'));
  const data = randomBytes(3 * 1024 * 1024 + 123);
  writeFileSync(join(dir, 'test.img'), data);
  execFileSync('xz', ['-1', '--check=crc64', join(dir, 'test.img')]);
  const inner = await new sd.File({ path: join(dir, 'test.img.xz') }).getInnerSource();
  const h = createHash('sha256');
  let size = 0;
  for await (const c of await inner.createReadStream()) { h.update(c); size += c.length; }
  rmSync(dir, { recursive: true, force: true });
  const ok = size === data.length && h.digest('hex') === createHash('sha256').update(data).digest('hex');
  console.log(ok ? `OK: decompressed ${size} bytes of .img.xz in the packaged app (${process.arch})` : `FAIL: got ${size} bytes, or a different checksum`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
