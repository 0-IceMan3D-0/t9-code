import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { resolveThreadListV2Status } from "../../features/threads/threadListV2";

/** Must match the dot drawables in modules/t3-home-widgets (t3w_dot_<tone>). */
export type WidgetTone = "needs" | "working" | "failed" | "done" | "idle";

export interface WidgetThreadRow {
  readonly env: string;
  readonly key: string;
  readonly title: string;
  readonly sub: string;
  readonly tone: WidgetTone;
  readonly status: string;
  readonly needsYou: boolean;
  /** Working, or waiting on the user: what the Working threads widget lists. */
  readonly active: boolean;
  readonly path: string;
  /** Minute-rounded, so a busy thread does not redraw the widget on every update. */
  readonly at: number;
}

export interface HomeThreadsSection {
  readonly count: string;
  readonly rows: ReadonlyArray<WidgetThreadRow>;
}

export interface HomeThreadsPayload {
  readonly v: 1;
  readonly live: boolean;
  readonly asOf: number;
  readonly working: HomeThreadsSection;
  readonly recent: HomeThreadsSection;
  /** Uncapped totals of active threads; the row lists stop at the widget's slot count. */
  readonly active: { readonly total: number; readonly needs: number };
}

/** Six rows fill the tallest layout; the widget shows as many as fit. */
export const HOME_WIDGET_MAX_ROWS = 6;
const MINUTE_MS = 60_000;

function describe(thread: EnvironmentThreadShell): {
  tone: WidgetTone;
  status: string;
  needsYou: boolean;
  active: boolean;
} {
  const status = resolveThreadListV2Status(thread);
  switch (status) {
    case "approval":
      return { tone: "needs", status: "Approval", needsYou: true, active: true };
    case "input":
      return { tone: "needs", status: "Question", needsYou: true, active: true };
    case "request":
      return { tone: "needs", status: "Guest message", needsYou: true, active: true };
    case "working":
      return { tone: "working", status: "Working", needsYou: false, active: true };
    case "failed":
      return { tone: "failed", status: "Failed", needsYou: false, active: false };
    case "limited":
      return { tone: "failed", status: "Usage limit", needsYou: false, active: false };
    case "waiting":
      // A run blocked on another thread is still working; an idle session is not.
      return thread.runtime?.status === "running"
        ? { tone: "working", status: "Waiting", needsYou: false, active: true }
        : { tone: "idle", status: "Idle", needsYou: false, active: false };
    case "ready": {
      const run = thread.latestRun?.status;
      if (run === "completed")
        return { tone: "done", status: "Done", needsYou: false, active: false };
      if (run === undefined) return { tone: "idle", status: "New", needsYou: false, active: false };
      return { tone: "idle", status: "Stopped", needsYou: false, active: false };
    }
  }
}

export function homeWidgetThreadRow(
  thread: EnvironmentThreadShell,
  context: { readonly projectTitle: string | null; readonly environmentLabel: string | null },
): WidgetThreadRow | null {
  if (thread.archivedAt !== null || thread.deletedAt !== null) return null;
  const at = Date.parse(thread.updatedAt);
  return {
    env: thread.environmentId,
    key: `${thread.environmentId}:${thread.id}`,
    title: thread.title.trim() || "New thread",
    sub: [context.projectTitle, context.environmentLabel].filter(Boolean).join(" · "),
    ...describe(thread),
    path: `/threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.id)}`,
    at: Number.isFinite(at) ? Math.floor(at / MINUTE_MS) * MINUTE_MS : 0,
  };
}

function workingCount(rows: ReadonlyArray<WidgetThreadRow>): string {
  const needs = rows.filter((row) => row.needsYou).length;
  if (needs > 0) return needs === 1 ? "1 needs you" : `${needs} need you`;
  return rows.length > 0 ? `${rows.length} running` : "";
}

export function buildHomeThreadsPayload(input: {
  readonly rows: ReadonlyArray<WidgetThreadRow>;
  readonly live: boolean;
  readonly asOf: number;
}): HomeThreadsPayload {
  const newest = [...input.rows].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  const working = newest.filter((row) => row.active);
  return {
    v: 1,
    live: input.live,
    asOf: input.asOf,
    working: { count: workingCount(working), rows: working.slice(0, HOME_WIDGET_MAX_ROWS) },
    recent: { count: "", rows: newest.slice(0, HOME_WIDGET_MAX_ROWS) },
    active: { total: working.length, needs: working.filter((row) => row.needsYou).length },
  };
}

/** Rows a previous process published, per environment, shown until each one reconnects. */
export function seedHomeThreadRows(
  stored: string | null,
): ReadonlyMap<string, { readonly rows: ReadonlyArray<WidgetThreadRow>; readonly asOf: number }> {
  const seeded = new Map<string, { rows: WidgetThreadRow[]; asOf: number }>();
  if (stored === null) return seeded;
  let parsed: Partial<HomeThreadsPayload>;
  try {
    parsed = JSON.parse(stored) as Partial<HomeThreadsPayload>;
  } catch {
    return seeded;
  }
  if (parsed.v !== 1 || typeof parsed.asOf !== "number") return seeded;
  const seen = new Set<string>();
  for (const row of [...(parsed.working?.rows ?? []), ...(parsed.recent?.rows ?? [])]) {
    if (typeof row?.env !== "string" || typeof row.key !== "string" || seen.has(row.key)) continue;
    seen.add(row.key);
    const entry = seeded.get(row.env) ?? { rows: [], asOf: parsed.asOf };
    entry.rows.push(row);
    seeded.set(row.env, entry);
  }
  return seeded;
}

/** What decides a redraw: asOf only matters once the data may be stale. */
export function homeThreadsSignature(payload: HomeThreadsPayload): string {
  return JSON.stringify({ ...payload, asOf: payload.live ? 0 : payload.asOf });
}

/** "980", "4.2K", "640K", "1.2M": short enough for the smallest layout. */
export function formatWidgetTokens(tokens: number): string {
  const units: ReadonlyArray<readonly [number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, unit] of units) {
    if (tokens < size) continue;
    const value = tokens / size;
    const shown = value < 10 ? Math.floor(value * 10) / 10 : Math.floor(value);
    return `${shown}${unit}`;
  }
  return String(Math.max(0, Math.floor(tokens)));
}

export interface HomeUsagePayload {
  readonly v: 1;
  readonly live: boolean;
  readonly asOf: number;
  /** Local midnight the totals count from; the widget blanks them once that day is over. */
  readonly since: number;
  readonly tokens: string;
  readonly detail: string;
  readonly path: string;
}

export function buildHomeUsagePayload(input: {
  readonly since: number;
  readonly totalTokens: number;
  readonly topProject: { readonly title: string; readonly totalTokens: number } | null;
  readonly loading: boolean;
  readonly live: boolean;
  readonly asOf: number;
}): HomeUsagePayload {
  const top = input.topProject;
  const detail =
    top !== null && top.totalTokens > 0
      ? `Busiest: ${top.title} · ${formatWidgetTokens(top.totalTokens)}`
      : input.loading
        ? "Counting…"
        : "No tokens used yet today";
  return {
    v: 1,
    live: input.live,
    asOf: input.asOf,
    since: input.since,
    tokens: formatWidgetTokens(input.totalTokens),
    detail,
    path: "/settings/usage",
  };
}
