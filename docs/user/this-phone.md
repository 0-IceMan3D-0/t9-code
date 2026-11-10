# This phone (Android)

Android builds can run T3 and coding agents such as Claude Code and OpenCode on the phone itself, with no other machine. Open **Settings > This phone**.

## Built-in server

**Set up** downloads Linux, Node and T3, about 500 MB, and starts the server. The app connects to it by itself. The server keeps running in the background behind a notification, and it only listens on the phone.

Then install an agent under **Claude Code** or **OpenCode**; a new environment has neither.

**Claude Code** in **Settings > This phone**:

- **Install Claude Code** installs the version tested with this app. **Update Claude Code** installs the newest release; if that one misbehaves, remove it and install again to go back.
- After installing, use **Sign in to Claude**. Finish in the browser, and paste the code if one appears.
- **Remove Claude Code** keeps your Claude sign-in and settings, so installing it again picks them up. Ollama and Phone GPU models run through Claude Code, so they leave the model picker while it is removed.

- Private projects live in `/root/projects`.
- **Shared project folder** adds `T3Projects` in phone storage as `/root/shared-projects`. Restart the server after changing it.
- **Start when the app opens** starts the server each time the app launches, so you do not need to tap **Start**. It is off by default. It does not start the server after the phone restarts: open the app once. If you stop the server, it stays stopped until the app is closed and opened again.
- **Stop when I leave the app** stops the server after you leave the app, to save battery. It is off by default. Leaving includes going home, switching apps and locking the screen. It waits 2 minutes first, so a quick trip to the browser, the share sheet or a photo picker does not stop it; coming back cancels it. To change the wait, pick a time under **Stop after**, or **Custom** for any number of minutes up to 4 hours. After that it waits while anything still uses the server: a thread that is working or waiting for your approval or answer, a Linux shell tab with a program running, a web server running in Linux, or a backup or restore. It stops 30 seconds after the last of these ends. The server's notification shows the countdown or what it is waiting for, with **Keep running** (until you next leave the app) and **Stop now**. With **Start when the app opens** also on, the server starts again when you come back. Scheduled tasks on the built-in server do not run while it is stopped.
- **Delete environment** removes Linux, the Claude sign-in and every private project. Its dialog offers **Back up first**.

**Open Linux shell** gives a root shell in the same environment. `apt` works there. It does not need the server, but without the server Android may pause it while the app is in the background.

- **Tabs**: tap **+** for up to 8 shells. Each tab shows the program running in it, or its folder. Shells keep running when you switch tabs or leave the screen. Closing a tab ends everything started in it, and asks first if a program is still running.
- **Text size**: pinch the terminal, or use **Larger text** and **Smaller text** in the **⋮** menu. The size is shared with thread terminals.
- **Links**: tap a web link in the output, such as `http://localhost:5173`, to open it in your browser. Long-press it for **Copy link**. Links to `0.0.0.0` open as `127.0.0.1`.
- **Copy and paste**: long-press to select, drag the handles, then **Copy** or **Select all**. The clipboard key in the key row pastes. **Copy screen** in the **⋮** menu copies what is on screen.

## Files

**Browse files** in **Settings > This phone** opens a file explorer that works on the phone directly, even while the server is stopped. **Linux** shows Linux's files, starting in `/root`. **Phone storage** shows the phone's shared storage once you allow "manage all files". To browse another computer, open **Settings > Environments**, pick the environment, then **Browse files**.

- Tap a folder to open it and a file to view it. Long-press for **Edit**, **Open with…**, **Share…**, **Save to Downloads**, **Rename**, **Duplicate**, **Copy**, **Move**, **Copy path**, **Info** and **Delete**. **Info** on a folder adds up its size.
- The **⋮** menu has **New folder**, **New file**, **Import from phone**, **Go to path…**, sorting and **Show hidden files**. **Select** picks several items to copy, move or delete together.
- Type in the search field to filter the folder. On the phone, **Search in all subfolders** finds names anywhere below it.
- After **Copy** or **Move**, open the destination and tap **Paste** or **Move here**. This works between Linux and phone storage too. Name clashes get a "copy" name instead of replacing anything.
- Files open with a viewer for their type: code with highlighting, Markdown and CSV previews, images, video, audio and a hex view. **Edit** opens a text editor with find and replace (including regular expressions), undo and redo, go to line, word wrap, text size and a row of coding symbols. Files over 512 KB open read-only.
- The built-in server's own data in `/root/.t3/userdata` can't be changed from here. On another computer, uploads and saves are limited to 32 MB per file, and a server older than the explorer can only browse, view and download.

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

## Local models with Ollama

**Ollama** in **Settings > This phone** runs open models on the phone's processor, so Claude Code or OpenCode can work with your code staying on the phone.

1. Tap **Install Ollama**. It downloads 1.6 GB once and keeps about 60 MB.
2. With the server running, type a model name from [ollama.com](https://ollama.com/library) and tap **Download model**. Small models that use tools work best, such as `qwen3:1.7b` or `qwen3:4b`.
3. In a thread on the built-in server, pick the model under **Ollama** in the model picker to use it with Claude Code, or under **OpenCode** once [OpenCode](#opencode) is installed.

- Ollama starts and stops with the built-in server.
- **Expect each turn to take minutes.** The agent sends long instructions with every turn, and a phone's processor reads them slowly. A short reply from `qwen3:1.7b` takes about 13 minutes on a 2020 phone. Ollama keeps a model loaded for 30 minutes after a turn, so the next one starts sooner.
- A model needs about as much free memory as its download size plus a few GB for the agent's instructions.
- Tap a model to delete it. **Remove Ollama** deletes Ollama and every model, and removes the **Ollama** choice from the model picker.
- Backups leave out downloaded models; download them again after a restore. Ollama's log is `/var/log/ollama.log` in Linux.

## Local models on the GPU

**Phone GPU** in **Settings > This phone** runs Google's Gemma 4 models on the phone's graphics processor, much faster than Ollama.

1. Tap **Download Gemma 4 E2B** (2.6 GB, fastest) or **Download Gemma 4 E4B** (3.7 GB, writes better). A dropped download continues where it stopped.
2. In a thread on the built-in server, pick the model under **Phone GPU** in the model picker to use it with Claude Code, or under **OpenCode** once [OpenCode](#opencode) is installed.

- The first message in a thread reads the agent's instructions, about 15,000 tokens for Claude Code: a few seconds on a recent flagship phone, about a minute on a phone from 2020. Each later step in the same thread continues from there and takes seconds. Switching between threads reads the instructions again.
- The model loads with the first message and stays loaded for 30 minutes after the last one. One model runs at a time, and threads take turns.
- A thread holds 32,000 tokens, or 24,000 on phones whose GPU has less memory; **Phone GPU** shows which. Claude Code and OpenCode summarize older messages when a thread fills up.
- Small models make mistakes, such as a tool call the agent cannot read. The agent retries it.
- Some GPUs cannot load these models. T3² Code tells you when that happens; use Ollama on that phone instead.
- Models are kept outside Linux, so backups and **Reset Linux** do not touch them. Tap a model to delete it.

## OpenCode

**OpenCode** in **Settings > This phone** installs OpenCode in Linux and turns it on for the built-in server. Pick **OpenCode** in a thread's model picker to use it.

- OpenCode's free models work without an account. To use your own providers, run `opencode auth login` in a Linux shell.
- Models from Ollama and Phone GPU on this phone show up in OpenCode as **Ollama on this phone** and **Phone GPU**.
- **Update OpenCode** installs the newest release.

## Health

**Health** in **Settings > This phone** shows how much memory and CPU the built-in environment uses (the server, shells and agents in Linux), how much memory the phone has free, and how much storage Linux and private projects take. It updates every few seconds while the screen is open.

When the phone runs low on memory, or Linux uses a large share of it, Android may stop the server and its agents. A warning then shows on This phone. If the server runs while the app is in the background, a notification says so, at most every 30 minutes. You can turn it off under the **Built-in server warnings** category in Android's notification settings for the app.

## Back up, restore and reset

**Settings > This phone > Maintenance** has three tools. Each one stops the server first if it is running, after asking.

- **Back up Linux** saves one `.tar.gz` file with Linux and its installed packages, private projects, threads on This phone, and Claude Code's sign-in and settings. Choose **Save to Downloads** (it goes to `Downloads/T3² Code`) or **Choose location**. Caches that refill themselves are left out: `/tmp`, apt's downloaded packages, npm's download cache and `/root/.cache`. Projects in the shared folder are not included. The backup keeps running in the background behind a notification, and you can cancel it.
- **Restore from backup** checks the file you pick, shows when and by which app version it was made, and asks before it replaces the current environment. It unpacks next to the current environment and switches over only when the whole file checked out, so a damaged file or a cancel leaves everything as it was. Restoring needs free space for both copies until it finishes.
- **Reset Linux** downloads a fresh Linux, about 500 MB, and sets it up again, like the first setup. It keeps private projects, Claude Code's sign-in and settings (`~/.claude` and `~/.claude.json`), threads on This phone, git settings (`~/.gitconfig`), SSH keys (`~/.ssh`), adb keys (`~/.android`) and OpenCode's settings and sign-ins. Claude Code and OpenCode are installed again if they were installed before (Claude Code at the tested version). Other packages you installed and other files in Linux are lost. Use it when Linux is broken.

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

In a thread's **Files** view, tap the arrow beside a file, or choose **Download** from a file's actions. On Android 10 and newer the file is saved to `Downloads/T3² Code`, and an existing file with the same name is kept. This works with any connected environment. Older Android and iOS open the share sheet.

## Opening thread links

Links to threads, such as `https://app.t3.codes/threads/...`, open in the browser until you allow the app to open them. This takes one step per phone, on Android 12 or newer:

1. Open Android **Settings > Apps > T3² Code > Open by default**.
2. Turn on **Open supported links**.
3. Tap **Add link**, tick `app.t3.codes`, and tap **Add**.

The menu names differ slightly between phone makers. If the steps don't match, search Android settings for **Open by default**. On Android 11 and older, choose T3² Code when Android asks which app should open the link.

## App updates

**Settings > About > Check for updates** looks for a newer build on GitHub, and the app also checks once a day when it opens. Tap **Update** to download it; Android asks you to confirm the install. The first time, Android asks you to allow installs from T3² Code: turn on **Allow from this source**, come back, and tap **Update** again. **Later** skips that build until a newer one comes out.
