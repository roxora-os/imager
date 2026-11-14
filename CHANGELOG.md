# Changelog

## Unreleased

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
