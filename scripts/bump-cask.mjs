// The Homebrew casks of gahingwoo/homebrew-tap for Roxora Imager:
//   roxora-imager           the newest normal release (a vX.Y.Z tag)
//   roxora-imager@nightly   the rolling "ci" release: a fixed URL to the
//                           version-less DMGs, version :latest, no checksum
// A pre-release (vX.Y.Z-suffix) has no cask. For a tag, the SHA-256 of both
// DMGs come from GitHub's asset digests (or from downloading them when a
// digest is missing).
//   node scripts/bump-cask.mjs <vX.Y.Z|ci> [OUT_DIR]   (default: print to stdout)
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = 'roxora-os/imager';
const ARCHES = { arm: 'arm64', intel: 'x86_64' };

const common = (livecheck, conflicts) => `  name "Roxora Imager"
  desc "Download, check and write Roxora images for Rockchip boards"
  homepage "https://roxora-os.github.io/roxora-imager/"
${livecheck}
  conflicts_with cask: [${conflicts.map((c) => `"${c}"`).join(', ')}]
  depends_on :macos

  app "Roxora Imager.app"

  # The app isn't notarized yet; without this the first launch is blocked.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Roxora Imager.app"]
  end

  zap trash: [
    "~/Library/Application Support/Roxora Imager",
    "~/Library/Preferences/io.github.roxora-os.imager.plist",
    "~/Library/Saved Application State/io.github.roxora-os.imager.savedState",
  ]
end
`;

export function nightlyCask() {
  return `cask "roxora-imager@nightly" do
  arch arm: "arm64", intel: "x86_64"

  version :latest
  sha256 :no_check

  # The rolling "ci" release: the latest successful build of main, untested.
  url "https://github.com/${REPO}/releases/download/ci/roxora-imager-macos-#{arch}.dmg"
${common(`
  livecheck do
    skip "Rolling build of main, replaced on every successful build"
  end
`, ['roxora-imager'])}`;
}

/** The stable cask for a vX.Y.Z tag; null for a pre-release, which has none. */
export function taggedCask(tag, sha) {
  const version = tag.replace(/^v/, '');
  if (version.includes('-')) return null;
  return { name: 'roxora-imager', text: `cask "roxora-imager" do
  arch arm: "arm64", intel: "x86_64"

  version "${version}"
  sha256 arm:   "${sha.arm}",
         intel: "${sha.intel}"

  url "https://github.com/${REPO}/releases/download/v#{version}/roxora-imager-#{version}-macos-#{arch}.dmg"
${common(`
  # Written by roxora-os/imager's scripts/bump-cask.mjs. Betas are GitHub
  # pre-releases, which livecheck skips.
  livecheck do
    url :url
    strategy :github_releases
  end
`, ['roxora-imager@nightly'])}` };
}

async function sha256Of(tag, arch) {
  const version = tag.replace(/^v/, '');
  const file = `roxora-imager-${version}-macos-${arch}.dmg`;
  const headers = { Accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) };
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for release ${tag}`);
  const asset = (await r.json()).assets.find((a) => a.name === file);
  if (!asset) throw new Error(`release ${tag} has no ${file}`);
  if (/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? '')) return asset.digest.slice(7);
  const d = await fetch(asset.browser_download_url);
  if (!d.ok) throw new Error(`downloading ${file} failed: HTTP ${d.status}`);
  return createHash('sha256').update(Buffer.from(await d.arrayBuffer())).digest('hex');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [tag, out] = process.argv.slice(2);
  if (!tag) { console.error('usage: bump-cask.mjs <vX.Y.Z|ci> [OUT_DIR]'); process.exit(2); }
  let cask;
  if (tag === 'ci') cask = { name: 'roxora-imager@nightly', text: nightlyCask() };
  else if (tag.includes('-')) { console.error(`${tag} is a pre-release: Roxora Imager has no beta cask`); process.exit(3); }
  else cask = taggedCask(tag, { arm: await sha256Of(tag, ARCHES.arm), intel: await sha256Of(tag, ARCHES.intel) });
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${cask.name}.rb`), cask.text); console.log(join(out, `${cask.name}.rb`)); }
  else process.stdout.write(cask.text);
}
