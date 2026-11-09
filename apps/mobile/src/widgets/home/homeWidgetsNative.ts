import { requireOptionalNativeModule, type EventSubscription } from "expo";
import { Platform } from "react-native";

export type HomeWidgetKind =
  | "working"
  | "recent"
  | "server"
  | "actions"
  | "usage"
  | "prompt"
  | "gauges"
  | "status";
export type HomeWidgetDataKey = "threads" | "usage";

interface HomeWidgetsNativeModule {
  configure(scheme: string): void;
  placed(): ReadonlyArray<HomeWidgetKind>;
  /** JSON, because expo record-list arguments crash this app's module at startup. */
  publish(key: HomeWidgetDataKey, json: string): void;
  read(key: HomeWidgetDataKey): string | null;
  addListener(event: "onPlacedChanged", listener: () => void): EventSubscription;
}

/** Null on iOS and on builds without the Android home screen widgets. */
export const homeWidgetsNative =
  Platform.OS === "android"
    ? requireOptionalNativeModule<HomeWidgetsNativeModule>("T3HomeWidgets")
    : null;
