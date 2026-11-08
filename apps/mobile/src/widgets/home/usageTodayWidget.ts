import { AppState } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { usageTodayAtom } from "../../features/usage/usageToday";
import { buildHomeUsagePayload } from "./homeWidgetsModel";
import { homeWidgetsNative as native } from "./homeWidgetsNative";
import {
  createHomeWidgetPublisher,
  watchingInBackground,
  type HomeWidgetPublisher,
} from "./homeWidgetPublisher";

/**
 * Feeds the Usage today widget. Counting reads today's threads, so it only subscribes while
 * that widget is on a home screen.
 */
export function installUsageTodayWidget(): HomeWidgetPublisher {
  let leftAt: number | null = null;
  let subscription: {
    readonly atom: ReturnType<typeof usageTodayAtom>;
    readonly stop: () => void;
  } | null = null;

  const unsubscribe = () => {
    subscription?.stop();
    subscription = null;
  };

  const publisher = createHomeWidgetPublisher("usage", ["usage"], () => {
    const atom = usageTodayAtom();
    if (subscription?.atom !== atom) {
      unsubscribe();
      subscription = { atom, stop: appAtomRegistry.subscribe(atom, () => publisher.request()) };
    }
    const today = appAtomRegistry.get(atom);
    const away = leftAt !== null && !watchingInBackground();
    const payload = buildHomeUsagePayload({
      ...today,
      live: !away,
      asOf: away ? (leftAt ?? Date.now()) : Date.now(),
    });
    return {
      payload,
      signature: JSON.stringify({ ...payload, asOf: payload.live ? 0 : payload.asOf }),
    };
  });

  const request = () => {
    leftAt = AppState.currentState === "active" ? null : (leftAt ?? Date.now());
    if (native !== null && !native.placed().includes("usage")) {
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
