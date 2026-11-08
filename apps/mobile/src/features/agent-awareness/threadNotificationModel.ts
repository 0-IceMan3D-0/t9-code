import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import type { ProviderApprovalDecision } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { resolveThreadListV2Status } from "../threads/threadListV2";

export type ThreadNotificationKind = "approval" | "input" | "finished" | "failed";

export interface ThreadNotificationEvent {
  readonly kind: ThreadNotificationKind;
  /** One occurrence: a replay after a reconnect or restart carries the same key. */
  readonly key: string;
  /** When it happened on the server, in ms, if known. */
  readonly at: number | null;
  /** The thread's own pending request; null for a child's request or a finished run. */
  readonly requestId: string | null;
}

function timeOf(value: string | null | undefined): number | null {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

/** What the thread asks of the user right now, or null while it works or rests. */
export function threadNotificationEvent(
  thread: EnvironmentThreadShell,
): ThreadNotificationEvent | null {
  const status = resolveThreadListV2Status(thread);
  const run = thread.latestRun;
  const request = thread.source.pendingRuntimeRequest;
  if (status === "approval" || status === "input") {
    const own = request !== null && thread.pendingSubagentRequest == null;
    const id = own ? request.id : `child:${run?.runId ?? thread.updatedAt}`;
    return {
      kind: status,
      key: `${status}:${id}`,
      at: own ? DateTime.toEpochMillis(request.createdAt) : timeOf(thread.updatedAt),
      requestId: own ? request.id : null,
    };
  }
  if (run === null) return null;
  const failed =
    status === "failed" || status === "limited" || (status === "ready" && run.status === "failed");
  if (failed) {
    return {
      kind: "failed",
      key: `failed:${run.runId}`,
      at: timeOf(run.completedAt) ?? timeOf(thread.runtime?.updatedAt),
      requestId: null,
    };
  }
  // A run the user stopped is not news.
  if (status === "ready" && run.status === "completed" && !thread.source.latestRunStopRequested) {
    return {
      kind: "finished",
      key: `finished:${run.runId}`,
      at: timeOf(run.completedAt),
      requestId: null,
    };
  }
  return null;
}

export interface ThreadNotificationRecord {
  /** The newest event handled, shown or not. */
  readonly key: string | null;
  /** The event the card on screen shows, if one does. */
  readonly shown: string | null;
}

/** Server and phone clocks drift; events this close to the last sync still count as new. */
const CLOCK_SLACK_MS = 60_000;

export interface ThreadNotificationDecision {
  readonly notify: boolean;
  readonly clear: boolean;
  readonly record: ThreadNotificationRecord;
}

/**
 * Decides one thread's notification from its current event and the persisted record, so a
 * reconnect, a replayed snapshot, or an app restart never repeats an event already handled.
 */
export function decideThreadNotification(input: {
  readonly event: ThreadNotificationEvent | null;
  readonly record: ThreadNotificationRecord | undefined;
  /** When this environment was last observed, or null on its first observation ever. */
  readonly syncedAt: number | null;
  readonly archived: boolean;
  /** The server's visited watermark: the user opened the thread somewhere. */
  readonly visitedAt: number | null;
  /** Settings, mutes, or the thread being open on screen. Suppressed events are consumed. */
  readonly suppressed: boolean;
}): ThreadNotificationDecision {
  const { event, record } = input;
  const key = event?.key ?? null;
  const seen =
    event !== null && event.at !== null && input.visitedAt !== null && input.visitedAt >= event.at;
  const fresh =
    event !== null &&
    key !== record?.key &&
    !input.archived &&
    !seen &&
    (record !== undefined ||
      (input.syncedAt !== null &&
        event.at !== null &&
        event.at >= input.syncedAt - CLOCK_SLACK_MS));
  const notify = fresh && !input.suppressed;
  const stale =
    record?.shown != null && (input.archived || seen || key !== record.shown || input.suppressed);
  return {
    notify,
    clear: stale && !notify,
    record: {
      key: key ?? record?.key ?? null,
      shown: notify ? key : stale ? null : (record?.shown ?? null),
    },
  };
}

export interface ThreadNotificationSettings {
  readonly enabled: boolean;
  readonly approval: boolean;
  readonly input: boolean;
  readonly finished: boolean;
  readonly failed: boolean;
  readonly mutedProjects: ReadonlyArray<string>;
  readonly mutedThreads: ReadonlyArray<string>;
  readonly keepConnected: boolean;
  readonly permissionAsked: boolean;
}

export const DEFAULT_THREAD_NOTIFICATION_SETTINGS: ThreadNotificationSettings = {
  enabled: true,
  approval: true,
  input: true,
  finished: true,
  failed: true,
  mutedProjects: [],
  mutedThreads: [],
  keepConnected: false,
  permissionAsked: false,
};

export function scopedNotificationKey(environmentId: string, id: string): string {
  return `${environmentId}\u0000${id}`;
}

export function isThreadNotificationSuppressed(input: {
  readonly kind: ThreadNotificationKind;
  readonly settings: ThreadNotificationSettings;
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string;
  /** The thread is open in the foreground app. */
  readonly onScreen: boolean;
}): boolean {
  const { settings } = input;
  return (
    !settings.enabled ||
    !settings[input.kind] ||
    input.onScreen ||
    settings.mutedProjects.includes(scopedNotificationKey(input.environmentId, input.projectId)) ||
    settings.mutedThreads.includes(scopedNotificationKey(input.environmentId, input.threadId))
  );
}

export type ThreadNotificationChannel = "t3-needs-you" | "t3-finished" | "t3-errors";

export type ThreadNotificationAction =
  | {
      readonly action: "approve";
      readonly label: string;
      readonly progress: string;
      readonly decision: ProviderApprovalDecision;
      readonly requestId: string;
    }
  | {
      readonly action: "answer";
      readonly label: string;
      readonly progress: string;
      readonly requestId: string;
      readonly value: string;
    }
  | {
      readonly action: "reply";
      readonly label: string;
      readonly progress: string;
      readonly placeholder: string;
      /** "answer" answers the pending question; "message" sends a message to the thread. */
      readonly mode: "answer" | "message";
      readonly requestId?: string;
    };

export interface ThreadNotificationContent {
  readonly tag: string;
  readonly group: string;
  readonly groupTitle: string;
  readonly channel: ThreadNotificationChannel;
  readonly title: string;
  readonly text: string;
  readonly bigText: string;
  readonly subText: string;
  readonly summaryLine: string;
  readonly when: number;
  readonly deepLink: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly alert: boolean;
  readonly actions: ReadonlyArray<ThreadNotificationAction>;
}

export function threadNotificationTag(environmentId: string, threadId: string): string {
  return `t3-thread:${environmentId}:${threadId}`;
}

const MAX_TEXT = 240;
const MAX_BIG_TEXT = 1_200;

/** Markdown reduced to readable plain text for a notification line. */
export function plainNotificationText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "\n[code]\n")
    .split("\n")
    .filter((line) => !/^\s*\|/.test(line))
    .map((line) => {
      const block = /^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/.test(line);
      const text = line
        .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
        .trim();
      // Headings and list items read as run-on text once lines are joined.
      return block && text !== "" && !/[.!?:;…]$/.test(text) ? `${text}.` : text;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const REQUEST_KIND_LABELS: Record<string, string> = {
  command: "Run a command",
  "file-change": "Edit files",
  "file-read": "Read files",
  permission: "Permission",
  "mcp-elicitation": "Tool request",
};

const DEFAULT_APPROVAL_DECISIONS: ReadonlyArray<{
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
}> = [
  { decision: "accept", label: "Allow once" },
  { decision: "decline", label: "Deny" },
];

function approvalActions(
  requestId: string,
  approval: ThreadPendingApproval | null,
): ReadonlyArray<ThreadNotificationAction> {
  if (approval !== null && approval.responseCapability !== "live") return [];
  // The server's own options carry "always" and "session" choices; Android shows three buttons.
  const options = approval?.options ?? DEFAULT_APPROVAL_DECISIONS;
  const accepts = options.filter(
    (option) => option.decision !== "decline" && option.decision !== "cancel",
  );
  const decline = options.find((option) => option.decision === "decline");
  const chosen = [...accepts.slice(0, decline ? 2 : 3), ...(decline ? [decline] : [])];
  return chosen.map((option) => ({
    action: "approve" as const,
    label: option.decision === "decline" ? "Deny" : option.label,
    progress: option.decision === "decline" ? "Denying…" : "Approving…",
    decision: option.decision,
    requestId,
  }));
}

function inputActions(
  requestId: string | null,
  userInput: ThreadPendingUserInput | null,
): ReadonlyArray<ThreadNotificationAction> {
  if (requestId === null || userInput?.responseCapability === "not_resumable") return [];
  if (userInput?.responseMode === "message" || userInput?.responseCapability === "message") {
    return [replyAction("message")];
  }
  const question = userInput?.questions.length === 1 ? userInput.questions[0] : undefined;
  if (userInput !== null && question === undefined) return [];
  const options =
    question !== undefined && !question.multiSelect && question.options.length <= 2
      ? question.options.map((option) => ({
          action: "answer" as const,
          label: clip(option.label, 24),
          progress: "Answering…",
          requestId,
          value: option.value ?? option.label,
        }))
      : [];
  const reply = question?.allowCustomAnswer === false ? [] : [replyAction("answer", requestId)];
  return [...options, ...reply].slice(0, 3);
}

/** The newest finished assistant message, for a finished or failed card's preview. */
export function latestAssistantReply(
  messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
  }>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && !message.streaming && message.text.trim() !== "") {
      return message.text;
    }
  }
  return null;
}

function replyAction(mode: "answer" | "message", requestId?: string): ThreadNotificationAction {
  return {
    action: "reply",
    label: "Reply",
    progress: "Sending…",
    placeholder: mode === "answer" ? "Your answer" : "Message the agent",
    mode,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

export function buildThreadNotificationContent(input: {
  readonly thread: EnvironmentThreadShell;
  readonly event: ThreadNotificationEvent;
  readonly projectTitle: string | null;
  readonly environmentLabel: string;
  /** The session may approve and send messages here. */
  readonly canOperate: boolean;
  readonly approval: ThreadPendingApproval | null;
  readonly userInput: ThreadPendingUserInput | null;
  /** The agent's last reply from thread detail; shell rows carry no message text. */
  readonly reply: string | null;
  readonly alert: boolean;
  readonly now: number;
}): ThreadNotificationContent {
  const { thread, event } = input;
  const title = thread.title.trim() || "Untitled thread";
  const message = thread.source.latestVisibleMessage;
  const assistantText = plainNotificationText(
    message !== null && message.role === "assistant" ? message.text : (input.reply ?? ""),
  );
  let status: string;
  let detail: string;
  let channel: ThreadNotificationChannel;
  let actions: ReadonlyArray<ThreadNotificationAction> = [];
  switch (event.kind) {
    case "approval": {
      const approval = input.approval;
      status = "Needs approval";
      const what = approval?.appName ?? REQUEST_KIND_LABELS[approval?.requestKind ?? ""] ?? null;
      detail = [what, approval?.detail ? plainNotificationText(approval.detail) : null]
        .filter((part): part is string => !!part)
        .join(": ");
      channel = "t3-needs-you";
      if (event.requestId !== null) actions = approvalActions(event.requestId, approval);
      break;
    }
    case "input": {
      status = "Has a question";
      const questions = input.userInput?.questions ?? [];
      detail = questions.map((question) => plainNotificationText(question.question)).join(" ");
      channel = "t3-needs-you";
      actions = inputActions(event.requestId, input.userInput);
      break;
    }
    case "failed": {
      const limited = thread.runtime?.lastErrorClass === "usage_limit";
      status = limited ? "Hit a usage limit" : "Failed";
      detail = plainNotificationText(thread.runtime?.lastError ?? "") || assistantText;
      channel = "t3-errors";
      actions = [replyAction("message")];
      break;
    }
    case "finished":
      status = "Finished";
      detail = assistantText;
      channel = "t3-finished";
      actions = [replyAction("message")];
      break;
  }
  const text = detail ? `${status} · ${detail}` : status;
  const place = [input.projectTitle, input.environmentLabel].filter(Boolean).join(" · ");
  return {
    tag: threadNotificationTag(thread.environmentId, thread.id),
    group: `t3-project:${thread.environmentId}:${thread.projectId}`,
    groupTitle: place,
    channel,
    title: clip(title, 120),
    text: clip(text, MAX_TEXT),
    bigText: clip(text, MAX_BIG_TEXT),
    subText: place,
    summaryLine: clip(`${title}: ${status}`, 120),
    when: event.at ?? input.now,
    deepLink: `/threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.id)}`,
    environmentId: thread.environmentId,
    threadId: thread.id,
    alert: input.alert,
    actions: input.canOperate ? actions : [],
  };
}
