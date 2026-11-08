import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ThreadPendingApproval } from "@t3tools/client-runtime/state/thread-requests";
import {
  EnvironmentId,
  MessageId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeRawThreadShell } from "../../test-fixtures";
import {
  buildThreadNotificationContent,
  decideThreadNotification,
  DEFAULT_THREAD_NOTIFICATION_SETTINGS,
  isThreadNotificationSuppressed,
  latestAssistantReply,
  plainNotificationText,
  scopedNotificationKey,
  threadNotificationEvent,
  type ThreadNotificationEvent,
} from "./threadNotificationModel";

const environmentId = EnvironmentId.make("env-1");
const at = (iso: string) => DateTime.makeUnsafe(iso);

function thread(input: Partial<OrchestrationV2ThreadShell>) {
  return presentThreadShell(environmentId, makeRawThreadShell(input));
}

const finishedRun = {
  latestRunId: RunId.make("run-1"),
  latestRunCompletedAt: at("2026-01-01T00:05:00.000Z"),
  status: "completed",
} as const;

const approvalRequest = {
  latestRunId: RunId.make("run-1"),
  activeRunId: RunId.make("run-1"),
  status: "waiting",
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make("request-1"),
    kind: "command",
    createdAt: at("2026-01-01T00:03:00.000Z"),
  },
} as const;

describe("threadNotificationEvent", () => {
  it("keys each occurrence by its run or request", () => {
    expect(threadNotificationEvent(thread(finishedRun))).toMatchObject({
      kind: "finished",
      key: "finished:run-1",
      at: Date.parse("2026-01-01T00:05:00.000Z"),
    });
    expect(threadNotificationEvent(thread(approvalRequest))).toMatchObject({
      kind: "approval",
      key: "approval:request-1",
      requestId: "request-1",
    });
    expect(
      threadNotificationEvent(
        thread({
          ...approvalRequest,
          pendingRuntimeRequest: { ...approvalRequest.pendingRuntimeRequest, kind: "user_input" },
        }),
      ),
    ).toMatchObject({ kind: "input", key: "input:request-1" });
    expect(
      threadNotificationEvent(thread({ ...finishedRun, status: "failed", lastError: "boom" })),
    ).toMatchObject({ kind: "failed", key: "failed:run-1" });
  });

  it("stays quiet while working and for a run the user stopped", () => {
    expect(
      threadNotificationEvent(
        thread({
          latestRunId: RunId.make("run-1"),
          activeRunId: RunId.make("run-1"),
          status: "running",
        }),
      ),
    ).toBeNull();
    expect(
      threadNotificationEvent(thread({ ...finishedRun, latestRunStopRequested: true })),
    ).toBeNull();
  });
});

const finished: ThreadNotificationEvent = {
  kind: "finished",
  key: "finished:run-2",
  at: 2_000_000,
  requestId: null,
};
const base = { syncedAt: 1_000_000, archived: false, visitedAt: null, suppressed: false };

describe("decideThreadNotification", () => {
  it("notifies a new event once, including after a replay or restart", () => {
    const first = decideThreadNotification({
      ...base,
      event: finished,
      record: { key: "finished:run-1", shown: null },
    });
    expect(first).toMatchObject({
      notify: true,
      record: { key: "finished:run-2", shown: "finished:run-2" },
    });
    const replay = decideThreadNotification({ ...base, event: finished, record: first.record });
    expect(replay).toMatchObject({ notify: false, clear: false, record: first.record });
  });

  it("baselines an environment's first observation and old events of unknown threads", () => {
    expect(
      decideThreadNotification({ ...base, syncedAt: null, event: finished, record: undefined }),
    ).toMatchObject({ notify: false, record: { key: "finished:run-2", shown: null } });
    expect(
      decideThreadNotification({ ...base, syncedAt: 3_000_000, event: finished, record: undefined })
        .notify,
    ).toBe(false);
    // A thread created while the app was closed still announces what it did since.
    expect(decideThreadNotification({ ...base, event: finished, record: undefined }).notify).toBe(
      true,
    );
  });

  it("consumes suppressed events so they never resurface", () => {
    const muted = decideThreadNotification({
      ...base,
      suppressed: true,
      event: finished,
      record: { key: null, shown: null },
    });
    expect(muted).toMatchObject({ notify: false, record: { key: "finished:run-2", shown: null } });
    expect(
      decideThreadNotification({ ...base, event: finished, record: muted.record }).notify,
    ).toBe(false);
  });

  it("clears a card once its state resolves elsewhere or the thread is opened", () => {
    const shown = { key: "approval:request-1", shown: "approval:request-1" };
    expect(decideThreadNotification({ ...base, event: null, record: shown })).toMatchObject({
      clear: true,
      record: { key: "approval:request-1", shown: null },
    });
    const approval = {
      kind: "approval",
      key: "approval:request-1",
      at: 5,
      requestId: "request-1",
    } as const;
    expect(
      decideThreadNotification({ ...base, event: approval, record: shown, visitedAt: 10 }).clear,
    ).toBe(true);
    expect(
      decideThreadNotification({ ...base, event: approval, record: shown, suppressed: true }).clear,
    ).toBe(true);
    expect(decideThreadNotification({ ...base, event: approval, record: shown }).clear).toBe(false);
  });

  it("replaces the card in place for the thread's next event", () => {
    const next = decideThreadNotification({
      ...base,
      event: finished,
      record: { key: "approval:request-1", shown: "approval:request-1" },
    });
    expect(next).toMatchObject({ notify: true, clear: false, record: { shown: "finished:run-2" } });
  });
});

describe("isThreadNotificationSuppressed", () => {
  const input = {
    kind: "finished",
    settings: DEFAULT_THREAD_NOTIFICATION_SETTINGS,
    environmentId: "env-1",
    projectId: "project-1",
    threadId: "thread-1",
    onScreen: false,
  } as const;

  it("follows event toggles, mutes and the open thread", () => {
    expect(isThreadNotificationSuppressed(input)).toBe(false);
    expect(isThreadNotificationSuppressed({ ...input, onScreen: true })).toBe(true);
    expect(
      isThreadNotificationSuppressed({
        ...input,
        settings: { ...DEFAULT_THREAD_NOTIFICATION_SETTINGS, finished: false },
      }),
    ).toBe(true);
    expect(
      isThreadNotificationSuppressed({
        ...input,
        settings: {
          ...DEFAULT_THREAD_NOTIFICATION_SETTINGS,
          mutedProjects: [scopedNotificationKey("env-1", "project-1")],
        },
      }),
    ).toBe(true);
    expect(
      isThreadNotificationSuppressed({
        ...input,
        settings: {
          ...DEFAULT_THREAD_NOTIFICATION_SETTINGS,
          mutedThreads: [scopedNotificationKey("env-2", "thread-1")],
        },
      }),
    ).toBe(false);
  });
});

describe("buildThreadNotificationContent", () => {
  const content = (
    shell: ReturnType<typeof thread>,
    approval: ThreadPendingApproval | null = null,
    canOperate = true,
  ) =>
    buildThreadNotificationContent({
      thread: shell,
      event: threadNotificationEvent(shell)!,
      projectTitle: "Website",
      environmentLabel: "This phone",
      canOperate,
      approval,
      userInput: null,
      reply: null,
      alert: true,
      now: 0,
    });

  it("groups per project and previews the last assistant message", () => {
    const result = content(
      thread({
        ...finishedRun,
        title: "Fix login",
        latestVisibleMessage: {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "## Done\nThe **login** form now [validates](http://x) input.",
          updatedAt: at("2026-01-01T00:05:00.000Z"),
        },
      }),
    );
    expect(result).toMatchObject({
      tag: "t3-thread:env-1:thread-test",
      group: "t3-project:env-1:project-test",
      channel: "t3-finished",
      title: "Fix login",
      text: "Finished · Done. The login form now validates input.",
      subText: "Website · This phone",
      deepLink: "/threads/env-1/thread-test",
    });
    expect(result.actions.map((action) => action.action)).toEqual(["reply"]);
  });

  it("previews the reply loaded from thread detail when the shell row has none", () => {
    const shell = thread({ ...finishedRun, title: "Fix login" });
    const reply = latestAssistantReply([
      { role: "assistant", text: "**Fixed** the form", streaming: false },
      { role: "user", text: "thanks", streaming: false },
      { role: "assistant", text: "Still typ", streaming: true },
    ]);
    expect(
      buildThreadNotificationContent({
        thread: shell,
        event: threadNotificationEvent(shell)!,
        projectTitle: null,
        environmentLabel: "This phone",
        canOperate: true,
        approval: null,
        userInput: null,
        reply,
        alert: true,
        now: 0,
      }).text,
    ).toBe("Finished · Fixed the form");
  });

  it("offers the server's approval options, keeping Deny within Android's three buttons", () => {
    const shell = thread(approvalRequest);
    const result = content(shell, {
      requestId: RuntimeRequestId.make("request-1"),
      requestKind: "command",
      createdAt: "2026-01-01T00:03:00.000Z",
      detail: "`npm test`",
      responseCapability: "live",
      options: [
        { decision: "accept", label: "Allow once" },
        { decision: "acceptForSession", label: "Allow session" },
        { decision: "acceptAlways", label: "Always allow" },
        { decision: "decline", label: "Decline" },
      ],
    });
    expect(result.channel).toBe("t3-needs-you");
    expect(result.text).toBe("Needs approval · Run a command: npm test");
    expect(result.actions.map((action) => action.label)).toEqual([
      "Allow once",
      "Allow session",
      "Deny",
    ]);
    expect(content(shell, null).actions.map((action) => action.label)).toEqual([
      "Allow once",
      "Deny",
    ]);
    expect(content(shell, null, false).actions).toEqual([]);
  });
});

describe("plainNotificationText", () => {
  it("drops code blocks, tables and markdown syntax", () => {
    expect(
      plainNotificationText(
        "## Done\nRan:\n```sh\nnpm test\n```\n| Step | Result |\n| --- | --- |\n| Test | ok |\n- `ok` passed",
      ),
    ).toBe("Done. Ran: [code] ok passed.");
  });
});
