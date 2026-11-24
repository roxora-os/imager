cask "roxora-imager@nightly" do
  arch arm: "arm64", intel: "x86_64"

  version :latest
  sha256 :no_check

  # The rolling "ci" release: the latest successful build of main, untested.
  url "https://github.com/roxora-os/imager/releases/download/ci/roxora-imager-macos-#{arch}.dmg"
  name "Roxora Imager"
  desc "Download, check and write Roxora images for Rockchip boards"
  homepage "https://roxora-os.github.io/roxora-imager/"

  livecheck do
    skip "Rolling build of main, replaced on every successful build"
  end

  conflicts_with cask: "roxora-imager"
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
