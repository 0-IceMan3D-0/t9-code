import { useSyncExternalStore } from "react";

import {
  DEFAULT_THREAD_NOTIFICATION_SETTINGS,
  type ThreadNotificationSettings,
} from "./threadNotificationModel";
import { threadNotificationsNative } from "./threadNotificationNative";

const STORE_KEY = "settings";

function strings(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function parseThreadNotificationSettings(raw: string | null): ThreadNotificationSettings {
  if (raw === null) return DEFAULT_THREAD_NOTIFICATION_SETTINGS;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_THREAD_NOTIFICATION_SETTINGS;
    parsed = value as Record<string, unknown>;
  } catch {
    return DEFAULT_THREAD_NOTIFICATION_SETTINGS;
  }
  const flag = (key: keyof ThreadNotificationSettings) =>
    typeof parsed[key] === "boolean"
      ? (parsed[key] as boolean)
      : (DEFAULT_THREAD_NOTIFICATION_SETTINGS[key] as boolean);
  return {
    enabled: flag("enabled"),
    approval: flag("approval"),
    input: flag("input"),
    finished: flag("finished"),
    failed: flag("failed"),
    keepConnected: flag("keepConnected"),
    permissionAsked: flag("permissionAsked"),
    mutedProjects: strings(parsed.mutedProjects),
    mutedThreads: strings(parsed.mutedThreads),
  };
}

let snapshot = parseThreadNotificationSettings(
  threadNotificationsNative?.threadReadStore(STORE_KEY) ?? null,
);
const listeners = new Set<() => void>();

export function getThreadNotificationSettings(): ThreadNotificationSettings {
  return snapshot;
}

export function updateThreadNotificationSettings(
  update: (current: ThreadNotificationSettings) => Partial<ThreadNotificationSettings>,
): void {
  snapshot = { ...snapshot, ...update(snapshot) };
  threadNotificationsNative?.threadWriteStore(STORE_KEY, JSON.stringify(snapshot));
  for (const listener of listeners) listener();
}

export function subscribeThreadNotificationSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThreadNotificationSettings(): ThreadNotificationSettings {
  return useSyncExternalStore(subscribeThreadNotificationSettings, getThreadNotificationSettings);
}

export function toggleMutedKey(list: ReadonlyArray<string>, key: string, muted: boolean) {
  const without = list.filter((entry) => entry !== key);
  return muted ? [...without, key] : without;
}
