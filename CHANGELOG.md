# Changelog

## 0.1.0

First version.

- Write Roxora images from the roxora-os/build releases to SD cards and USB
  drives, with the download checked against the release SHA-256 and the drive
  read back and compared with it.
- Write a board's eMMC or SPI NOR over USB in Maskrom mode, using
  rkdeveloptool built for WebAssembly as in edk2-webflash, with the same
  read-back check.
- System disks are never offered as targets.
- Checks for a new version at most once a day; can be turned off.
