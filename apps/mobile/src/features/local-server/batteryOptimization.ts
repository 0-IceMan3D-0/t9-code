import { useSyncExternalStore } from "react";
import { Linking, Platform } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { subscribeAppActive } from "../../lib/appState";
import { BATTERY_REASON, shouldOfferBatteryHint } from "./batteryGuidance";
import { localServer, type BatteryState } from "./localServerModule";

function readState(): BatteryState | null {
  return Platform.OS === "android" ? (localServer?.getBatteryState() ?? null) : null;
}

let snapshot = readState();
const listeners = new Set<() => void>();

export function refreshBatteryState(): void {
  const next = readState();
  if (next?.optimized === snapshot?.optimized && next?.hintDismissed === snapshot?.hintDismissed) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Android's prompt and settings screens return through the app becoming active again.
  const active = subscribeAppActive(refreshBatteryState);
  return () => {
    listeners.delete(onChange);
    active();
  };
}

export function useBatteryState(): BatteryState | null {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function openBatterySettings(): void {
  const opened = localServer?.openBatterySettings() ?? "none";
  if (opened === "none") {
    Dialog.alert(
      "Couldn't open battery settings",
      "Open Android Settings, then Battery, and allow T3² code to run in the background.",
    );
  }
}

export function openVendorGuide(url: string): void {
  void Linking.openURL(url);
}

function dismissHint(): void {
  localServer?.dismissBatteryHint();
  refreshBatteryState();
}

/** Asks once, when background work starts while Android may still stop it. Never again after. */
export function offerBatteryExemption(): void {
  refreshBatteryState();
  if (!shouldOfferBatteryHint(snapshot)) return;
  Dialog.alert(
    "Keep agents running in the background?",
    `${BATTERY_REASON} Allow T3² code to ignore battery optimisation so the built-in server and notifications keep working while the app is closed. You can change this later in Settings > This phone.`,
    [
      { text: "Not now", style: "cancel", onPress: dismissHint },
      {
        text: "Allow",
        onPress: () => {
          dismissHint();
          openBatterySettings();
        },
      },
    ],
  );
}
