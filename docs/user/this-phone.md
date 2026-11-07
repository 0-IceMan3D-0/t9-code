# This phone (Android)

Android builds can run T3 and Claude Code on the phone itself, with no other machine. Open **Settings > This phone**.

## Built-in server

**Set up** downloads Linux, Node, T3 and Claude Code, about 500 MB, and starts the server. The app connects to it by itself. The server keeps running in the background behind a notification, and it only listens on the phone.

Use **Sign in to Claude** after the server starts. Finish in the browser, and paste the code if one appears.

- Private projects live in `/root/projects`.
- **Shared project folder** adds `T3Projects` in phone storage as `/root/shared-projects`. Restart the server after changing it.
- **Start when phone turns on** starts the server after the first unlock.
- **Delete environment** removes Linux, the Claude sign-in and every private project.

**Open Linux shell** gives a root shell in the same environment. `apt` works there. It does not need the server, but without the server Android may pause it while the app is in the background.

## USB devices

The Linux environment can use USB devices plugged into the phone, for example another Android phone on a USB OTG cable. This is for `adb` and `fastboot`.

1. Run `apt install adb fastboot` in **Open Linux shell**.
2. Plug the device in. It appears under **USB devices** in **Settings > This phone**.
3. Tap the device and allow access in Android's prompt. `t3-usb allow` in the shell asks the same thing.
4. Run `adb devices`. On the other phone, accept the USB debugging prompt.

`adb` and `fastboot` work in the shell and for agents running on the built-in server. Android forgets the permission when a device is unplugged or restarts, and a phone that reboots into fastboot counts as a new device. After you allow a device once, the app asks again by itself whenever a device from the same maker is plugged in.

- `t3-usb` lists attached devices and whether each one is allowed. `t3-usb selftest` checks the connection between Linux and the app.
- Keep the app open, or the built-in server running, while you use USB. The app hands each device to Linux.
- Run `adb` and `fastboot` by name. `/usr/bin/adb` does not see USB devices. Other USB tools, such as `lsusb`, do not see them either.
- The `adb` server here listens on port 5037. Another app that runs its own `adb` server, such as Termux, uses the same port, so stop one before using the other.

## Download files

In a thread's **Files** view, tap the arrow beside a file, or choose **Download** from a file's actions. On Android 10 and newer the file is saved to `Downloads/T3² code`, and an existing file with the same name is kept. This works with any connected environment. Older Android and iOS open the share sheet.
