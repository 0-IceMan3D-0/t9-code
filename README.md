<div align="center">

# T3² Code

**Run Claude Code and OpenCode on your Android phone. No computer needed.**

[Download the latest APK](https://github.com/0-IceMan3D-0/t9-code/releases/latest) · [Full guide](./docs/user/this-phone.md) · [Report a problem](https://github.com/0-IceMan3D-0/t9-code/issues)

</div>

---

T3² Code is a fork of [T3 Code](https://github.com/pingdotgg/t3code) for Android, developed in the **t9-code** repository. It puts a complete coding setup on your phone: a T3 server, a Linux environment, coding agents and local AI models. You can still connect to T3 Code servers on your other machines, just like with the original app.

> [!NOTE]
> T3² Code is an independent project. It is not affiliated with T3 Tools Inc. or the T3 Code team.

## Contents

- [Requirements](#requirements)
- **Agents and models:** [Built-in server](#built-in-server) · [Claude Code](#claude-code) · [OpenCode](#opencode) · [Phone GPU models](#phone-gpu-models) · [Ollama models](#ollama-models)
- **Developer tools:** [Linux shell](#linux-shell) · [File explorer](#file-explorer) · [Git and GitHub](#git-and-github) · [Web servers](#web-servers) · [USB devices](#usb-devices)
- **Keeping it running:** [Backup, restore and reset](#backup-restore-and-reset) · [Running in the background](#running-in-the-background) · [Health](#health)
- **Phone integration:** [Notifications](#notifications) · [Widgets, tile and shortcuts](#widgets-tile-and-shortcuts) · [Thread links](#opening-thread-links) · [App updates](#app-updates) · [Other machines](#connecting-to-other-machines)
- [For developers](#for-developers) · [License](#license)

## Requirements

|               |                                                                                |
| ------------- | ------------------------------------------------------------------------------ |
| **Android**   | 7.0 or later                                                                   |
| **Processor** | 64-bit ARM (arm64-v8a)                                                         |
| **Storage**   | About 1 GB, plus room for agents, models and projects                          |
| **Memory**    | Local models need free RAM roughly equal to their download size, plus a few GB |

---

## Agents and models

### Built-in server

The built-in server runs T3 inside a private Ubuntu 24.04 environment on the phone, with Node.js. The app connects to it by itself, and it keeps running in the background behind a notification.

**Get started:** open **Settings > This phone** and tap **Set up**. The first setup downloads about 500 MB. These options are in **Settings > This phone > Options**:

| Option                        | What it does                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start when the app opens**  | Starts the server every time you open the app. Off by default.                                                                                                      |
| **Stop when I leave the app** | Stops the server after you leave the app, to save battery. It waits 2 minutes by default, and longer while an agent is working or a shell or web server is running. |
| **Shared project folder**     | Adds `T3Projects` in phone storage as `/root/shared-projects`. Private projects live in `/root/projects`.                                                           |
| **Delete environment**        | Removes Linux, sign-ins and private projects. It offers to make a backup first.                                                                                     |

> [!IMPORTANT]
> The server only listens on the phone. Other devices cannot connect to it or to anything it runs.

### Claude Code

Anthropic's coding agent, installed into the phone's Linux environment.

1. In **Settings > This phone > Agents**, tap **Install Claude Code**. This installs the version tested with T3² Code.
2. Tap **Sign in to Claude**, finish in the browser, and paste the code if one appears.
3. Start a thread on **This phone** and pick a Claude model.

- **Update Claude Code** installs the newest release. If it misbehaves, remove Claude Code and install it again to return to the tested version.
- **Remove Claude Code** keeps your sign-in and settings, so installing it again picks them up.
- The phone's Phone GPU and Ollama models run through Claude Code, so they appear in the model picker only while it is installed.

### OpenCode

An open-source coding agent that works without an account.

1. In **Settings > This phone > Agents**, tap **Install OpenCode**. The OpenCode provider is turned on for you.
2. Pick **OpenCode** in a thread's model picker.

- OpenCode's free models need no sign-in.
- To add your own providers, run `opencode auth login` in the Linux shell.
- Phone GPU and Ollama models appear in OpenCode as **Phone GPU** and **Ollama on this phone**.

### Phone GPU models

Runs Google's Gemma 4 models on the phone's graphics processor. This is the fastest way to use an agent with no internet or account.

| Model       | Download | Best for       |
| ----------- | -------- | -------------- |
| Gemma 4 E2B | 2.6 GB   | Speed          |
| Gemma 4 E4B | 3.7 GB   | Better writing |

1. In **Settings > This phone > Models**, download a Phone GPU model. If the download stops, it continues from where it left off.
2. In a thread on the built-in server, pick the model under **Phone GPU**, either with Claude Code or with OpenCode.

- The first message in a thread reads the agent's instructions. This takes a few seconds on a recent flagship phone and about a minute on a phone from 2020. Later messages in the same thread take seconds.
- A thread holds 32,000 tokens, or 24,000 on phones with less GPU memory. Agents summarize older messages when a thread fills up.
- The model stays loaded for 30 minutes after the last message. One model runs at a time.

> [!TIP]
> Some GPUs cannot load these models. T3² Code tells you when that happens; use Ollama on that phone instead.

### Ollama models

Runs open models from [ollama.com](https://ollama.com/library) on the phone's processor. It works on any phone, but much more slowly than Phone GPU.

1. In **Settings > This phone > Models**, tap **Install Ollama**. It downloads 1.6 GB once and keeps about 60 MB.
2. With the server running, type a model name and tap **Download model**. Small models that support tools work best, such as `qwen3:1.7b` or `qwen3:4b`.
3. In a thread on the built-in server, pick the model under **Ollama**.

- Expect each turn to take minutes. A short reply from `qwen3:1.7b` takes about 13 minutes on a 2020 phone.
- Ollama starts and stops with the built-in server. Its log is `/var/log/ollama.log`.
- Backups do not include downloaded models; download them again after a restore.

---

## Developer tools

### Linux shell

**Settings > This phone > Linux > Open Linux shell** gives you a root shell in the same environment the agents use. `apt` works, so you can install any Ubuntu package.

| Feature            | How to use it                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Tabs**           | Tap **+** for up to 8 shells. They keep running when you switch tabs or leave the screen.                        |
| **Text size**      | Pinch the terminal, or use the **⋮** menu.                                                                       |
| **Links**          | Tap a link such as `http://localhost:5173` to open it. Long-press to copy it.                                    |
| **Copy and paste** | Long-press to select text. The clipboard key pastes. **Copy screen** in the **⋮** menu copies what is on screen. |

### File explorer

**Settings > This phone > Linux > Browse files** works even while the server is stopped. It shows **Linux** (starting in `/root`) and **Phone storage**, once you allow access to all files.

- **Manage files:** long-press for edit, share, rename, duplicate, copy, move, info and delete. **Select** works on several items at once. You can copy and move between Linux and phone storage.
- **View files:** code with syntax highlighting, Markdown and CSV previews, images, video, audio and a hex view.
- **Edit files:** find and replace (with regular expressions), undo and redo, go to line and a row of coding symbols. Files over 512 KB open read-only.
- **Search:** filter the current folder, or search every subfolder.

You can also browse another computer's files from **Settings > Environments**.

### Git and GitHub

**Settings > This phone > Linux > Git and GitHub** sets up git for Linux. Agents commit with this identity and push with this key.

1. Tap **Install git and SSH** if they are missing.
2. Enter a name and email, then tap **Save identity**.
3. Tap **Create SSH key**, then **Copy public key** and **Add to GitHub**.
4. Tap **Test connection**. **Connected to GitHub** means the key works.

> [!TIP]
> To use the GitHub CLI instead, run `apt install gh` and then `gh auth login` in the Linux shell.

### Web servers

When an agent or the shell starts a web server, such as `vite`, `next dev` or `python3 -m http.server`, it appears under **Running web servers** in **Settings > This phone > Linux**.

- Tap a server to open it in your browser, or copy its link.
- Threads on the built-in server show the same links above the message box.
- The server notification names the newest web server and has an **Open** button.
- Links use `127.0.0.1` and work only on this phone.

### USB devices

Plug in a device with a USB OTG adapter, such as another phone or a development board, and use it from Linux.

1. The device appears under **USB devices** in **Settings > This phone > Linux**.
2. Tap it and allow access. `t3-usb allow` in the shell does the same for every attached device.
3. Use your tools as usual, for example `apt install adb fastboot usbutils`, then `adb devices`.

Tools that use libusb work, including `adb`, `fastboot`, `heimdall`, `openocd`, `dfu-util` and Python's `pyusb`. `t3-usb` lists devices and their status.

> [!NOTE]
> Devices that need a Linux kernel driver, such as USB serial adapters, USB drives and network adapters, do not show up as kernel devices. That would need root on the phone.

---

## Keeping it running

### Backup, restore and reset

All three tools are in **Settings > This phone > Maintenance**.

| Tool                    | What it does                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Back up Linux**       | Saves Linux, installed packages, private projects, threads and agent sign-ins as one `.tar.gz` file, to `Downloads/T3² Code` or a location you choose. |
| **Restore from backup** | Checks the file, shows when it was made, and replaces the current environment only if the whole file is valid.                                         |
| **Reset Linux**         | Installs a fresh Linux and keeps projects, threads, sign-ins, git settings and SSH keys. Agents you had installed are installed again.                 |

> [!WARNING]
> A backup contains your agent sign-ins and SSH keys. Anyone with the file can use your accounts, so keep it private.

### Running in the background

Some phones, including OnePlus, Samsung and Xiaomi models, stop background apps even while they show a notification. That stops agents in the middle of their work.

**Settings > This phone > Options > Running in the background** shows whether Android optimizes the app's battery use. **Allow background use** turns that optimization off. For phones with their own battery settings, the section links to that maker's page on [dontkillmyapp.com](https://dontkillmyapp.com).

### Health

**Settings > This phone > Health** graphs how much memory and CPU the environment uses, how much memory the phone has free, and how much storage Linux and projects take. When memory runs low, Android may stop the server; the app warns you when this is likely.

---

## Phone integration

### Notifications

Turn them on in **Settings > Notifications > Agent notifications**. No account is needed.

| Notification           | What you can do                                                     |
| ---------------------- | ------------------------------------------------------------------- |
| **Approval needed**    | Allow or deny the command from the notification.                    |
| **Question**           | Tap an answer, or reply with your own text.                         |
| **Finished or failed** | Read a preview of the agent's last message and reply to the thread. |

- The built-in server always reaches you while it runs. Servers on other machines reach you in the background only with **Stay connected** on.
- To silence a project, turn it off under **Projects**. To silence a thread, choose **Mute notifications** from its menu.

### Widgets, tile and shortcuts

**Home screen widgets.** Long-press the home screen, choose **Widgets** and find **T3² Code**. There are ten widgets: Working threads, Recent threads, This phone's server, Quick actions, Usage today, New thread bar, Gauges, Status line, Limits and Tokens today. See [Home screen widgets](./docs/user/home-screen-widgets.md) for details.

**Quick Settings tile.** Add the **T3² server** tile from the Quick Settings edit screen. Tap it to start or stop the server, and long-press it to open **This phone**.

**Launcher shortcuts.** Long-press the app icon for **New thread**, **Start server** or **Stop server**, **Linux shell** and your recent threads.

### Opening thread links

Thread links, such as `https://app.t3.codes/threads/...`, open in the browser until you allow the app to open them. Do this once on each phone, on Android 12 or newer:

1. Open Android **Settings > Apps > T3² Code > Open by default**.
2. Turn on **Open supported links**.
3. Tap **Add link**, tick `app.t3.codes`, and tap **Add**.

If your phone's menus are named differently, search Android settings for **Open by default**.

### App updates

T3² Code checks this repository for a new build once a day when it opens. To check now, open **Settings > About > Check for updates**.

1. Tap **Update**. The app downloads the new build.
2. Confirm the install in Android's prompt.
3. The first time, Android asks you to allow installs from the app. Turn on **Allow from this source**, go back, and tap **Update** again.

**Later** skips that build until a newer one is published.

### Connecting to other machines

T3² Code is still a full T3 Code client. To control agents on your computer or a server from your phone, see [Remote access](./docs/user/remote-access.md).

---

## For developers

Architecture, build and release details are in the [technical notes](./docs/internals/android-builtin-server.md).

## License

[MIT](./LICENSE). Based on T3 Code by T3 Tools Inc.

T3² Code includes [PRoot](https://proot-me.github.io/) (GPL-2.0). During setup it downloads Ubuntu Base and Node.js, which come with their own licenses.
