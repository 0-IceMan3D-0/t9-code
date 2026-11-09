import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeRawThreadShell } from "../../test-fixtures";
import {
  buildHomeThreadsPayload,
  buildHomeLimitsPayload,
  buildHomeUsagePayload,
  formatWidgetTokens,
  homeThreadsSignature,
  homeWidgetThreadRow,
  seedHomeThreadRows,
  type WidgetThreadRow,
} from "./homeWidgetsModel";

const environmentId = EnvironmentId.make("env:1");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const context: Parameters<typeof homeWidgetThreadRow>[1] = {
  projectTitle: "Website",
  environmentLabel: null,
};

function row(input: Partial<OrchestrationV2ThreadShell>, ctx = context): WidgetThreadRow | null {
  return homeWidgetThreadRow(presentThreadShell(environmentId, makeRawThreadShell(input)), ctx);
}

const working = {
  latestRunId: RunId.make("run-1"),
  activeRunId: RunId.make("run-1"),
  status: "running",
} as const;

const approval = {
  ...working,
  status: "waiting",
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make("request-1"),
    kind: "command",
    createdAt: at("2026-01-01T00:03:00.000Z"),
  },
} as const;

const fakeRow = (
  key: string,
  minute: number,
  active: boolean,
  needsYou = false,
): WidgetThreadRow => ({
  env: "env:1",
  key,
  title: key,
  sub: "",
  tone: needsYou ? "needs" : active ? "working" : "done",
  status: "",
  needsYou,
  active,
  path: `/threads/env/${key}`,
  at: minute * 60_000,
});

describe("homeWidgetThreadRow", () => {
  it("marks working threads and threads that need the user as active", () => {
    expect(row(working)).toMatchObject({
      tone: "working",
      status: "Working",
      active: true,
      needsYou: false,
    });
    expect(row(approval)).toMatchObject({
      tone: "needs",
      status: "Approval",
      active: true,
      needsYou: true,
    });
    expect(
      row({
        ...approval,
        pendingRuntimeRequest: { ...approval.pendingRuntimeRequest, kind: "user_input" },
      }),
    ).toMatchObject({ status: "Question", needsYou: true });
    expect(
      row({
        latestRunId: RunId.make("run-1"),
        latestRunCompletedAt: at("2026-01-01T00:05:00.000Z"),
        status: "completed",
      }),
    ).toMatchObject({ tone: "done", status: "Done", active: false });
    expect(row({})).toMatchObject({ tone: "idle", status: "New", active: false });
  });

  it("leaves out archived and deleted threads", () => {
    expect(row({ archivedAt: at("2026-01-01T00:00:00.000Z") })).toBeNull();
    expect(row({ deletedAt: at("2026-01-01T00:00:00.000Z") })).toBeNull();
  });

  it("links to the thread, names project and server, and rounds the time to the minute", () => {
    const result = row(
      { id: ThreadId.make("t/1"), title: "  ", updatedAt: at("2026-01-01T00:07:42.000Z") },
      { projectTitle: "Website", environmentLabel: "Laptop" },
    );
    expect(result).toMatchObject({
      title: "New thread",
      sub: "Website · Laptop",
      path: "/threads/env%3A1/t%2F1",
      at: Date.parse("2026-01-01T00:07:00.000Z"),
    });
  });
});

describe("buildHomeThreadsPayload", () => {
  it("lists active threads newest first and counts who needs the user", () => {
    const payload = buildHomeThreadsPayload({
      rows: [fakeRow("old", 1, true), fakeRow("done", 9, false), fakeRow("ask", 5, true, true)],
      live: true,
      asOf: 0,
    });
    expect(payload.working.rows.map((entry) => entry.key)).toEqual(["ask", "old"]);
    expect(payload.working.count).toBe("1 needs you");
    expect(payload.active).toEqual({ total: 2, needs: 1 });
    expect(payload.recent.rows.map((entry) => entry.key)).toEqual(["done", "ask", "old"]);
  });

  it("caps each list and says how many run when nobody waits", () => {
    const rows = Array.from({ length: 9 }, (_, index) => fakeRow(`t${index}`, index, true));
    const payload = buildHomeThreadsPayload({ rows, live: true, asOf: 0 });
    expect(payload.working.rows).toHaveLength(6);
    expect(payload.working.count).toBe("9 running");
    expect(payload.active).toEqual({ total: 9, needs: 0 });
    expect(buildHomeThreadsPayload({ rows: [], live: true, asOf: 0 }).working.count).toBe("");
  });

  it("ignores the time stamp for redraws until the data may be stale", () => {
    const at1 = buildHomeThreadsPayload({ rows: [], live: true, asOf: 1 });
    const at2 = buildHomeThreadsPayload({ rows: [], live: true, asOf: 2 });
    expect(homeThreadsSignature(at1)).toBe(homeThreadsSignature(at2));
    expect(homeThreadsSignature({ ...at1, live: false })).not.toBe(
      homeThreadsSignature({ ...at2, live: false }),
    );
  });
});

describe("seedHomeThreadRows", () => {
  it("restores each environment's rows once, with the time they were published", () => {
    const stored = buildHomeThreadsPayload({
      rows: [fakeRow("a", 2, true), { ...fakeRow("b", 1, false), env: "env:2" }],
      live: false,
      asOf: 1234,
    });
    const seeded = seedHomeThreadRows(JSON.stringify(stored));
    expect([...seeded.keys()]).toEqual(["env:1", "env:2"]);
    expect(seeded.get("env:1")).toMatchObject({ asOf: 1234, rows: [{ key: "a" }] });
  });

  it("ignores missing and malformed data", () => {
    expect(seedHomeThreadRows(null).size).toBe(0);
    expect(seedHomeThreadRows("{").size).toBe(0);
    expect(seedHomeThreadRows(JSON.stringify({ v: 2, asOf: 1 })).size).toBe(0);
  });
});

describe("usage today", () => {
  it("shortens token counts without rounding up", () => {
    expect([0, 980, 4_290, 640_900, 1_250_000, 12_900_000_000].map(formatWidgetTokens)).toEqual([
      "0",
      "980",
      "4.2K",
      "640K",
      "1.2M",
      "12B",
    ]);
  });

  it("names the busiest project, or says it is still counting", () => {
    const base = { since: 0, totalTokens: 1_500_000, live: true, asOf: 0 };
    expect(
      buildHomeUsagePayload({
        ...base,
        topProject: { title: "Website", totalTokens: 900_000 },
        loading: false,
      }),
    ).toMatchObject({ tokens: "1.5M", detail: "Busiest: Website · 900K", live: true });
    expect(buildHomeUsagePayload({ ...base, topProject: null, loading: true })).toMatchObject({
      detail: "Counting…",
    });
    expect(
      buildHomeUsagePayload({ ...base, totalTokens: 0, topProject: null, loading: false }),
    ).toMatchObject({
      tokens: "0",
      detail: "No tokens used yet today",
    });
  });

  it("averages the six days before today once they are counted", () => {
    const base = { since: 0, totalTokens: 1_000, topProject: null, live: true, asOf: 0 };
    expect(buildHomeUsagePayload({ ...base, loading: false, weekTokens: 7_000 })).toMatchObject({
      todayTokens: 1_000,
      averageTokens: 1_000,
    });
    expect(buildHomeUsagePayload({ ...base, loading: true, weekTokens: 7_000 }).averageTokens).toBe(
      null,
    );
    expect(buildHomeUsagePayload({ ...base, loading: false }).averageTokens).toBe(null);
  });
});

describe("buildHomeLimitsPayload", () => {
  const window = (kind: string, label: string, remaining: number) => ({
    kind,
    label,
    remaining,
    reset: "",
    resetAt: 9,
  });
  const provider = (name: string, windows: ReturnType<typeof window>[]) => ({
    name,
    detail: "Open T3 to refresh",
    windows,
    expiresAt: 5,
    totalWindows: windows.length,
  });

  it("orders session before weekly and names the provider only when two show", () => {
    const claude = provider("Claude", [
      window("weekly", "Weekly · Opus", 40),
      window("weekly", "Weekly", 70),
      window("session", "Session", 12),
    ]);
    expect(
      buildHomeLimitsPayload({ providers: [claude] }, "/settings/usage").gauges.map((g) => [
        g.tag,
        g.remaining,
      ]),
    ).toEqual([
      ["5H", 12],
      ["WK", 70],
      ["OPUS", 40],
    ]);
    const codex = provider("Codex", [window("session", "5h", 90)]);
    expect(
      buildHomeLimitsPayload({ providers: [claude, codex] }, "/").gauges.map((g) => g.tag),
    ).toEqual(["CL 5H", "CL WK", "CL OPUS", "CO 5H"]);
  });

  it("explains an empty widget", () => {
    expect(buildHomeLimitsPayload({ providers: [] }, "/").empty).toBe("No Claude or Codex limits");
    expect(buildHomeLimitsPayload({ providers: [provider("Claude", [])] }, "/").empty).toBe(
      "Open T3 to refresh",
    );
  });
});
