import { requireOptionalNativeModule } from "expo";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

import PRESETS from "../../../modules/t3-app-icon/presets.json";
import { subscribeAppActive } from "../../lib/appState";
import { beginForegroundHandoff, isForegroundHandoffActive } from "../../lib/foreground-handoff";

export interface AppIconState {
  /** The chosen preset; its launcher alias is enabled once the app is in the background. */
  readonly icon: string | null;
  readonly presets: ReadonlyArray<string>;
  readonly pinSupported: boolean;
  readonly customPinned: boolean;
  /** Saved custom picture, as a file URI that changes when the picture does. */
  readonly customImage: string | null;
}

export type PinCustomIconResult = "requested" | "updated" | "unsupported";

/** A launcher shortcut: a deep link, or an explicit activity of this app. */
export interface LauncherShortcut {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly url?: string;
  readonly className?: string;
  readonly action?: string;
}

interface AppIconNativeModule {
  getState(): AppIconState;
  setIcon(id: string): void;
  applyPendingIcon(): void;
  pinCustomIcon(uri: string): Promise<PinCustomIconResult>;
  removeCustomIcon(): Promise<void>;
  setShortcuts(json: string): void;
}

const native = requireOptionalNativeModule<AppIconNativeModule>("T3AppIcon");

// Switching aliases closes the task launched from the old one, so it happens only once the app has
// left the screen. The photo picker and the pin prompt also background the app; they hold a handoff.
if (native) {
  AppState.addEventListener("change", (state) => {
    if (state === "background" && !isForegroundHandoffActive()) native.applyPendingIcon();
  });
}

/**
 * Publishes launcher shortcuts against the enabled icon alias. Android drops shortcuts whose alias
 * is disabled, so the native side moves them to the new alias on every icon switch.
 */
export const setLauncherShortcuts = native
  ? (items: ReadonlyArray<LauncherShortcut>) => native.setShortcuts(JSON.stringify(items))
  : null;

// Metro asset ids.
const PREVIEWS: Record<string, number> = {
  original: require("../../../assets/app-icons/original.png"),
  classic: require("../../../assets/app-icons/classic.png"),
  void: require("../../../assets/app-icons/void.png"),
  frost: require("../../../assets/app-icons/frost.png"),
  terminal: require("../../../assets/app-icons/terminal.png"),
  neon: require("../../../assets/app-icons/neon.png"),
  blueprint: require("../../../assets/app-icons/blueprint.png"),
  pixel: require("../../../assets/app-icons/pixel.png"),
  brutal: require("../../../assets/app-icons/brutal.png"),
};

export const APP_ICON_PRESETS = PRESETS.map((preset) => ({
  ...preset,
  preview: PREVIEWS[preset.id] ?? PREVIEWS.original!,
}));

export function appIconPreview(id: string | null | undefined): number | null {
  return id ? (PREVIEWS[id] ?? null) : null;
}

let snapshot: AppIconState | null = null;
const listeners = new Set<() => void>();
let activeSubscription: (() => void) | null = null;

function read(): AppIconState | null {
  try {
    return native?.getState() ?? null;
  } catch {
    return null;
  }
}

export function refreshAppIconState(): void {
  snapshot = read();
  for (const listener of listeners) listener();
}

// The pin prompt and the launcher run outside the app, so state is re-read on every return.
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  activeSubscription ??= subscribeAppActive(refreshAppIconState);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      activeSubscription?.();
      activeSubscription = null;
    }
  };
}

function getSnapshot(): AppIconState | null {
  snapshot ??= read();
  return snapshot;
}

export function useAppIconState(): AppIconState | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function setAppIcon(id: string): void {
  native?.setIcon(id);
  refreshAppIconState();
}

export async function pinCustomAppIcon(uri: string): Promise<PinCustomIconResult> {
  if (!native) return "unsupported";
  // The launcher's prompt outlives this call; hold the handoff until the app is back on screen.
  const endHandoff = beginForegroundHandoff();
  const result = await native.pinCustomIcon(uri).catch((error: unknown) => {
    endHandoff();
    throw error;
  });
  if (result === "requested") {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      subscription.remove();
      endHandoff();
    });
  } else {
    endHandoff();
  }
  refreshAppIconState();
  return result;
}

export async function removeCustomAppIcon(): Promise<void> {
  await native?.removeCustomIcon();
  refreshAppIconState();
}

/** Opens the photo picker with a square crop; resolves null when the person cancels. */
export async function pickSquarePicture(): Promise<string | null> {
  const endHandoff = beginForegroundHandoff();
  try {
    const picker = await import("expo-image-picker");
    const result = await picker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    });
    return result.canceled ? null : (result.assets[0]?.uri ?? null);
  } finally {
    endHandoff();
  }
}
