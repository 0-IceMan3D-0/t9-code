import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type {
  PendingThreadRequests,
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Option from "effect/Option";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AppState, Platform } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { readEnvironmentScope } from "../../state/session";
import { environmentShell } from "../../state/shell";
import {
  environmentThreadDetails,
  environmentThreads,
  environmentThreadShells,
} from "../../state/threads";
import {
  getLocalServerStatus,
  subscribeLocalServerStatus,
} from "../local-server/localServerModule";
import {
  buildThreadNotificationContent,
  decideThreadNotification,
  latestAssistantReply,
  isThreadNotificationSuppressed,
  threadNotificationEvent,
  threadNotificationTag,
  type ThreadNotificationContent,
  type ThreadNotificationEvent,
  type ThreadNotificationRecord,
} from "./threadNotificationModel";
import { threadNotificationsNative as native } from "./threadNotificationNative";
import {
  getThreadNotificationSettings,
  subscribeThreadNotificationSettings,
  updateThreadNotificationSettings,
} from "./threadNotificationSettings";

interface EnvironmentRecords {
  syncedAt: number | null;
  threads: Record<string, ThreadNotificationRecord>;
}

interface Enrichment {
  readonly key: string;
  readonly stop: () => void;
}

const TIMER_WINDOW_MS = 90_000;
const RETRY_FIRST_MS = 10_000;
const RETRY_MAX_MS = 120_000;

let deepLinkOnScreen: string | null = null;
/** Decoded, since router paths keep characters such as ":" that the card's link encodes. */
let threadOnScreen: string | null = null;
const records = new Map<EnvironmentId, EnvironmentRecords>();
const enrichments = new Map<string, Enrichment>();
interface LoadedDetails {
  readonly approval: ThreadPendingApproval | null;
  readonly userInput: ThreadPendingUserInput | null;
  readonly reply: string | null;
}

/** Loaded thread details per card, reused when a shown card refreshes. */
const details = new Map<string, LoadedDetails & { readonly key: string }>();
const postedSignatures = new Map<string, string>();
const nonLiveEnvironments = new Set<EnvironmentId>();
const liveListeners = new Set<() => void>();
/** Environments that dropped while the app was away; never-reached ones are left alone. */
const droppedEnvironments = new Set<EnvironmentId>();
let retryDelayMs = RETRY_FIRST_MS;

function recordsFor(environmentId: EnvironmentId): EnvironmentRecords {
  let entry = records.get(environmentId);
  if (entry === undefined) {
    const raw = native?.threadReadStore(`records:${environmentId}`) ?? null;
    try {
      const parsed = raw === null ? null : (JSON.parse(raw) as EnvironmentRecords);
      entry =
        parsed !== null && typeof parsed.threads === "object" && parsed.threads !== null
          ? parsed
          : { syncedAt: null, threads: {} };
    } catch {
      entry = { syncedAt: null, threads: {} };
    }
    records.set(environmentId, entry);
  }
  return entry;
}

function saveRecords(environmentId: EnvironmentId): void {
  native?.threadWriteStore(`records:${environmentId}`, JSON.stringify(recordsFor(environmentId)));
}

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code";
}

function onScreen(environmentId: EnvironmentId, threadId: ThreadId): boolean {
  return (
    AppState.currentState === "active" &&
    threadOnScreen === threadNotificationTag(environmentId, threadId)
  );
}

function environmentLabel(environmentId: EnvironmentId): string {
  return (
    appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId)?.target
      .label ?? "T3 server"
  );
}

/** A silent refresh only reaches the card when its content changed; native skips dismissed cards. */
function post(content: ThreadNotificationContent): void {
  const signature = JSON.stringify({ ...content, alert: false, when: 0 });
  if (!content.alert && postedSignatures.get(content.tag) === signature) return;
  postedSignatures.set(content.tag, signature);
  native?.threadPost(JSON.stringify(content));
}

function forget(tag: string): void {
  stopEnrichment(tag);
  details.delete(tag);
  postedSignatures.delete(tag);
}

/** The built-in server or "stay connected" keeps the process alive in the background. */
function backgroundWatchActive(): boolean {
  const state = getLocalServerStatus()?.state;
  return state === "running" || state === "starting" || native?.threadIsWatching() === true;
}

function openTimerWindowIfBackground(): void {
  if (AppState.currentState !== "active" && backgroundWatchActive()) {
    native?.threadOpenTimerWindow(TIMER_WINDOW_MS);
  }
}

/**
 * Retries dropped connections on a native delay: with the screen off React Native's timers
 * stop, so the connection's own backoff never fires.
 */
function scheduleRetryWake(): void {
  const due =
    droppedEnvironments.size > 0 && AppState.currentState !== "active" && backgroundWatchActive();
  native?.threadScheduleWake(due ? retryDelayMs : -1);
}

function retryDroppedEnvironments(): void {
  if (AppState.currentState === "active" || !backgroundWatchActive()) return;
  for (const environmentId of droppedEnvironments) {
    void runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, environmentId);
  }
  retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  scheduleRetryWake();
}

/**
 * The headless timer window ends once every watched environment is live again, so timers
 * pause as soon as reconnecting no longer needs them.
 */
export function waitForWatchedEnvironmentsLive(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (nonLiveEnvironments.size > 0) return;
      liveListeners.delete(check);
      native?.threadTimerWindowClosed();
      resolve();
    };
    liveListeners.add(check);
    check();
  });
}

function stopEnrichment(tag: string): void {
  enrichments.get(tag)?.stop();
  enrichments.delete(tag);
}

/**
 * Loads the thread once to name the tool or question, to offer the server's own approval
 * options, or to preview the agent's reply (shell rows carry no message text), then refreshes
 * the card silently. The first card goes out without waiting.
 */
function enrich(
  isCurrent: () => boolean,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  event: ThreadNotificationEvent,
  apply: (loaded: LoadedDetails) => ThreadNotificationContent,
): void {
  const tag = threadNotificationTag(environmentId, threadId);
  if (enrichments.get(tag)?.key === event.key) return;
  stopEnrichment(tag);
  const ref = { environmentId, threadId };
  const release = appAtomRegistry.mount(environmentThreads.stateAtom(environmentId, threadId));
  let done = false;
  const finish = (loaded: LoadedDetails) => {
    done = true;
    queueMicrotask(() => stopEnrichment(tag));
    if (isCurrent()) post(apply(loaded));
  };
  const unsubscribe =
    event.requestId === null
      ? appAtomRegistry.subscribe(
          environmentThreadDetails.stateAtom(ref),
          (state) => {
            const projection = Option.getOrNull(state.data);
            if (done || projection === null || state.status !== "live") return;
            finish({
              approval: null,
              userInput: null,
              reply: latestAssistantReply(projection.messages),
            });
          },
          { immediate: true },
        )
      : appAtomRegistry.subscribe(
          environmentThreadDetails.pendingRequestsAtom(ref),
          (requests: PendingThreadRequests | null) => {
            if (done || requests === null) return;
            const approval = requests.approvals.find(
              (entry) => entry.requestId === event.requestId,
            );
            const userInput = requests.userInputs.find(
              (entry) => entry.requestId === event.requestId,
            );
            if (approval === undefined && userInput === undefined) return;
            finish({ approval: approval ?? null, userInput: userInput ?? null, reply: null });
          },
          { immediate: true },
        );
  enrichments.set(tag, {
    key: event.key,
    stop: () => {
      unsubscribe();
      release();
    },
  });
}

function observe(environmentId: EnvironmentId, snapshot: OrchestrationV2ShellSnapshot): void {
  const settings = getThreadNotificationSettings();
  const entry = recordsFor(environmentId);
  const now = Date.now();
  const projects = new Map(snapshot.projects.map((project) => [project.id, project.title]));
  const subagentRequests = appAtomRegistry.get(
    environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
  );
  const delegatedUnderParent = appAtomRegistry.get(
    environmentThreadShells.delegatedUnderParentAtom,
  );
  const hidden = appAtomRegistry.get(environmentThreadShells.hiddenThreadKeysAtom);
  const canOperate = readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const label = environmentLabel(environmentId);
  const present = new Set<string>();
  const previousSync = entry.syncedAt;
  let changed = previousSync === null;

  for (const raw of snapshot.threads) {
    if (
      isShownUnderParent({ environmentId, threadId: raw.id }, raw.lineage, delegatedUnderParent) ||
      hidden.has(threadKey({ environmentId, threadId: raw.id }))
    ) {
      continue;
    }
    present.add(raw.id);
    const thread = presentThreadShell(environmentId, raw, subagentRequests.get(raw.id) ?? null);
    const event = threadNotificationEvent(thread);
    const record = entry.threads[raw.id];
    const decision = decideThreadNotification({
      event,
      record,
      syncedAt: previousSync,
      archived: thread.archivedAt !== null || thread.deletedAt !== null,
      visitedAt: thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : null,
      suppressed:
        event === null ||
        isThreadNotificationSuppressed({
          kind: event.kind,
          settings,
          environmentId,
          projectId: thread.projectId,
          threadId: thread.id,
          onScreen: onScreen(environmentId, thread.id),
        }),
    });
    const tag = threadNotificationTag(environmentId, thread.id);
    if (decision.clear) {
      forget(tag);
      native?.threadCancel(tag, true);
    }
    // The shell can name the reply or a new title a moment after the status changes.
    const showing = event !== null && decision.record.shown === event.key;
    if (event !== null && showing) {
      const loaded = details.get(tag)?.key === event.key ? details.get(tag) : undefined;
      const build = (loaded: LoadedDetails | undefined, alert: boolean) =>
        buildThreadNotificationContent({
          thread,
          event,
          projectTitle: projects.get(thread.projectId) ?? null,
          environmentLabel: label,
          canOperate,
          approval: loaded?.approval ?? null,
          userInput: loaded?.userInput ?? null,
          reply: loaded?.reply ?? null,
          alert,
          now,
        });
      post(build(loaded, decision.notify));
      if (decision.notify) {
        enrich(
          () => recordsFor(environmentId).threads[thread.id]?.shown === event.key,
          environmentId,
          thread.id,
          event,
          (next) => {
            details.set(tag, { key: event.key, ...next });
            return build(next, false);
          },
        );
      }
    }
    if (record?.key !== decision.record.key || record?.shown !== decision.record.shown) {
      entry.threads[raw.id] = decision.record;
      changed = true;
    }
  }
  for (const [threadId, record] of Object.entries(entry.threads)) {
    if (present.has(threadId)) continue;
    if (record.shown !== null)
      native?.threadCancel(threadNotificationTag(environmentId, threadId), true);
    delete entry.threads[threadId];
    changed = true;
  }
  entry.syncedAt = now;
  // Saving every sync time would write on each shell push; it only needs to be roughly current.
  if (changed || now - (previousSync ?? 0) > 60_000) saveRecords(environmentId);
  maybeAskPermission();
}

/** Clears a thread's card when it opens on this device. */
export function setThreadNotificationScreen(deepLink: string | null): void {
  deepLinkOnScreen = deepLink;
  threadOnScreen = null;
  const match = deepLink === null ? null : /^\/threads\/([^/]+)\/([^/]+)$/.exec(deepLink);
  if (!match?.[1] || !match[2]) return;
  const environmentId = decodeURIComponent(match[1]) as EnvironmentId;
  const threadId = decodeURIComponent(match[2]);
  threadOnScreen = threadNotificationTag(environmentId, threadId);
  const entry = recordsFor(environmentId);
  const record = entry.threads[threadId];
  forget(threadNotificationTag(environmentId, threadId));
  native?.threadCancel(threadNotificationTag(environmentId, threadId), false);
  if (record?.shown != null) {
    entry.threads[threadId] = { ...record, shown: null };
    saveRecords(environmentId);
  }
}

let askingPermission = false;

function maybeAskPermission(): void {
  const settings = getThreadNotificationSettings();
  if (
    askingPermission ||
    settings.permissionAsked ||
    !settings.enabled ||
    AppState.currentState !== "active" ||
    Platform.OS !== "android" ||
    Number(Platform.Version) < 33 ||
    native?.threadPermissionState().enabled !== false
  ) {
    return;
  }
  askingPermission = true;
  updateThreadNotificationSettings(() => ({ permissionAsked: true }));
  Dialog.alert(
    "Get notified about your agents",
    "T3² code can tell you when an agent finishes, fails, needs an approval or asks a question, and let you answer from the notification. This works without an account. You can change it in Settings → Notifications.",
    [
      { text: "Not now", style: "cancel", onPress: () => (askingPermission = false) },
      {
        text: "Allow",
        onPress: () => {
          askingPermission = false;
          void Notifications.requestPermissionsAsync().catch(() => undefined);
        },
      },
    ],
  );
}

/** Cancels cards that settings now mute, so turning something off takes effect at once. */
function applySettings(): void {
  const settings = getThreadNotificationSettings();
  if (!settings.enabled) {
    native?.threadCancelAll();
    for (const [environmentId, entry] of records) {
      for (const [threadId, record] of Object.entries(entry.threads)) {
        entry.threads[threadId] = { ...record, shown: null };
      }
      saveRecords(environmentId);
    }
  }
  for (const environmentId of records.keys()) {
    const shell = appAtomRegistry.get(environmentShell.stateValueAtom(environmentId));
    if (shell.status === "live" && Option.isSome(shell.snapshot)) {
      observe(environmentId, shell.snapshot.value);
    }
  }
  syncWatchService();
}

function syncWatchService(): void {
  const settings = getThreadNotificationSettings();
  const local = getLocalServerStatus()?.state;
  // The built-in server's own foreground service already keeps the process alive.
  const want =
    settings.enabled &&
    settings.keepConnected &&
    local !== "running" &&
    local !== "starting" &&
    local !== "installing";
  if (native !== null && native.threadIsWatching() !== want) native.threadSetWatching(want);
}

/** Watches every saved environment's thread shells and turns their events into notifications. */
export function installThreadNotifications(): () => void {
  if (native === null) return () => {};
  native.threadConfigure(appScheme());
  const watched = new Map<EnvironmentId, () => void>();

  const watch = (environmentId: EnvironmentId) => {
    let snapshot: OrchestrationV2ShellSnapshot | null = null;
    const reobserve = () => {
      if (snapshot !== null) observe(environmentId, snapshot);
    };
    const unsubscribeShell = appAtomRegistry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        if (shell.status === "live" && Option.isSome(shell.snapshot)) {
          snapshot = shell.snapshot.value;
          nonLiveEnvironments.delete(environmentId);
          droppedEnvironments.delete(environmentId);
          for (const listener of liveListeners) listener();
          observe(environmentId, snapshot);
          return;
        }
        if (snapshot !== null && AppState.currentState !== "active") {
          droppedEnvironments.add(environmentId);
          retryDelayMs = RETRY_FIRST_MS;
          scheduleRetryWake();
        }
        snapshot = null;
        if (!nonLiveEnvironments.has(environmentId)) {
          nonLiveEnvironments.add(environmentId);
          openTimerWindowIfBackground();
        }
      },
      { immediate: true },
    );
    const unsubscribeRequests = appAtomRegistry.subscribe(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
      reobserve,
    );
    return () => {
      unsubscribeShell();
      unsubscribeRequests();
      nonLiveEnvironments.delete(environmentId);
      droppedEnvironments.delete(environmentId);
    };
  };

  const syncEnvironments = () => {
    const ids = new Set(appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.keys());
    for (const [environmentId, stop] of watched) {
      if (ids.has(environmentId)) continue;
      stop();
      watched.delete(environmentId);
      for (const threadId of Object.keys(recordsFor(environmentId).threads)) {
        native?.threadCancel(threadNotificationTag(environmentId, threadId), false);
      }
      records.delete(environmentId);
      native?.threadWriteStore(`records:${environmentId}`, null);
    }
    for (const environmentId of ids) {
      if (!watched.has(environmentId)) watched.set(environmentId, watch(environmentId));
    }
  };

  const unsubscribeCatalog = appAtomRegistry.subscribe(
    environmentCatalog.catalogValueAtom,
    syncEnvironments,
    { immediate: true },
  );
  const unsubscribeSettings = subscribeThreadNotificationSettings(applySettings);
  const unsubscribeLocal = subscribeLocalServerStatus(syncWatchService);
  const watchStopped = native.addListener("onThreadWatchStopped", () =>
    updateThreadNotificationSettings(() => ({ keepConnected: false })),
  );
  const wake = native.addListener("onThreadWake", retryDroppedEnvironments);
  const appState = AppState.addEventListener("change", (state) => {
    if (state !== "active") return;
    droppedEnvironments.clear();
    native?.threadScheduleWake(-1);
    setThreadNotificationScreen(deepLinkOnScreen);
    syncWatchService();
    maybeAskPermission();
  });
  syncWatchService();

  return () => {
    unsubscribeCatalog();
    unsubscribeSettings();
    unsubscribeLocal();
    watchStopped.remove();
    wake.remove();
    native?.threadScheduleWake(-1);
    appState.remove();
    for (const stop of watched.values()) stop();
    watched.clear();
    for (const tag of enrichments.keys()) stopEnrichment(tag);
  };
}

export function postTestThreadNotification(): void {
  post({
    tag: threadNotificationTag("test", "test"),
    group: "t3-project:test",
    groupTitle: "T3² code",
    channel: "t3-finished",
    title: "Test notification",
    text: "Finished · Agent notifications work on this phone.",
    bigText: "Finished · Agent notifications work on this phone.",
    subText: "T3² code",
    summaryLine: "Test notification",
    when: Date.now(),
    deepLink: "/",
    environmentId: "test",
    threadId: "test",
    alert: true,
    actions: [],
  });
}
