import { requireOptionalNativeModule, type EventSubscription } from "expo";
import { Platform } from "react-native";

export interface ThreadNotificationPermissionState {
  readonly enabled: boolean;
  /** Android channel importance; 0 means the user turned the channel off. */
  readonly needsYou: number;
  readonly finished: number;
  readonly errors: number;
}

interface ThreadNotificationsNativeModule {
  threadConfigure(scheme: string): void;
  threadPost(json: string): void;
  threadCancel(tag: string, keepFeedback: boolean): void;
  threadCancelAll(): void;
  threadShowResult(tag: string, text: string, ok: boolean): void;
  threadReadStore(key: string): string | null;
  threadWriteStore(key: string, value: string | null): void;
  threadOpenTimerWindow(timeoutMs: number): void;
  threadTimerWindowClosed(): void;
  threadScheduleWake(delayMs: number): void;
  threadSetWatching(running: boolean): boolean;
  threadIsWatching(): boolean;
  threadPermissionState(): ThreadNotificationPermissionState;
  threadOpenSettings(channel: string | null): boolean;
  addListener(
    event: "onThreadWatchStopped" | "onThreadWake",
    listener: () => void,
  ): EventSubscription;
}

const module =
  Platform.OS === "android"
    ? requireOptionalNativeModule<ThreadNotificationsNativeModule>("T3AgentNotifications")
    : null;

/** Null on iOS and on app builds whose native module predates on-device thread notifications. */
export const threadNotificationsNative = typeof module?.threadPost === "function" ? module : null;
