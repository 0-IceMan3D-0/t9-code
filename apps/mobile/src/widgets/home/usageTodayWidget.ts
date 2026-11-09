import { AppState } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { usageTodayAtom } from "../../features/usage/usageToday";
import {
  aggregateUsage,
  totalTokens,
  usageWindowStart,
} from "../../features/usage/threadTokenUsage";
import { threadUsageEntriesAtom, threadUsageEntriesKey } from "../../state/thread-usage";
import { buildHomeUsagePayload } from "./homeWidgetsModel";
import { homeWidgetsNative as native } from "./homeWidgetsNative";
import {
  createHomeWidgetPublisher,
  watchingInBackground,
  type HomeWidgetPublisher,
} from "./homeWidgetPublisher";

function weekEntriesAtom(now: number) {
  return threadUsageEntriesAtom(threadUsageEntriesKey(usageWindowStart("7d", now), null));
}

/**
 * Feeds the Usage today and Tokens today widgets. Counting reads today's threads, and the last
 * week's for the Tokens today average, so each only subscribes while its widget is placed.
 */
export function installUsageTodayWidget(): HomeWidgetPublisher {
  let leftAt: number | null = null;
  let subscription: {
    readonly atom: ReturnType<typeof usageTodayAtom>;
    readonly stop: () => void;
  } | null = null;
  let weekSubscription: {
    readonly atom: ReturnType<typeof weekEntriesAtom>;
    readonly stop: () => void;
  } | null = null;

  const unsubscribeWeek = () => {
    weekSubscription?.stop();
    weekSubscription = null;
  };
  const unsubscribe = () => {
    subscription?.stop();
    subscription = null;
    unsubscribeWeek();
  };

  const weekTokens = (now: number) => {
    if (native !== null && !native.placed().includes("tokens")) {
      unsubscribeWeek();
      return { tokens: null, loading: false };
    }
    const atom = weekEntriesAtom(now);
    if (weekSubscription?.atom !== atom) {
      unsubscribeWeek();
      weekSubscription = { atom, stop: appAtomRegistry.subscribe(atom, () => publisher.request()) };
    }
    const { entries, pending } = appAtomRegistry.get(atom);
    return {
      tokens: totalTokens(aggregateUsage(entries, usageWindowStart("7d", now)).tokens),
      loading: pending > 0,
    };
  };

  const publisher = createHomeWidgetPublisher("usage", ["usage", "tokens"], () => {
    const now = Date.now();
    const atom = usageTodayAtom(now);
    if (subscription?.atom !== atom) {
      subscription?.stop();
      subscription = { atom, stop: appAtomRegistry.subscribe(atom, () => publisher.request()) };
    }
    const today = appAtomRegistry.get(atom);
    const week = weekTokens(now);
    const away = leftAt !== null && !watchingInBackground();
    const payload = buildHomeUsagePayload({
      ...today,
      loading: today.loading || week.loading,
      weekTokens: week.tokens,
      live: !away,
      asOf: away ? (leftAt ?? now) : now,
    });
    return {
      payload,
      signature: JSON.stringify({ ...payload, asOf: payload.live ? 0 : payload.asOf }),
    };
  });

  const request = () => {
    leftAt = AppState.currentState === "active" ? null : (leftAt ?? Date.now());
    if (native !== null && !native.placed().some((kind) => kind === "usage" || kind === "tokens")) {
      unsubscribe();
      return;
    }
    publisher.request();
  };
  request();

  return {
    request,
    dispose: () => {
      unsubscribe();
      publisher.dispose();
    },
  };
}
