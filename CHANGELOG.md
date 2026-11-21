# Changelog

## Unreleased

- This board: run on an ArmSoM CM5-IO or a Radxa ROCK 4D under Linux, the
  app recognises the board (device tree or SMBIOS) and offers to write its
  own storage directly, without Maskrom: the CM5-IO's eMMC with the release
  image, the ROCK 4D's SPI NOR flash with the release's SPI bootloader
  (flashcp, from mtd-utils). The eMMC is not offered while anything on it
  is mounted, so not when the system runs from it. The elevated writer
  checks the board, the device and what is mounted again before writing.
- English and Simplified Chinese. The app follows the system's language
  unless one is chosen: the masthead has a globe button with the current
  language, which opens a Display language dialog as Cockpit's does, and
  Settings has a Language toggle. The choice is remembered. Messages from
  the main process, the writer and the Maskrom worker are shown in Chinese
  where they are known; anything else stays in English.
- Destination: a third choice, Save as an image file, saves the
  uncompressed .img in a folder you pick in the system's save dialog, for
  Ventoy and similar boot-from-file devices or a virtual machine. A release
  image is downloaded (or taken from the cache) and checked against the
  release SHA-256 as for a drive; the decompressed image must then have the
  release's size and SHA-256. It is written to a temporary file in
  the same folder and gets its name only at the end, so a cancelled or
  failed save leaves nothing under that name. The free space is checked
  before it starts. The result page has Show in folder. No administrator
  rights are asked for. An image file chosen on this computer (.img.xz,
  .img.gz, .img.bz2) can be saved decompressed the same way. Board images
  boot only on their board; the generic RK3576 UEFI image needs an arm64
  (aarch64) UEFI machine, in a virtual machine as with Ventoy, and none
  boots on an x86 PC. The web version does not have this choice.

## 0.1.10

- Image step: only the newest release is listed, named with its date and
  release notes above the table. Older releases and betas are folded away
  under "Older releases and betas", one release at a time, picked from a
  list. Selecting an image of an older release keeps that section open.
- Fix: beta versions (2026.12.1-beta.2) sort by their beta number and
  before their release.
- Linux: a .deb that an apt repository carries (Roxora's desktop images
  install it from Roxora's) is no longer downloaded and replaced by the
  app. The notice still says a new version is out; the dialog says that
  the system's software updates bring it and shows the apt command to
  update at once.
- Linux packages: the .deb and .rpm depend on libgbm and ALSA, which the
  app needs to start, and no longer on libXss, which it does not use.
- Linux: built-in disks (a board's eMMC, SD card slot or NVMe drive) can be
  written. They are listed with their kind and size once Show internal
  disks is turned on in the Destination step, and choosing one asks again,
  naming it. A disk with /, /boot, /usr or swap, or one with anything else
  mounted or in use, is never offered; the writer checks this again.

## 0.1.9

- Image step: click a column header (Release, Ubuntu, Desktop, Kernel,
  Size; the download size) to sort the images by it, again to reverse; the desktop flavor
  has its own column. The Release, Kernel and Size columns no longer wrap,
  so their headers stay readable with a full release list.
- Fix: a write that ended with an unexpected error left the app thinking it
  was still writing, which greyed out Update in Settings until a restart. It
  now ends with the error shown.

## 0.1.8

- Maskrom: when the board's loader returns filler past a point on read-back
  (an RK3576 reading the SD card over USB, from 32 MiB on), the result says
  how much was verified, as a warning instead of an error; on a ROCK 4D such
  a card booted normally. A write with no checksum to compare no longer says
  "verified".

## 0.1.7

- Maskrom on the RK3576: a board whose loader still runs from an earlier
  attempt is written without sending the loader again (sending it failed
  with "Downloading bootloader failed!"). The app asks the board with rfi
  first, and also when sending the loader fails.

## 0.1.6

- macOS: updates are installed inside the app. A Homebrew install is
  updated by running Homebrew for you after you confirm ("brew update", then
  "brew upgrade --cask roxora-imager", as your user, with its output in the
  dialog); an app from the DMG or install.sh is replaced by the one in the
  new DMG, which is downloaded, checked, mounted out of sight and copied
  into place. Either way the dialog then offers "Restart now". The old app
  stays untouched if anything fails; the command to copy and the opened DMG
  remain as the fallback.
- Fix: Maskrom writing to an RK3576 board (seen on a ROCK 4D from a Mac)
  stopped with "The board did not come back after the loader was sent". The
  board does come back, but still lists as Maskrom; it now counts as back
  when it answers with its flash size.
- Fix: the Copy buttons did nothing in the desktop app (the brew command in
  the update dialog, the command shown when a package could not be
  installed). The page has no clipboard permission; copying now goes through
  the app itself, and the button reads "Copied" after it was pressed. The
  udev rule on the Destination step has a Copy button too.

## 0.1.5

- Images in parts. GitHub takes no release file of 2 GiB or more, so Roxora
  releases carry the desktop images as `<file>.part1`, `<file>.part2`, ...
  (from Roxora 2026.11.4 on). The app downloads the parts in order into one
  file, with one progress bar over the whole image, checks each part and
  then the joined file against the release's SHA-256, and writes it as any
  other image. Earlier versions do not list these images. The web version
  cannot join the parts; it links them and asks for the joined file.
- Roxora's colours, as on the website: a mint-tinted page in the light
  theme and the mark's near-black and deep greens in the dark theme, links
  and selections in Roxora green, and primary buttons in the mark's bright
  green with dark text. Status colours stay PatternFly's. Every text colour
  meets WCAG AA contrast.

## 0.1.4

The first normal release; earlier versions were pre-releases.

- Images: the newest Ubuntu LTS (26.04) is chosen by default; a non-LTS
  release such as 26.10 comes after the LTS ones.
- Images: no "Tested on hardware" or "CI only" labels; a Roxora beta is
  called a beta, and catalogs of beta releases (YYYY.MM.N-beta.N) are read.
- New: updates. When a newer version is out, a notice above the steps names
  it, with a line from its release notes and an Update button. Pressing it
  says what will happen and, after "Download and install", does it: the DMG
  is downloaded and opened on macOS, the installer is run on Windows, an
  AppImage is replaced in place, a .deb or .rpm is installed through the
  package manager with pkexec; a Homebrew install is shown the brew command.
  Every download is compared with the SHA-256 GitHub lists for the file and
  refused without it. Settings has "Check now", which says what it found.
- Fix: the daily check for a new version never found one. It asked GitHub
  for the "latest" release, which leaves out pre-releases, and every release
  so far was a pre-release, so the answer was always "no release".
- Normal releases and betas. From this version on a release is a normal
  release; a GitHub pre-release (a version such as 0.1.5-beta.1) is a beta.
  The app offers betas only with "Also offer beta versions (pre-releases)"
  turned on in Settings, and install.sh installs one only with `BETA=1`.
  The release workflow publishes a tag with a suffix as a pre-release and
  any other tag as a normal release.
- Images: desktop images are listed. The Image step says under the Ubuntu
  version whether an image is a command line image or has the GNOME desktop
  (minimal or full), and lists the command line image first. Releases before
  the desktop images are read as before.

## 0.1.3

A pre-release, still not tested on hardware.

- New: an image file on this computer can be written to an SD card or USB
  drive ("Use an image file on this computer" on the Board and Image steps,
  or drop the file on the window): .img, .img.xz, .img.gz, .img.bz2. A file
  with the name of an image in the Roxora releases is checked against that
  release's SHA-256 and written without a download. Any other file is
  written as a custom image: the app says that no release vouches for it,
  reads it once to take the SHA-256 of its decompressed data, and compares
  the drive with that after writing. Zip archives are not taken, and the
  app does not yet open when an image file is double-clicked.
- Maskrom, SPI NOR flash: a file that cannot be a bootloader is refused
  when it is chosen instead of after the board is connected: one larger
  than the board's SPI flash (16 MiB on the ROCK 4D; 32 MiB where the size
  is not known), and a whole disk image (the name of a release image, or a
  partition table that reaches past the flash). The message points to the
  release's SPI bootloader and to writing the image to an SD card.
- macOS: SD cards and USB drives are now written through Apple's `authopen`,
  as Raspberry Pi Imager and Armbian Imager do, instead of a writer running
  as root. With 0.1.2 a card on a Mac could keep its old contents from 17 MiB
  on (the read-back check reported it), and opening the drive could fail with
  "EPERM: operation not permitted". macOS asks for the password once per
  write, for that one drive; Full Disk Access is not needed. The data goes to
  the raw disk in whole 1 MiB pieces and is read back through the same open
  drive. Tested in CI against a RAM disk, not yet on a real card.
- macOS: the DMG no longer contains the etcher-sdk writer, only the small
  helper `roxora-imager-rawdisk`.

## 0.1.2

A pre-release, still not tested on hardware.

- Fix: on macOS, writing an SD card could end with "The writer could not be
  started" and "file closed" (EBADF) after the data was written, before the
  card was read back. The image file was closed while a read on it was still
  pending.

## 0.1.1

A pre-release, still not tested on hardware.

- Fix: writing an SD card or USB drive failed at once with "The writer could
  not be started. Node.util.isObject is not a function" on every system. The
  module that asks for administrator rights used functions that Electron's
  Node.js no longer has.

## 0.1.0

First version, a pre-release: not yet tested on hardware.

- Write Roxora images from the roxora-os/build releases to SD cards and USB
  drives, with the download checked against the release SHA-256 and the drive
  read back and compared with it.
- Write a board's eMMC or SPI NOR over USB in Maskrom mode, using
  rkdeveloptool built for WebAssembly as in edk2-webflash, with the same
  read-back check.
- System disks are never offered as targets.
- Checks for a new version at most once a day; can be turned off.
- The Maskrom loader is not shipped: the first Maskrom write builds it from
  Rockchip's rkbin files at a pinned commit, each checked against its SHA-256.
- Packages for Windows (x64), macOS (Apple silicon and Intel) and Linux
  (AppImage, .deb, .rpm; x86_64 and arm64). Windows builds are not signed yet;
  macOS builds are ad-hoc signed.
