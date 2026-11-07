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

## Download files

In a thread's **Files** view, tap the arrow beside a file, or choose **Download** from a file's actions. On Android 10 and newer the file is saved to `Downloads/T3² code`, and an existing file with the same name is kept. This works with any connected environment. Older Android and iOS open the share sheet.
