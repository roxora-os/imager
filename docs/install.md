# Installing Roxora Imager

Get the package for your system from the
[releases](https://github.com/roxora-os/imager/releases), or on macOS and
Linux run:

```sh
curl -fsSL https://raw.githubusercontent.com/roxora-os/imager/main/install.sh | sh
```

The script picks the package for the system and checks the download against
the SHA-256 GitHub publishes for it. It installs the newest normal release.
To get the newest beta version instead (a pre-release on GitHub, such as
0.1.5-beta.1), run it with `BETA=1`:

```sh
curl -fsSL https://raw.githubusercontent.com/roxora-os/imager/main/install.sh | BETA=1 sh
```

While no normal release exists yet, the script installs the newest beta and
says so.

The packages do not include Rockchip's Maskrom loader. The first Maskrom
write downloads its pieces from Rockchip's rkbin repository
(raw.githubusercontent.com), checks them against pinned SHA-256 sums and keeps
the loader in the app's user data folder (`loaders/`), so that first write
needs an internet connection.

The packages are not signed with a paid certificate, so each system warns
the first time.

## Windows

1. Run `roxora-imager-<version>-windows-x64-setup.exe`.
2. Windows SmartScreen says "Windows protected your PC". Click
   **More info**, then **Run anyway**.

The zip holds the same app without an installer.

For Maskrom writing Windows needs the WinUSB driver for the board:

1. Put the board in Maskrom mode and connect it (see the app's Destination
   page).
2. Download Zadig from https://zadig.akeo.ie/ and run it.
3. Choose the device whose USB ID starts with 2207 (Options, List All
   Devices, if it is not shown), select **WinUSB** and click
   **Install Driver**.

This is needed once per computer. Whether the app could install the driver
itself (with libwdi, which Zadig is built on) has not been tested yet.

## macOS

Open the DMG and drag Roxora Imager to Applications. On first launch macOS
may say the app cannot be opened, because it is not notarized:

- macOS 15 and later: open the app once, click Done, then System Settings,
  Privacy and Security, **Open Anyway**.
- macOS 14 and earlier: right-click the app in Applications, choose Open.

macOS needs no driver for Maskrom writing.

Writing an SD card or USB drive asks for an administrator's password (or
Touch ID) once per write, in the dialog of macOS itself. The dialog carries
the sentence "Roxora Imager will erase ... and write the image to it." with
the name of the drive. The right you grant is for that one drive
(`sys.openfile.readwrite./dev/rdiskN`): Apple's `/usr/libexec/authopen`
opens it, and no part of Roxora Imager runs as root. Full Disk Access is not
needed, and the app does not ask for it. If macOS offers to initialise or
eject the drive when the write is done, choose Ignore or Eject.

## Linux

- `.deb` (Debian, Ubuntu) and `.rpm` (Fedora, openSUSE): install with the
  package manager. They install a udev rule so the board can be written in
  Maskrom mode without root.
- AppImage: make it executable and run it. For Maskrom writing add the udev
  rule once:

  ```sh
  echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="2207", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/70-roxora-imager.rules
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```

Writing an SD card asks for your password (pkexec), as Etcher does.

## Writing an image you downloaded

Roxora Imager downloads release images itself, but it also takes a file you
already have, for an SD card or USB drive: click **Use an image file on this
computer** on the Board or Image step, or drop the file on the window. It
takes .img files, plain or compressed with xz, gzip or bzip2.

- A file from the Roxora releases (for example
  `roxora-radxa-rock-4d-noble-edge-2026.11.3.img.xz`, under its own name) is
  recognised: the app compares its SHA-256 with the release, shows the board
  and Ubuntu version, and reads the drive back against the release after
  writing. If the file differs from the release it is refused; download it
  again.
- Any other file is written as it is. The app cannot know whether it is
  good, and says that it is not a Roxora release image. After writing, the
  drive is read back and compared with the file.

For a board's SPI NOR flash (Maskrom) use the release's SPI bootloader. A
file from this computer is accepted there only if it can be a bootloader:
not larger than the SPI flash, and not a disk image.

## Updates

The app asks GitHub for the list of Roxora Imager releases when it starts,
at most once a day. When a newer version is out, a notice above the steps
names it, with the first line of its release notes, a link to the notes and
an **Update** button. Closing the notice hides that version; Settings still
offers it. No notice appears while a write is running. In Settings:

- **Check for a new version once a day** turns the check off or on.
- **Also offer beta versions (pre-releases)** is off by default. Normal
  releases are offered to everyone; betas only with this switch on. If the
  version you run is itself a beta and no newer normal release exists, the
  app says so and offers nothing.
- **Check now** asks at once and answers in words: the new version, "You
  have the newest version", or that GitHub could not be reached.

Nothing is downloaded or installed until you press Update and then
**Download and install**. Every download is compared with the SHA-256 that
GitHub lists for the file; a file without one, or with a different one, is
deleted and not installed. The download shows its progress and can be
cancelled. What happens then depends on how the app was installed:

| Installed as | Update |
| --- | --- |
| macOS, Homebrew cask | The app shows the command `brew upgrade --cask roxora-imager` to copy. It does not run Homebrew. |
| macOS, DMG or install.sh | The DMG for this Mac's CPU goes to the Downloads folder and is opened. Quit Roxora Imager and drag the new app onto Applications. The app does not replace itself. |
| Windows, installer | The setup program is downloaded and started, and Roxora Imager closes so that it can be replaced. |
| Linux, AppImage | The new AppImage is downloaded into the same folder and put in place of the old file in one step. Restart the app. |
| Linux, .deb or .rpm | The package is downloaded and installed with apt-get, dnf or zypper through pkexec, which asks for your password. If that is not possible the app shows the command to run in a terminal. Restart the app. |
| Windows zip, an unpacked folder | Not updated by the app: the notice links to the release page. |

The web version is always the newest and has no update function.
