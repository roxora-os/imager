# Installing Roxora Imager

Get the package for your system from the
[releases](https://github.com/roxora-os/imager/releases), or on macOS and
Linux run:

```sh
curl -fsSL https://raw.githubusercontent.com/roxora-os/imager/main/install.sh | sh
```

The script picks the package for the system and checks the download against
the SHA-256 GitHub publishes for it.

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
