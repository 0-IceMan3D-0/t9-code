import * as Notifications from "expo-notifications";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { subscribeAppState } from "../../lib/appState";
import { useEnvironments } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { offerBatteryExemption } from "../local-server/batteryOptimization";
import { postTestThreadNotification } from "../agent-awareness/threadNotificationCoordinator";
import {
  scopedNotificationKey,
  type ThreadNotificationSettings,
} from "../agent-awareness/threadNotificationModel";
import { threadNotificationsNative as native } from "../agent-awareness/threadNotificationNative";
import {
  toggleMutedKey,
  updateThreadNotificationSettings,
  useThreadNotificationSettings,
} from "../agent-awareness/threadNotificationSettings";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

// A string snapshot keeps useSyncExternalStore stable; it is re-read when the app returns.
function permissionSnapshot(): string {
  const state = native?.threadPermissionState();
  if (!state) return "unknown";
  if (!state.enabled) return "blocked";
  return state.needsYou === 0 || state.finished === 0 || state.errors === 0 ? "channel-off" : "ok";
}

function set(update: Partial<ThreadNotificationSettings>) {
  updateThreadNotificationSettings(() => update);
}

async function allowNotifications() {
  if (Platform.OS === "android" && Number(Platform.Version) >= 33) {
    const existing = await Notifications.getPermissionsAsync().catch(() => null);
    if (existing?.canAskAgain !== false) {
      const result = await Notifications.requestPermissionsAsync().catch(() => null);
      if (result?.granted) return;
    }
  }
  if (!native?.threadOpenSettings(null)) {
    Dialog.alert(
      "Couldn't open Settings",
      "Open Android Settings, select T3² code, then Notifications.",
    );
  }
}

/** On-device notifications: they need no account and cover every saved environment. */
export function ThreadNotificationSettingsSections() {
  const settings = useThreadNotificationSettings();
  const permission = useSyncExternalStore(subscribeAppState, permissionSnapshot);
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const listedProjects = projects.filter((project) => !project.isScratch && !project.archivedAt);
  const mutedThreads = threads.filter((thread) =>
    settings.mutedThreads.includes(scopedNotificationKey(thread.environmentId, thread.id)),
  );
  const off = !settings.enabled;

  return (
    <>
      <SettingsSection
        title="On this device"
        footer="Works with every server this app is connected to, including This phone, and needs no account."
      >
        {permission === "blocked" ? (
          <SettingsRow
            icon="exclamationmark.triangle"
            label="Notifications are blocked"
            value="Allow them so agents can reach you"
            valuePosition="below"
            onPress={() => void allowNotifications()}
          />
        ) : null}
        {permission === "channel-off" ? (
          <SettingsRow
            icon="exclamationmark.triangle"
            label="Some notification categories are off"
            value="Turn them on in Android settings"
            valuePosition="below"
            onPress={() => native?.threadOpenSettings(null)}
          />
        ) : null}
        <SettingsSwitchRow
          icon="bell.badge"
          label="Agent notifications"
          subtitle="Finished, failed, approvals and questions, with actions"
          value={settings.enabled}
          onValueChange={(enabled) => {
            set({ enabled });
            if (enabled && permission === "blocked") void allowNotifications();
          }}
        />
      </SettingsSection>
      <SettingsSection title="Notify me when an agent">
        <SettingsSwitchRow
          icon="exclamationmark.shield"
          label="Needs approval"
          disabled={off}
          value={settings.approval}
          onValueChange={(approval) => set({ approval })}
        />
        <SettingsSwitchRow
          icon="questionmark.bubble"
          label="Asks a question"
          disabled={off}
          value={settings.input}
          onValueChange={(input) => set({ input })}
        />
        <SettingsSwitchRow
          icon="checkmark.circle"
          label="Finishes a turn"
          disabled={off}
          value={settings.finished}
          onValueChange={(finished) => set({ finished })}
        />
        <SettingsSwitchRow
          icon="exclamationmark.circle"
          label="Fails or hits a limit"
          disabled={off}
          value={settings.failed}
          onValueChange={(failed) => set({ failed })}
        />
      </SettingsSection>
      <SettingsSection
        title="In the background"
        footer="While the built-in server runs, This phone always stays connected. Other servers reach you in the background only with Stay connected on. It keeps their connections open behind a silent notification and uses more battery. Without it, their notifications arrive when you next open the app."
      >
        <SettingsSwitchRow
          icon="cable.connector"
          label="Stay connected"
          subtitle="For servers other than This phone"
          disabled={off}
          value={settings.keepConnected}
          onValueChange={(keepConnected) => {
            set({ keepConnected });
            if (keepConnected) offerBatteryExemption();
          }}
        />
      </SettingsSection>
      {listedProjects.length > 0 ? (
        <SettingsSection title="Projects">
          {listedProjects.map((project) => {
            const key = scopedNotificationKey(project.environmentId, project.id);
            return (
              <SettingsSwitchRow
                key={key}
                icon="folder.fill"
                label={project.title}
                subtitle={labels.get(project.environmentId)}
                disabled={off}
                value={!settings.mutedProjects.includes(key)}
                onValueChange={(on) =>
                  set({ mutedProjects: toggleMutedKey(settings.mutedProjects, key, !on) })
                }
              />
            );
          })}
        </SettingsSection>
      ) : null}
      {mutedThreads.length > 0 ? (
        <SettingsSection title="Muted threads">
          {mutedThreads.map((thread) => (
            <SettingsRow
              key={scopedNotificationKey(thread.environmentId, thread.id)}
              icon="eye.slash"
              label={thread.title}
              value="Unmute"
              onPress={() =>
                set({
                  mutedThreads: toggleMutedKey(
                    settings.mutedThreads,
                    scopedNotificationKey(thread.environmentId, thread.id),
                    false,
                  ),
                })
              }
            />
          ))}
        </SettingsSection>
      ) : null}
      <SettingsSection
        title="Sound and priority"
        footer="Needs you, Finished and Errors are separate Android categories, each with its own sound and priority."
      >
        <SettingsRow
          icon="slider.horizontal.3"
          label="Notification categories"
          onPress={() => native?.threadOpenSettings(null)}
        />
        <SettingsRow
          icon="bell.badge"
          label="Send a test notification"
          disabled={permission === "blocked"}
          onPress={postTestThreadNotification}
        />
      </SettingsSection>
    </>
  );
}
