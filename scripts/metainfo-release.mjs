// Set the first <release> entry of the AppStream metainfo to the version
// being built and its date, so the packages never carry a stale entry.
// The release workflow runs it before packaging (the edit stays in the
// build checkout).
//   node scripts/metainfo-release.mjs VERSION YYYY-MM-DD
// Fails when VERSION is not package.json's version (the tag must match it).
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'packaging/io.github.roxora_os.imager.metainfo.xml';
const [version, date] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!version || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  console.error('usage: metainfo-release.mjs VERSION YYYY-MM-DD');
  process.exit(2);
}
if (version !== pkg) {
  console.error(`FAIL: building ${version}, but package.json says ${pkg}`);
  process.exit(1);
}
const xml = readFileSync(FILE, 'utf8');
const re = /<release version="[^"]*" date="[^"]*">/;
if (!re.test(xml)) {
  console.error(`FAIL: ${FILE} has no <release version="..." date="..."> entry`);
  process.exit(1);
}
writeFileSync(FILE, xml.replace(re, `<release version="${version}" date="${date}">`));
console.log(`metainfo release: ${version}, ${date}`);
