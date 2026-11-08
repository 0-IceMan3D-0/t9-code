# This phone (Android)

Android builds can run T3 and Claude Code on the phone itself, with no other machine. Open **Settings > This phone**.

## Built-in server

**Set up** downloads Linux, Node, T3 and Claude Code, about 500 MB, and starts the server. The app connects to it by itself. The server keeps running in the background behind a notification, and it only listens on the phone.

Use **Sign in to Claude** after the server starts. Finish in the browser, and paste the code if one appears.

- Private projects live in `/root/projects`.
- **Shared project folder** adds `T3Projects` in phone storage as `/root/shared-projects`. Restart the server after changing it.
- **Start when the app opens** starts the server each time the app launches, so you do not need to tap **Start**. It is off by default. It does not start the server after the phone restarts: open the app once. If you stop the server, it stays stopped until the app is closed and opened again.
- **Delete environment** removes Linux, the Claude sign-in and every private project. Its dialog offers **Back up first**.

**Open Linux shell** gives a root shell in the same environment. `apt` works there. It does not need the server, but without the server Android may pause it while the app is in the background.

## Back up, restore and reset

**Settings > This phone > Maintenance** has three tools. Each one stops the server first if it is running, after asking.

- **Back up Linux** saves one `.tar.gz` file with Linux and its installed packages, private projects, threads on This phone, and Claude Code's sign-in and settings. Choose **Save to Downloads** (it goes to `Downloads/T3² code`) or **Choose location**. Caches that refill themselves are left out: `/tmp`, apt's downloaded packages, npm's download cache and `/root/.cache`. Projects in the shared folder are not included. The backup keeps running in the background behind a notification, and you can cancel it.
- **Restore from backup** checks the file you pick, shows when and by which app version it was made, and asks before it replaces the current environment. It unpacks next to the current environment and switches over only when the whole file checked out, so a damaged file or a cancel leaves everything as it was. Restoring needs free space for both copies until it finishes.
- **Reset Linux** downloads a fresh Linux, about 500 MB, and sets it up again, like the first setup. It keeps private projects, Claude Code's sign-in and settings (`~/.claude` and `~/.claude.json`), threads on This phone, git settings (`~/.gitconfig`), SSH keys (`~/.ssh`) and adb keys (`~/.android`). Packages you installed and other files in Linux are lost. Use it when Linux is broken.

**Keep backups private.** A backup holds your Claude sign-in and any SSH keys, so anyone with the file can use your Claude account. A backup is also a normal tar archive: on a computer, `tar -xzf` unpacks `t3-backup.json` and the Linux files under `rootfs/`.

## Running in the background

Android's battery optimisation lets OnePlus and other phones stop an app's background work, even while its notification shows. Agents then stop in the middle of a run. **Running in the background** in **Settings > This phone** shows whether the app is optimised. **Allow background use** opens Android's prompt, or its battery optimisation list on phones without the prompt. The row updates when you come back.

The app also asks once, the first time you start the server or turn on **Stay connected** in **Settings > Notifications** while it is optimised. If you choose **Not now**, it does not ask again.

Some phones have their own battery settings on top of Android's. For several makers, including OnePlus, Samsung and Xiaomi, the section links to that maker's page on dontkillmyapp.com.

## USB devices

The Linux environment can use USB devices plugged into the phone with a USB OTG adapter or cable, for example another phone for `adb` and `fastboot`, or a board for `openocd` or `dfu-util`.

1. Plug the device in. It appears under **USB devices** in **Settings > This phone**.
2. Tap the device and allow access in Android's prompt. `t3-usb allow` in **Open Linux shell** asks the same thing for every attached device.
3. Use your tool as usual, for example `apt install adb fastboot usbutils`, then `adb devices` or `lsusb`.

Every program in the shell and every agent on the built-in server sees allowed devices, including programs that use libusb, such as `lsusb`, `fastboot`, `heimdall`, `openocd`, `dfu-util` and Python's `pyusb`. Android forgets the permission when a device is unplugged or restarts, and a phone that reboots into fastboot counts as a new device. After you allow a device once, the app asks again by itself whenever a device from the same maker is plugged in.

- `t3-usb` lists every attached device and whether it is allowed. `t3-usb selftest` checks the connection between Linux and the app.
- Keep the app open, or the built-in server running, while you use USB. The app hands each device to Linux.
- Devices that need a Linux kernel driver do not appear as kernel devices: a USB serial adapter gets no `/dev/ttyUSB0`, a USB drive is not a disk you can mount, and a USB network adapter is not a network interface. That needs root on the phone. Programs that talk to such devices through libusb still work, for example `pyusb` or libftdi.
- `lsusb` shows allowed devices only. Their speed and their place in the USB tree are unknown, and `lsusb -t` does not show them.
- Statically linked programs and programs built for musl, such as Alpine binaries, do not get USB access.
- The `adb` server here listens on port 5037. Another app that runs its own `adb` server, such as Termux, uses the same port, so stop one before using the other.

## Download files

In a thread's **Files** view, tap the arrow beside a file, or choose **Download** from a file's actions. On Android 10 and newer the file is saved to `Downloads/T3² code`, and an existing file with the same name is kept. This works with any connected environment. Older Android and iOS open the share sheet.
