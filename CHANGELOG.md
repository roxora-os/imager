# Changelog

## Unreleased

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
