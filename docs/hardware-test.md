# Hardware test: Roxora Imager

What has to be tried by hand, because CI has no boards, no SD card reader
and no Windows desktop. This section is meant to be merged into
roxora-os/build's `docs/hardware-test.md`.

Needed: a Radxa ROCK 4D, an ArmSoM CM5-IO, a USB-C data cable, a microSD
card (8 GB or more) and a reader, a serial console on each board, and a
Roxora release in roxora-os/build (until there is one, M3 still works with
a file from disk).

Record for each test: the app version (Settings), the system and its
version, and the result. When something fails, open the "rkdeveloptool
output" section on the result page and keep its text.

## Before the board tests

### P1. The app starts and lists the releases

1. Start the app.
2. The Board page lists ROCK 4D and CM5-IO with the newest release, or says
   "No Roxora releases yet" when there are none.

Pass: the list matches the release page of roxora-os/build.

### P2. System disks are not offered

1. Choose any board and image, then Destination, SD card or USB drive.
2. Open "N drives are not offered".

Pass: the computer's own disks are listed there (with a reason, such as
"system disk" or "holds /"), not in the table. Repeat on each system.

## SD card

### S1. Write and verify (every system: Linux, macOS, Windows)

1. Insert the card. Choose ROCK 4D, the newest image, Destination, SD card
   or USB drive, the card, Review.
2. Review shows the card's name, device and size under "Will be erased".
   Click Erase and write, confirm, give the administrator password.
3. Wait for Download and check, Write, Read back.

Pass: "Written and verified", with the SHA-256 equal to the image's
`extract_sha256` in `roxora-catalog.json` of the release.

### S2. The card boots

1. Put the card in the ROCK 4D, power on with the serial console attached.

Pass: Roxora boots to the login prompt (the rest is roxora-os/build's
hardware test). Note what is on the SPI NOR at the time (blank, U-Boot,
edk2): ROCK 4D's boot ROM tries SPI NOR before the SD card.

### S3. Cancel and refusal

1. Start a write and click Cancel during Write.
2. Start a write and refuse the password prompt.

Pass: 1 says the drive may be partly written; 2 says administrator rights
were not granted and nothing was written.

## Maskrom

Put the board in Maskrom mode: power off, hold the Maskrom button, connect
USB-C to the computer, release after two seconds. `lsusb` (Linux) shows
`2207:` on a device.

### M1. Linux udev rule (no root)

1. Install the `.deb` (or `.rpm`). Do not run the app as root.
2. `ls -l /dev/bus/usb/*/*` for the board's device after plugging it in, and
   `getfacl` on it.

Pass: the device node has an ACL entry for your user (from `uaccess`).
Then M2 works without sudo. With the AppImage, the same after adding the
rule from the Destination page.

### M2. CM5-IO: Roxora image to eMMC

1. Choose ArmSoM CM5-IO, the newest image, Destination, Board storage over
   USB (Maskrom), Storage eMMC, "The image chosen in the previous step".
2. Review, Erase and write, confirm. Do not touch the cable.
3. Watch the stages: Download, check and decompress; Send the loader and
   wait for the board; Write eMMC; Read back and compare.

Pass:
- No second device prompt appears after the loader is sent (the board
  re-enumerates in Loader mode and the app finds it by itself).
- "Written and verified" with the SHA-256 equal to `extract_sha256`.
- With "Restart the board after a Maskrom write" on (Settings), the board
  restarts and boots Roxora from eMMC (serial console).

If the result says "Could not verify: from N bytes on, the loader returns
filler", the write may be fine; note N and whether the board boots.

### M3. ROCK 4D: bootloader to SPI NOR

1. Choose Radxa ROCK 4D, any image, Destination, Board storage over USB
   (Maskrom). The page says a whole image does not fit in SPI NOR.
2. "What to write" defaults to "This release's SPI bootloader" when the
   release has one (from 2026.11.1). For older releases choose "A file on
   this computer" and a SPI image, for example `rock4d-spi-uboot.img` from
   edk2-webflash.
3. Review, Erase and write, confirm.

Pass: "Written and verified"; after restart the board starts the bootloader
from SPI NOR (serial console), and with S2's card inserted boots Roxora.

### M4. Windows: driver

1. On a Windows PC that never had a Rockchip driver, put the board in
   Maskrom mode and run M2.
2. Expected first result: the app does not find the board.
3. Install WinUSB with Zadig as docs/install.md says, run M2 again.

Pass: M2 passes after Zadig. Record whether Device Manager showed the board
as an unknown device before Zadig. (Whether the app can install WinUSB
itself through libwdi is not built yet; this test is the baseline for that.)

### M5. macOS

Run M2 and M3 on macOS (Apple silicon, and Intel if available).

Pass: as in M2 and M3, with no driver installed.

### M6. Several boards

1. Connect two boards in Maskrom mode and run M2.

Pass: the app says more than one Rockchip device is connected (or asks
which one), and writes nothing until only one is left.
