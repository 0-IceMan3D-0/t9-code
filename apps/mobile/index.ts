// Must stay first: the render counter and behavior probe wrap the DevTools hook before any React commit.
import "./src/features/development/render-counter-entry";
import "./src/features/development/behavior-probe-entry";
// Next, so errors thrown while the rest of the app loads are recorded too.
import { registerRootComponent } from "expo";
import "react-native-gesture-handler";
import { AppRegistry, LogBox } from "react-native";
import { featureFlags } from "react-native-screens";

import App from "./src/App";
import { runThreadNotificationAction } from "./src/features/agent-awareness/threadNotificationActions";
import { waitForWatchedEnvironmentsLive } from "./src/features/agent-awareness/threadNotificationCoordinator";

// Enables iOS FormSheet sizing for nested native stacks in non-fitToContents sheets.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

// Android starts these without an activity: notification actions, and timer windows that let
// background connections reconnect.
AppRegistry.registerHeadlessTask("T3ThreadNotificationAction", () => runThreadNotificationAction);
AppRegistry.registerHeadlessTask("T3NotificationTimerWindow", () => waitForWatchedEnvironmentsLive);

registerRootComponent(App);
