// @effect-diagnostics globalTimers:off - Headless notification actions run outside an Effect runtime.
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";
import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import { environmentCatalog } from "../../connection/catalog";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentShell } from "../../state/shell";
import { enqueueThreadOutboxMessage, threadOutboxManager } from "../../state/thread-outbox";
import {
  environmentThreadDetails,
  environmentThreads,
  threadEnvironment,
} from "../../state/threads";
import { threadNotificationsNative as native } from "./threadNotificationNative";

export interface ThreadNotificationActionData {
  readonly tag?: string;
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly action?: string;
  readonly decision?: string;
  readonly requestId?: string;
  readonly value?: string;
  readonly mode?: string;
  readonly text?: string;
}

const CONNECT_TIMEOUT_MS = 25_000;
const LOAD_TIMEOUT_MS = 15_000;
const DELIVERY_TIMEOUT_MS = 20_000;

/** Resolves with the first value `pick` accepts, or null when the timeout passes first. */
function waitFor<A, T>(
  atom: Parameters<typeof appAtomRegistry.subscribe<A>>[0],
  pick: (value: A) => T | null,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      queueMicrotask(() => unsubscribe());
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    unsubscribe = appAtomRegistry.subscribe(
      atom,
      (value) => {
        const picked = pick(value);
        if (picked !== null) finish(picked);
      },
      { immediate: true },
    );
  });
}

function failureText(result: AtomCommandResult<unknown, unknown>): string {
  const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
  const message = error instanceof Error ? error.message : "";
  return message ? `Couldn't send: ${message}` : "Couldn't send. Open the thread to retry.";
}

async function loadUserInput(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: string,
): Promise<ThreadPendingUserInput | "resolved" | null> {
  const release = appAtomRegistry.mount(environmentThreads.stateAtom(environmentId, threadId));
  try {
    return await waitFor(
      environmentThreadDetails.pendingRequestsAtom({ environmentId, threadId }),
      (requests) =>
        requests === null
          ? null
          : (requests.userInputs.find((entry) => entry.requestId === requestId) ?? "resolved"),
      LOAD_TIMEOUT_MS,
    );
  } finally {
    release();
  }
}

async function sendMessage(environmentId: EnvironmentId, threadId: ThreadId, text: string) {
  const messageId = MessageId.make(uuidv4());
  await enqueueThreadOutboxMessage({
    environmentId,
    threadId,
    messageId,
    commandId: CommandId.make(uuidv4()),
    text,
    attachments: [],
    createdAt: new Date().toISOString(),
  });
  const key = scopedThreadKey(environmentId, threadId);
  const delivered = await waitFor(
    threadOutboxManager.queuedMessagesByThreadKeyAtom,
    (queues) =>
      (queues[key] ?? []).some((message) => message.messageId === messageId) ? null : true,
    DELIVERY_TIMEOUT_MS,
  );
  return delivered
    ? { text: "Sent", ok: true }
    : { text: "Queued. It sends once the server is reachable.", ok: true };
}

async function perform(
  data: ThreadNotificationActionData,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<{ readonly text: string; readonly ok: boolean }> {
  const requestId = data.requestId as RuntimeRequestId;
  if (data.action === "reply" && data.mode === "message") {
    return sendMessage(environmentId, threadId, data.text ?? "");
  }
  if (data.action === "approve") {
    const decision = data.decision as ProviderApprovalDecision;
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.respondToApproval,
      { environmentId, input: { threadId, requestId, decision } },
      { label: "notification approval response", reportFailure: false },
    );
    if (result._tag !== "Success") return { text: failureText(result), ok: false };
    return { text: decision === "decline" ? "Denied" : "Approved", ok: true };
  }
  const userInput = await loadUserInput(environmentId, threadId, requestId);
  if (userInput === "resolved") return { text: "Already answered", ok: true };
  const question = userInput?.questions.length === 1 ? userInput.questions[0] : undefined;
  if (userInput === null || question === undefined) {
    return { text: "Open the thread to answer.", ok: false };
  }
  const draft =
    data.action === "answer"
      ? togglePendingUserInputOptionSelection(question, undefined, data.value ?? "")
      : setPendingUserInputCustomAnswer(question, undefined, data.text ?? "");
  const answers = buildPendingUserInputAnswers(userInput.questions, { [question.id]: draft });
  if (answers === null) return { text: "Open the thread to answer.", ok: false };
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.respondToUserInput,
    { environmentId, input: { threadId, requestId, answers } },
    { label: "notification user input response", reportFailure: false },
  );
  return result._tag === "Success"
    ? { text: "Answered", ok: true }
    : { text: failureText(result), ok: false };
}

/** Headless task for a notification button or inline reply; always reports back to the card. */
export async function runThreadNotificationAction(
  data: ThreadNotificationActionData,
): Promise<void> {
  const tag = data.tag;
  if (!tag || !data.environmentId || !data.threadId) return;
  const environmentId = data.environmentId as EnvironmentId;
  const threadId = data.threadId as ThreadId;
  let outcome: { readonly text: string; readonly ok: boolean };
  try {
    const live = await waitFor(
      environmentShell.stateValueAtom(environmentId),
      (shell) => (shell.status === "live" && Option.isSome(shell.snapshot) ? true : null),
      CONNECT_TIMEOUT_MS,
    );
    if (live === null) {
      const label =
        appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId)?.target
          .label ?? "the server";
      outcome =
        data.action === "reply" && data.mode === "message"
          ? await sendMessage(environmentId, threadId, data.text ?? "")
          : { text: `Couldn't reach ${label}. Open the thread to retry.`, ok: false };
    } else {
      outcome = await perform(data, environmentId, threadId);
    }
  } catch (error) {
    outcome = {
      text: error instanceof Error ? `Couldn't send: ${error.message}` : "Couldn't send.",
      ok: false,
    };
  }
  native?.threadShowResult(tag, outcome.text, outcome.ok);
}
