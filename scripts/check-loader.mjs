// Build every pinned Maskrom loader from Rockchip's rkbin, as the app does on
// first use, and check it against its pin (src/maskrom/loaders.ts). Needs
// the network; CI runs it so a pin that no longer resolves is caught.
//   node scripts/check-loader.mjs
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'check-loader-'));
const out = join(dir, 'loaders.mjs');
await build({ entryPoints: ['src/maskrom/loaders.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'warning' });
const { LOADERS, buildLoader } = await import(pathToFileURL(out).href);
let failed = false;
for (const pin of Object.values(LOADERS)) {
  try {
    const data = await buildLoader(pin);
    console.log(`OK: ${pin.name} from rkbin ${pin.commit.slice(0, 12)}: ${data.length} bytes, sha256 ${pin.sha256}`);
  } catch (e) {
    console.log(`FAIL: ${pin.name}: ${e.message}`);
    failed = true;
  }
}
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
