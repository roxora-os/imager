# Roxora Imager

A desktop app that installs [Roxora](https://github.com/roxora-os/build)
images in two ways:

- **SD card or USB drive.** Downloads the image from a Roxora release, checks
  it against the release SHA-256, writes it, then reads the drive back and
  compares it with the release.
- **Board storage over USB (Maskrom).** Writes a board's eMMC or SPI NOR
  flash through its USB-C port, with the same read-back check.

Status: first version, not yet tested on hardware. There are no Roxora
releases yet; until there are, the app says so and has nothing to write.

Windows (x64), macOS (Apple silicon and Intel) and Linux (AppImage, .deb,
.rpm; x86_64 and arm64). See [docs/install.md](docs/install.md).

## How it works

| Part | Where it comes from |
| --- | --- |
| Image list | The releases of roxora-os/build and the `roxora-catalog.json` in each, as described in its [release contract](https://github.com/roxora-os/build/blob/main/docs/release-contract.md). The website reads the same releases. |
| SD/USB writing | [etcher-sdk](https://github.com/balena-io-modules/etcher-sdk), in a helper process started with administrator rights the way Etcher starts its writer. |
| Maskrom writing | rkdeveloptool compiled to WebAssembly with libusb's WebUSB backend, as in [edk2-webflash](https://github.com/gahingwoo/edk2-webflash), running in a worker inside the app. |
| Interface | Electron, React and [PatternFly](https://www.patternfly.org/). |

Safety rules:

- Drives that hold the running system are never offered: drivelist's
  system flag, any system mount point (`/`, `/boot`, `/home`, `C:\`, ...),
  read-only, virtual and loop devices are all hidden. The helper checks the
  target again before it writes.
- The review page says exactly what will be erased, and writing needs a
  second confirmation.
- Every write is read back and its SHA-256 compared with the release's
  `extract_sha256`.
- A Maskrom write names the storage (eMMC or SPI NOR) and fails before
  writing anything if the board does not switch to it or the image does not
  fit.

## Building

Needs Node.js 22.

```sh
npm ci
npm run writer              # the SD/USB writer, Node.js packed with pkg
sh scripts/build-wasm.sh    # needs emsdk 3.1.48; or take the CI artifact
npm run build
npm start                   # or: npx electron . --dev-sample
```

`--dev-sample` shows the sample catalog from the release contract. Those
entries are marked as samples and cannot be written.

## Tests

```sh
npm test                                   # catalog, targets, Maskrom through the WASM
node scripts/electron-maskrom-e2e.mjs      # Maskrom path inside Electron
node test/e2e/sd-loop.mjs                  # SD write to a loop device (Linux, sudo)
node scripts/shots.mjs dev/shots           # screenshots, light and dark
```

The Maskrom tests use a pretend board (`test/fake-rockchip.ts`) that speaks
enough of the Rockusb protocol for the commands the app sends. Real boards
are tested by hand: [docs/hardware-test.md](docs/hardware-test.md).

## License

GPL-2.0. rkdeveloptool is GPL-2.0-or-later, libusb LGPL-2.1, etcher-sdk
Apache-2.0. The RK3576 loader in `resources/` is the one edk2-webflash
ships.
