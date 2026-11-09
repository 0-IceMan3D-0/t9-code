import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { buildSubscriptionUsageSnapshot } from "../subscriptionUsageSnapshot";
import { buildHomeLimitsPayload } from "./homeWidgetsModel";
import { createHomeWidgetPublisher, type HomeWidgetPublisher } from "./homeWidgetPublisher";

const PATH = "/settings/usage?tab=limits";

/** Feeds the Limits widget from the providers' usage limits, which the app already refreshes. */
export function installLimitsWidget(): HomeWidgetPublisher {
  const publisher = createHomeWidgetPublisher("limits", ["limits"], () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      appAtomRegistry.get(environmentPresentations.presentationsWithProvidersAtom),
      PATH,
      Infinity,
    );
    const payload = buildHomeLimitsPayload(snapshot, PATH);
    return { payload, signature: JSON.stringify(payload) };
  });
  const unsubscribe = appAtomRegistry.subscribe(
    environmentPresentations.presentationsWithProvidersAtom,
    () => publisher.request(),
  );
  publisher.request();
  return {
    request: publisher.request,
    dispose: () => {
      unsubscribe();
      publisher.dispose();
    },
  };
}
