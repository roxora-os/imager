# Releasing

## A version

1. Set the version in package.json and add its section to CHANGELOG.md.
2. Tag `vX.Y.Z` (a release) or `vX.Y.Z-beta.N` (a pre-release) and push the
   tag. The Release workflow builds every package, checks that the tag
   matches package.json, and publishes the GitHub release with the notes
   from CHANGELOG.md; a tag with a suffix becomes a pre-release.
3. For a release (not a pre-release) the `homebrew-tap` job then opens a
   pull request to gahingwoo/homebrew-tap with `Casks/roxora-imager.rb`
   for that tag, written by `scripts/bump-cask.mjs` with the SHA-256 of
   both DMGs. Merge it.

The job needs the repository secret `HOMEBREW_TAP_TOKEN`: a fine-grained
personal access token whose resource owner is gahingwoo, limited to the
one repository gahingwoo/homebrew-tap, with the repository permissions
**Contents: Read and write** and **Pull requests: Read and write**
(Metadata: Read-only comes with them). Create it under GitHub, Settings,
Developer settings, Personal access tokens, Fine-grained tokens, then add
it in roxora-os/imager under Settings, Secrets and variables, Actions, New
repository secret. Without it the job only says it was skipped; the cask
can be written by hand with `node scripts/bump-cask.mjs vX.Y.Z Casks` in
a clone of the tap.

## The rolling ci release

Every push to main runs the Release workflow too, and when the Linux and
Windows packages built, its `ci-release` job replaces the pre-release
tagged `ci`: named "CI build <sha> <date>", never marked latest, notes
saying it is untested, all packages plus version-less copies of the macOS
DMGs (`roxora-imager-macos-arm64.dmg`, `roxora-imager-macos-x86_64.dmg`)
for the `roxora-imager@nightly` cask, whose URL never changes
(`packaging/homebrew/roxora-imager@nightly.rb`, `node scripts/bump-cask.mjs
ci`). The app's CI tier and that cask both use it; install.sh never takes
it. A newer push to main cancels a build still running for an older one.
