# Home screen widgets (Android)

The Android app has five home screen widgets. Long-press an empty spot on your home screen, choose **Widgets**, and find them under T3² code. Every widget can be resized; smaller sizes show less, such as one thread or a single line. They follow the phone's light or dark theme and show the app icon you chose in **Settings → Appearance**.

| Widget                  | Shows                                                                                                                                    | Tap                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Working threads**     | Threads that are working or waiting for you, on every server, newest first. **Needs you** marks approvals, questions and guest messages. | A row opens its thread.                                                                                                                                          |
| **Recent threads**      | Your latest threads with their project and status.                                                                                       | A row opens its thread.                                                                                                                                          |
| **This phone's server** | Whether the built-in server is running, starting, stopped or not set up, its memory use, and the newest web server running in Linux.     | **Start** or **Stop** controls the server without opening the app. **Open** opens the web server in your browser. Anywhere else opens **Settings → This phone**. |
| **Quick actions**       | **New thread**, **Linux shell**, and your newest web server while one runs.                                                              | Each button opens its screen or the web server.                                                                                                                  |
| **Usage today**         | Tokens your threads used since midnight and your busiest project.                                                                        | Opens **Usage**.                                                                                                                                                 |

## Keeping widgets up to date

The server and quick action widgets update on their own. The thread and usage widgets get their data from the app, so they stay current while the app is open or keeps running in the background: while the built-in server runs, or with **Stay connected** on in **Settings → Notifications**. Otherwise Android pauses the app soon after you leave it, and these widgets show **Updated … ago** until you open the app again. The same note appears when a server they list is not connected.

Widgets only redraw when something they show changes, so they do not wake your phone or use battery while nothing happens. Memory use refreshes about every two minutes while the screen is on.

If you force-stop the app in Android settings, the server widget may keep showing the old state until you tap it or open the app.

The **Subscription usage** widget is described in [Usage and limits](./usage.md#subscription-usage-widget). On Android it needs Android 12L or newer.
