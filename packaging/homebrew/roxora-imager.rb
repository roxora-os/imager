# Homebrew cask for Roxora Imager. Not published yet: it goes into a tap
# (which one is still open). The version and both checksums come from the
# release's SHA256SUMS; update them with each release.
cask "roxora-imager" do
  arch arm: "arm64", intel: "x86_64"

  version "0.1.0"
  sha256 arm:   "REPLACE_WITH_SHA256_OF_ARM64_DMG",
         intel: "REPLACE_WITH_SHA256_OF_X86_64_DMG"

  url "https://github.com/roxora-os/imager/releases/download/v#{version}/roxora-imager-#{version}-macos-#{arch}.dmg"
  name "Roxora Imager"
  desc "Write Roxora images to SD cards, USB drives and board storage"
  homepage "https://github.com/roxora-os/imager"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Roxora Imager.app"

  # Not notarized yet: remove the quarantine flag so Gatekeeper does not
  # block the first launch (what install.sh does too).
  postflight do
    system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{appdir}/Roxora Imager.app"]
  end

  zap trash: [
    "~/Library/Application Support/Roxora Imager",
    "~/Library/Preferences/io.github.roxora-os.imager.plist",
  ]
end
