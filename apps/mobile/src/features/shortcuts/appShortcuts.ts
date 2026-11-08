import type { Action } from "expo-quick-actions";
import type { NavigationState } from "@react-navigation/native";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

import type { RecentThreadShortcut } from "../../persistence/imperative";
import type { LocalServerStatus } from "../local-server/localServerModule";

const MAX_RECENT_THREAD_SHORTCUTS = 3;

const NEW_TASK_SHORTCUT_ID = "new-task";
const NEW_TASK_SHORTCUT_HREF = "/new";
const THIS_PHONE_HREF = "/settings/this-phone";
const LINUX_SHELL_HREF = "/settings/this-phone/shell";

/** The built-in server's shortcut: set up Linux, or start or stop the server. */
export type ServerShortcut = "setup" | "start" | "stop" | null;

export function serverShortcut(status: LocalServerStatus | null): ServerShortcut {
  if (status === null) return null;
  if (status.state === "notInstalled") return "setup";
  return status.state === "stopped" || status.state === "failed" ? "start" : "stop";
}

/** Must match ServerShortcut.ID in the local server module, which relabels it natively. */
const SERVER_SHORTCUT_ID = "server";

const SHORTCUT_ICON = "shortcut_icon";

const THREAD_SHORTCUT_HREF_PATTERN = /^\/threads\/[^/?#]+\/[^/?#]+$/;

function threadShortcutHref(thread: RecentThreadShortcut): string {
  return `/threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`;
}

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

/** Never throw: malformed deep-link or restored ids can fail schema constructors during root-stack render. */
export function activeThreadRef(state: NavigationState): ScopedThreadRef | null {
  const route = state.routes[state.index];
  if (route?.name !== "Thread") {
    return null;
  }

  try {
    const params = route.params as
      | {
          readonly environmentId?: string | string[];
          readonly threadId?: string | string[];
        }
      | undefined;
    const environmentId = firstRouteParam(params?.environmentId)?.trim();
    const threadId = firstRouteParam(params?.threadId)?.trim();
    if (!environmentId || !threadId) {
      return null;
    }

    return {
      environmentId: EnvironmentId.make(environmentId),
      threadId: ThreadId.make(threadId),
    };
  } catch {
    return null;
  }
}

function threadShortcutLabel(thread: RecentThreadShortcut): string {
  const title = thread.title.trim();
  return title.length > 0 ? title : "Thread";
}

/** Launcher shortcuts survive updates; allowlist destinations so malformed or stale paths cannot navigate. */
export function shortcutHref(action: Action): string | null {
  const href = action.params?.href;
  if (typeof href !== "string") {
    return null;
  }

  return href === NEW_TASK_SHORTCUT_HREF ||
    href === THIS_PHONE_HREF ||
    href === LINUX_SHELL_HREF ||
    THREAD_SHORTCUT_HREF_PATTERN.test(href)
    ? href
    : null;
}

export function withRecentThreadShortcut(
  current: ReadonlyArray<RecentThreadShortcut>,
  opened: RecentThreadShortcut,
): ReadonlyArray<RecentThreadShortcut> {
  const existing = current.find(
    (thread) =>
      thread.environmentId === opened.environmentId && thread.threadId === opened.threadId,
  );
  const title = opened.title.trim().length > 0 ? opened.title : (existing?.title ?? opened.title);
  if (current[0] === existing && existing !== undefined && existing.title === title) {
    return current;
  }

  return [
    { environmentId: opened.environmentId, threadId: opened.threadId, title },
    ...current.filter((thread) => thread !== existing),
  ].slice(0, MAX_RECENT_THREAD_SHORTCUTS);
}

function serverActions(server: ServerShortcut): Action[] {
  if (server === null) return [];
  if (server === "setup") {
    return [
      {
        id: SERVER_SHORTCUT_ID,
        title: "Set up this phone",
        icon: SHORTCUT_ICON,
        params: { href: THIS_PHONE_HREF },
      },
    ];
  }
  return [
    {
      id: SERVER_SHORTCUT_ID,
      title: server === "stop" ? "Stop server" : "Start server",
      icon: SHORTCUT_ICON,
      // Starts or stops the server without opening the app, so it is not a deep link.
      params: { serverSwitch: server },
    },
    {
      id: "linux-shell",
      title: "Linux shell",
      icon: SHORTCUT_ICON,
      params: { href: LINUX_SHELL_HREF },
    },
  ];
}

/** Launchers show the first four or so; recent threads come after the fixed entries. */
export function buildShortcutActions(
  recents: ReadonlyArray<RecentThreadShortcut>,
  server: ServerShortcut = null,
): Action[] {
  return [
    {
      id: NEW_TASK_SHORTCUT_ID,
      title: "New thread",
      icon: SHORTCUT_ICON,
      params: { href: NEW_TASK_SHORTCUT_HREF },
    },
    ...serverActions(server),
    ...recents.slice(0, MAX_RECENT_THREAD_SHORTCUTS).map((thread): Action => ({
      // URI-encoded hrefs avoid env/thread id collisions that plain hyphen joins allow.
      id: `thread:${threadShortcutHref(thread)}`,
      title: threadShortcutLabel(thread),
      icon: SHORTCUT_ICON,
      params: { href: threadShortcutHref(thread) },
    })),
  ];
}
