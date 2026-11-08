import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Option from "effect/Option";
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import { subscribeLocalServerStatus } from "../../features/local-server/localServerModule";
import {
  buildHomeThreadsPayload,
  homeThreadsSignature,
  homeWidgetThreadRow,
  seedHomeThreadRows,
  type WidgetThreadRow,
} from "./homeWidgetsModel";
import { createHomeWidgetPublisher, watchingInBackground } from "./homeWidgetPublisher";
import { homeWidgetsNative as native } from "./homeWidgetsNative";
import { installUsageTodayWidget } from "./usageTodayWidget";

interface EnvironmentRows {
  rows: ReadonlyArray<WidgetThreadRow>;
  live: boolean;
  /** When this environment was last connected, for the "Updated … ago" stamp. */
  liveAt: number;
}

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code";
}

function snapshotRows(
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshot,
  environmentLabel: string | null,
): WidgetThreadRow[] {
  const projects = new Map(snapshot.projects.map((project) => [project.id, project.title]));
  const subagentRequests = appAtomRegistry.get(
    environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
  );
  const delegatedUnderParent = appAtomRegistry.get(
    environmentThreadShells.delegatedUnderParentAtom,
  );
  const hidden = appAtomRegistry.get(environmentThreadShells.hiddenThreadKeysAtom);
  const rows: WidgetThreadRow[] = [];
  for (const raw of snapshot.threads) {
    const ref = { environmentId, threadId: raw.id };
    if (isShownUnderParent(ref, raw.lineage, delegatedUnderParent) || hidden.has(threadKey(ref)))
      continue;
    const thread = presentThreadShell(environmentId, raw, subagentRequests.get(raw.id) ?? null);
    const row = homeWidgetThreadRow(thread, {
      projectTitle: projects.get(thread.projectId) ?? null,
      environmentLabel,
    });
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** Feeds the Android home screen widgets from the same shell streams the notifications watch. */
export function installHomeWidgets(): () => void {
  if (native === null) return () => {};
  native.configure(appScheme());
  const environments = new Map<string, EnvironmentRows>();
  for (const [environmentId, seeded] of seedHomeThreadRows(native.read("threads"))) {
    environments.set(environmentId, { rows: seeded.rows, live: false, liveAt: seeded.asOf });
  }
  let leftAt = AppState.currentState === "active" ? null : Date.now();

  const threads = createHomeWidgetPublisher("threads", ["working", "recent"], () => {
    const now = Date.now();
    let live = true;
    let asOf = now;
    const rows: WidgetThreadRow[] = [];
    for (const entry of environments.values()) {
      rows.push(...entry.rows);
      // An environment with nothing to show cannot make the widget wrong.
      if (!entry.live && entry.rows.length > 0) {
        live = false;
        asOf = Math.min(asOf, entry.liveAt);
      }
    }
    if (leftAt !== null && !watchingInBackground()) {
      live = false;
      asOf = Math.min(asOf, leftAt);
    }
    const payload = buildHomeThreadsPayload({ rows, live, asOf });
    return { payload, signature: homeThreadsSignature(payload) };
  });

  const multipleEnvironments = () =>
    appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.size > 1;
  const environmentLabel = (environmentId: EnvironmentId) =>
    multipleEnvironments()
      ? (appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId)?.target
          .label ?? null)
      : null;

  const watched = new Map<EnvironmentId, () => void>();
  const watch = (environmentId: EnvironmentId) => {
    let snapshot: OrchestrationV2ShellSnapshot | null = null;
    const update = () => {
      const previous = environments.get(environmentId);
      if (snapshot === null) {
        if (previous?.live)
          environments.set(environmentId, { ...previous, live: false, liveAt: Date.now() });
      } else {
        environments.set(environmentId, {
          rows: snapshotRows(environmentId, snapshot, environmentLabel(environmentId)),
          live: true,
          liveAt: Date.now(),
        });
      }
      threads.request();
    };
    const unsubscribeShell = appAtomRegistry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        snapshot =
          shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value : null;
        update();
      },
      { immediate: true },
    );
    const unsubscribeRequests = appAtomRegistry.subscribe(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
      () => {
        if (snapshot !== null) update();
      },
    );
    return () => {
      unsubscribeShell();
      unsubscribeRequests();
    };
  };

  const unsubscribeCatalog = appAtomRegistry.subscribe(
    environmentCatalog.catalogValueAtom,
    (catalog) => {
      for (const [environmentId, stop] of watched) {
        if (catalog.entries.has(environmentId)) continue;
        stop();
        watched.delete(environmentId);
      }
      for (const environmentId of environments.keys()) {
        if (!catalog.entries.has(environmentId as EnvironmentId))
          environments.delete(environmentId);
      }
      for (const environmentId of catalog.entries.keys()) {
        if (!watched.has(environmentId)) watched.set(environmentId, watch(environmentId));
      }
      threads.request();
    },
    { immediate: true },
  );

  const usage = installUsageTodayWidget();

  const appState = AppState.addEventListener("change", (state) => {
    leftAt = state === "active" ? null : (leftAt ?? Date.now());
    threads.request();
    usage.request();
  });
  const unsubscribeLocal = subscribeLocalServerStatus(() => threads.request());
  const placed = native.addListener("onPlacedChanged", () => {
    threads.request();
    usage.request();
  });

  return () => {
    unsubscribeCatalog();
    for (const stop of watched.values()) stop();
    watched.clear();
    appState.remove();
    unsubscribeLocal();
    placed.remove();
    threads.dispose();
    usage.dispose();
  };
}
