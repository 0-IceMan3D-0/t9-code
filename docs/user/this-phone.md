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

## Git and GitHub

**Git and GitHub** in **Settings > This phone** sets up git for Linux. The built-in server's agents run as the same root user, so they commit with this identity and push with this key.

1. If git or SSH is missing, tap **Install git and SSH**.
2. Type a name and email for your commits and tap **Save identity**. Clear both and save to remove them.
3. Tap **Create SSH key**. This makes an ed25519 key at `/root/.ssh/id_ed25519` with no passphrase, so agents can use it without asking.
4. Tap **Copy public key**, then **Add to GitHub**, and paste the key on GitHub's **New SSH key** page.
5. Tap **Test connection**. "Connected to GitHub" means the key works. If GitHub says it does not know the key, it was not added yet.

GitHub's host keys are added to `/root/.ssh/known_hosts` for you, so the first connection does not ask whether to trust GitHub. The private key never leaves Linux, but backups of Linux include it, so keep them private. **Replace key** and **Delete key** ask before removing the old key; remove it from GitHub too.

To use the GitHub CLI instead, run `apt install gh`, then `gh auth login` in the Linux shell.

## Quick Settings tile

Add the **T3² server** tile from the Quick Settings edit screen (pull down the shade twice, then the pencil). It shows whether the built-in server is running, starting or stopped. Tap it to start or stop the server without opening the app. Long-press it to open **Settings > This phone**. Before Linux is set up, tapping it opens This phone.

## Launcher shortcuts

Long-press the app icon for **New thread**, **Start server** (or **Stop server** while it runs), **Linux shell** and your recent threads. Before Linux is set up, **Set up this phone** takes the server's place. Start and stop work without opening the app. Shortcuts keep working after you change the app icon in **Settings > Appearance**. Drag one to the home screen to keep it there.

## Web servers in Linux

When a program in Linux starts a web server, such as an agent running `vite`, `next dev` or `python3 -m http.server`, it shows under **Running web servers** in **Settings > This phone**. Tap a server to open it in your browser, or copy its link. Threads on the built-in server show the same links above the composer: tap one to open it, long-press to copy it. While the server runs, its notification also names the newest web server and has an **Open** button.

- Links point at `127.0.0.1` and work only on this phone. Other devices cannot reach these servers.
- A server leaves the list when it stops listening.
- The list shows servers started by most programs (Node, Python, Ruby, PHP, Java and other programs linked against the system's C library). Statically linked programs, such as many Go binaries, are not detected, but their links still work if you type them in the browser.
- The first time a server shows while **This phone** is open, the app loads its page once to read the page title. Servers that log requests show that request.

## Health

**Health** in **Settings > This phone** shows how much memory and CPU the built-in environment uses (the server, shells and agents in Linux), how much memory the phone has free, and how much storage Linux and private projects take. It updates every few seconds while the screen is open.

When the phone runs low on memory, or Linux uses a large share of it, Android may stop the server and its agents. A warning then shows on This phone. If the server runs while the app is in the background, a notification says so, at most every 30 minutes. You can turn it off under the **Built-in server warnings** category in Android's notification settings for the app.

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
