import { getLocalServerStatus } from "../../features/local-server/localServerModule";
import { threadNotificationsNative } from "../../features/agent-awareness/threadNotificationNative";
import {
  homeWidgetsNative as native,
  type HomeWidgetDataKey,
  type HomeWidgetKind,
} from "./homeWidgetsNative";

/**
 * Something keeps this process watching while the app is away: the built-in server's service
 * or the notifications' "Stay connected". Otherwise Android may freeze it, so widget data is
 * marked as possibly stale from the moment the app leaves the screen.
 */
export function watchingInBackground(): boolean {
  const state = getLocalServerStatus()?.state;
  return (
    state === "running" ||
    state === "starting" ||
    threadNotificationsNative?.threadIsWatching() === true
  );
}

export interface HomeWidgetPublisher {
  readonly request: () => void;
  readonly dispose: () => void;
}

/**
 * Publishes one data key when it changed, and only while a widget shows it. Changes in one
 * tick are coalesced with a microtask: React Native pauses timers while the app is in the
 * background, so the native side rate-limits the redraws instead.
 */
export function createHomeWidgetPublisher(
  key: HomeWidgetDataKey,
  kinds: ReadonlyArray<HomeWidgetKind>,
  build: () => { readonly payload: unknown; readonly signature: string } | null,
): HomeWidgetPublisher {
  let lastSignature: string | null = null;
  let queued = false;
  let disposed = false;

  const flush = () => {
    queued = false;
    if (native === null || disposed) return;
    if (!native.placed().some((kind) => kinds.includes(kind))) {
      lastSignature = null;
      return;
    }
    const next = build();
    if (next === null || next.signature === lastSignature) return;
    lastSignature = next.signature;
    native.publish(key, JSON.stringify(next.payload));
  };

  return {
    request: () => {
      if (queued) return;
      queued = true;
      queueMicrotask(flush);
    },
    dispose: () => {
      disposed = true;
    },
  };
}
