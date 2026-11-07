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

## Termux

**Install Termux** downloads the official Termux environment, about 35 MB, beside the built-in server. It is separate from an installed Termux app, and neither can see the other's files.

**Open Termux** shows your sessions. Use **+** for a new session, **×** to close one, long-press to select and copy, and **Paste** to paste. Sessions continue when you leave the screen, and the notification shows how many are running. **Stop** in the notification ends the server and every session.

`pkg`, compilers, Python, Git and SSH work. These do not, because they talk to the Termux app itself:

- Termux:API commands, which hang. Press Ctrl+C.
- `termux-setup-storage`, `termux-open` and `termux-wake-lock`. Don't run them if the Termux app is installed: they act on that app. Phone storage is already at `/sdcard`.
- Termux:Boot, Termux:Widget and Termux:Styling, which keep working with the Termux app only.
- `proot-distro`, which refuses to run here. Use **Open Linux shell** for a Linux distribution.

Programs that start many processes run about four times slower than outside this environment.

**Delete Termux environment** removes only Termux.

## Download files

In a thread's **Files** view, tap the arrow beside a file, or choose **Download** from a file's actions. On Android 10 and newer the file is saved to `Downloads/T3² code`, and an existing file with the same name is kept. This works with any connected environment. Older Android and iOS open the share sheet.
