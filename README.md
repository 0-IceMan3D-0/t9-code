# t9 code

t9 code is an Android app that runs coding agents on the phone itself. It is a fork of [T3 Code](https://github.com/pingdotgg/t3code) that adds a built-in T3 server, a full Linux environment and on-device models, so Claude Code and OpenCode can work on your projects with no computer, Termux setup or USB connection. On the phone, the app is named **T3² code**.

The app can still connect to T3 Code servers on other machines, like the upstream mobile app.

> t9 code is an independent project. It is not affiliated with or supported by T3 Tools Inc. or the T3 Code maintainers. Report problems with this app here, not upstream.

## Features

- **Built-in server.** Runs a T3 server on the phone, in an Ubuntu 24.04 environment with Node.js. The server listens only on the phone and can keep running in the background.
- **Coding agents.** Install Claude Code and OpenCode from the app. You can update or remove each one independently.
- **On-device models.** Ollama runs open models on the CPU. Phone GPU runs Google's Gemma 4 models on the graphics processor. Both models work with Claude Code and OpenCode.
- **Linux shell.** A root terminal with tabs, `apt`, clickable links and copy and paste.
- **File explorer.** Browse, view and edit files in Linux and in phone storage, with syntax highlighting and a text editor.
- **Git and GitHub.** Set your commit identity, create an SSH key and add it to GitHub from the app.
- **Web servers.** Development servers started in Linux are detected and can be opened in the phone's browser.
- **USB devices.** `adb`, `fastboot`, `openocd`, `dfu-util` and other libusb tools can use devices that are plugged into the phone.
- **Backup and restore.** Save the whole Linux environment to one file, restore it, or reset Linux and keep your projects and sign-ins.
- **Android integration.** Home screen widgets, a Quick Settings tile, launcher shortcuts and notifications.
- **Automatic updates.** The app checks this repository for new builds and installs them through the Android installer.

## Requirements

- Android 7.0 or later on a 64-bit ARM (arm64-v8a) device.
- An internet connection for the first setup. Setup downloads about 500 MB, and the environment takes about 1 GB of storage before you add agents, models or projects.
- Enough free memory for the agents and models you use. Local models need at least their download size in free memory, plus a few GB.

## Installation

1. Download `t9-code.apk` from the [latest release](https://github.com/0-IceMan3D-0/t9-code/releases/latest).
2. Open the file on the phone. If Android asks, allow installs from the app that opened it.
3. Open the app, go to **Settings > This phone** and tap **Set up**.
4. Install **Claude Code** or **OpenCode**, then sign in or choose a model.
5. Start a new thread on **This phone**.

## Updates

Every change to `main` produces a new signed release. The app checks for a newer release once a day when it opens. You can also go to **Settings > About > Check for updates**. To install an update, tap **Update** and confirm the install. The first time, Android asks you to allow installs from T3² code.

Builds made before automatic updates were added were signed with a different key, so Android won't install the new builds over them. To move to the new builds:

1. Back up Linux in **Settings > This phone > Maintenance**.
2. Uninstall the app.
3. Install the latest release.
4. Restore the backup.

Later updates install over the app and keep your data.

## Documentation

- [This phone](./docs/user/this-phone.md): the built-in server, agents, local models, files, backups, USB and updates.
- [Home screen widgets](./docs/user/home-screen-widgets.md)
- [Mobile notifications](./docs/user/mobile-notifications.md)
- [Remote access](./docs/user/remote-access.md): connecting to T3 Code servers on other machines.
- [FAQ](./docs/user/faq.md)

Other guides in [docs/user](./docs/user) describe T3 Code features shared with the upstream project.

## Security and privacy

- The built-in server listens only on the phone. Other devices cannot reach it or the web servers that run in Linux.
- Agents run as root inside the app's Linux environment, which is confined to the app's private storage. They can read phone storage only if you grant the app access to all files.
- Backups contain your agent sign-ins and SSH keys. Store them as you would store a password.
- Updates are downloaded only from this repository's releases. The app installs an update only if the APK has the app's package name and a newer version number. Android then checks that the update is signed with the same key as the installed app.

## Building from source

The release workflow, [`.github/workflows/t9-android-release.yml`](./.github/workflows/t9-android-release.yml), is the reference build. To build locally, you need [Vite+](https://viteplus.dev/guide/) (`vp`), JDK 17 and the Android SDK.

```bash
vp i
cp .env.example .env
cd apps/mobile
APP_VARIANT=development T3CODE_MOBILE_UPDATES_ENABLED=0 npx expo prebuild --clean --platform android
cd android
./gradlew app:assembleRelease -PreactNativeArchitectures=arm64-v8a
```

The APK is written to `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`. Without signing variables, the build is signed with the Android debug key. To sign with a release key, set `T9_KEYSTORE_PATH`, `T9_KEYSTORE_PASSWORD`, `T9_KEY_ALIAS` and `T9_KEY_PASSWORD` before running Gradle. A self-built APK can't update an install of the published release, and the published release can't update a self-built APK, because the two are signed with different keys.

Before you commit, run `vp run check:changed`. The workspace layout and development conventions are described in [AGENTS.md](./AGENTS.md) and [docs/internals](./docs/internals).

## License

t9 code is released under the [MIT License](./LICENSE). It is based on T3 Code, copyright T3 Tools Inc.

The app includes [PRoot](https://proot-me.github.io/), which is licensed under the GNU General Public License, version 2. During setup, the app downloads Ubuntu Base and Node.js, which have their own licenses. See [open source licenses](./docs/user/open-source-licenses.md) for the other components.
