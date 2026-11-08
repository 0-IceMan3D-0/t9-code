import {
  UsageProviderKind,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type ProjectId,
  type ThreadId,
  type UsageBucket,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const isUsageProviderKind = Schema.is(UsageProviderKind);

/** Usage names Claude's driver `claude`; other drivers share their kind's name. */
function usageProviderKind(driver: string): UsageProviderKind | null {
  const kind = driver === "claudeAgent" ? "claude" : driver;
  return isUsageProviderKind(kind) ? kind : null;
}

/** Input splits into uncached, cache reads and cache writes; reasoning is part of output. */
export interface TokenCounts {
  readonly uncachedInput: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number;
  /** Subagents and compaction the provider ledger reports beyond the main agent. */
  readonly other: number;
}

export const ZERO_TOKENS: TokenCounts = {
  uncachedInput: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  other: 0,
};

export interface TurnUsage {
  readonly id: string;
  readonly ordinal: number;
  /** Epoch ms the turn completed, or started when it never completed. */
  readonly at: number | null;
  readonly provider: UsageProviderKind | null;
  readonly model: string | null;
  readonly partial: boolean;
  readonly tokens: TokenCounts;
}

export interface ThreadUsage {
  readonly turns: readonly TurnUsage[];
  /** Cumulative cost the provider itself reported for the active conversation. */
  readonly reportedCost: { readonly amount: number; readonly currency: string } | null;
}

type UsageProjection = Pick<
  OrchestrationV2ThreadProjection,
  "providerTurns" | "providerThreads" | "attempts" | "runs"
> & {
  readonly thread: Pick<
    OrchestrationV2ThreadProjection["thread"],
    "activeProviderThreadId" | "modelSelection"
  >;
};

export function inputTokens(tokens: TokenCounts): number {
  return tokens.uncachedInput + tokens.cacheRead + tokens.cacheWrite;
}

export function totalTokens(tokens: TokenCounts): number {
  return inputTokens(tokens) + tokens.output + tokens.other;
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    uncachedInput: a.uncachedInput + b.uncachedInput,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    other: a.other + b.other,
  };
}

function millis(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

/**
 * Per-turn usage from the provider turns that report it. Turns whose usage is unavailable or that
 * ran a local command are left out, so a thread with no reported turn has no usage at all.
 */
export function summarizeThreadUsage(projection: UsageProjection): ThreadUsage {
  const driverByProviderThread = new Map(
    projection.providerThreads.map((thread) => [thread.id, thread.driver]),
  );
  const runIdByAttempt = new Map(projection.attempts.map((attempt) => [attempt.id, attempt.runId]));
  const modelByRun = new Map(projection.runs.map((run) => [run.id, run.modelSelection.model]));
  const turns: TurnUsage[] = [];
  for (const turn of projection.providerTurns) {
    const usage = turn.turnTokenUsage;
    if (usage === undefined || usage.usageStatus === "unavailable" || usage.localCommand) continue;
    if (usage.inputTokens === undefined && usage.outputTokens === undefined) continue;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cacheRead = Math.min(usage.cachedInputTokens ?? 0, input);
    const cacheWrite = Math.min(usage.cacheCreationTokens ?? 0, input - cacheRead);
    const runId = turn.runAttemptId === null ? undefined : runIdByAttempt.get(turn.runAttemptId);
    const driver = driverByProviderThread.get(turn.providerThreadId);
    turns.push({
      id: turn.id,
      ordinal: turn.ordinal,
      at: millis(turn.completedAt) ?? millis(turn.startedAt),
      provider: driver === undefined ? null : usageProviderKind(driver),
      model:
        usage.models?.[0] ??
        (runId === undefined ? undefined : modelByRun.get(runId)) ??
        projection.thread.modelSelection.model,
      partial: usage.usageStatus === "partial",
      tokens: {
        uncachedInput: input - cacheRead - cacheWrite,
        cacheRead,
        cacheWrite,
        output,
        reasoning: Math.min(usage.reasoningTokens ?? 0, output),
        other: (usage.otherUsage?.inputTokens ?? 0) + (usage.otherUsage?.outputTokens ?? 0),
      },
    });
  }
  turns.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.ordinal - b.ordinal);
  const active = projection.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  return { turns, reportedCost: active?.contextUsage?.cost ?? null };
}

export type UsageWindow = "today" | "7d" | "30d" | "all";

/** Local midnight that starts the window, or null for all time. 7d includes today. */
export function usageWindowStart(window: UsageWindow, now: number): number | null {
  if (window === "all") return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const days = window === "today" ? 0 : window === "7d" ? 6 : 29;
  start.setDate(start.getDate() - days);
  return start.getTime();
}

function turnsInWindow(turns: readonly TurnUsage[], start: number | null): readonly TurnUsage[] {
  return start === null ? turns : turns.filter((turn) => turn.at !== null && turn.at >= start);
}

export interface PriceRates {
  readonly input: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
}

export type PriceTable = ReadonlyMap<string, PriceRates>;

const priceKey = (provider: UsageProviderKind, model: string) => `${provider}\u0000${model}`;

/**
 * Per-token rates implied by a server's priced usage buckets. The server owns pricing and sends
 * no rate table, so the rate is each category's cost over its tokens; tiered prices average out.
 */
export function derivePriceTable(buckets: readonly UsageBucket[]): PriceTable {
  const sums = new Map<
    string,
    { cost: [number, number, number, number]; tokens: [number, number, number, number] }
  >();
  for (const bucket of buckets) {
    const category = bucket.categoryCostUsd;
    if (category === undefined || bucket.costSource === "unpriced" || bucket.unpricedRecords > 0) {
      continue;
    }
    const key = priceKey(bucket.provider, bucket.model);
    const entry = sums.get(key) ?? { cost: [0, 0, 0, 0], tokens: [0, 0, 0, 0] };
    entry.cost[0] += category.input;
    entry.cost[1] += category.cacheRead;
    entry.cost[2] += category.cacheWrite;
    entry.cost[3] += category.output;
    entry.tokens[0] += bucket.totals.uncachedInputTokens;
    entry.tokens[1] += bucket.totals.cachedInputTokens;
    entry.tokens[2] += bucket.totals.cacheCreationTokens;
    entry.tokens[3] += bucket.totals.outputTokens;
    sums.set(key, entry);
  }
  const rate = (cost: number, tokens: number) => (tokens > 0 ? cost / tokens : null);
  return new Map(
    [...sums].map(([key, { cost, tokens }]) => [
      key,
      {
        input: rate(cost[0], tokens[0]),
        cacheRead: rate(cost[1], tokens[1]),
        cacheWrite: rate(cost[2], tokens[2]),
        output: rate(cost[3], tokens[3]),
      },
    ]),
  );
}

export interface CostEstimate {
  readonly usd: number;
  /** Tokens without a known rate; the estimate leaves them out. */
  readonly unpricedTokens: number;
}

/** Null when no turn could be priced at all. */
export function estimateCost(turns: readonly TurnUsage[], prices: PriceTable): CostEstimate | null {
  let usd = 0;
  let priced = false;
  let unpricedTokens = 0;
  for (const turn of turns) {
    const rates =
      turn.provider === null || turn.model === null
        ? undefined
        : prices.get(priceKey(turn.provider, turn.model));
    const parts: ReadonlyArray<readonly [number, number | null | undefined]> = [
      [turn.tokens.uncachedInput, rates?.input],
      [turn.tokens.cacheRead, rates?.cacheRead],
      [turn.tokens.cacheWrite, rates?.cacheWrite],
      [turn.tokens.output, rates?.output],
    ];
    for (const [tokens, rate] of parts) {
      if (tokens === 0) continue;
      if (rate == null) {
        unpricedTokens += tokens;
        continue;
      }
      usd += tokens * rate;
      priced = true;
    }
    unpricedTokens += turn.tokens.other;
  }
  return priced ? { usd, unpricedTokens } : null;
}

export interface UsageThreadEntry {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** Null while the thread's usage is loading or could not be read. */
  readonly usage: ThreadUsage | null;
}

export interface UsageGroupTotals {
  readonly tokens: TokenCounts;
  readonly turns: readonly TurnUsage[];
}

export interface UsageAggregate {
  readonly tokens: TokenCounts;
  readonly turns: readonly TurnUsage[];
  readonly threads: ReadonlyArray<UsageGroupTotals & { readonly entry: UsageThreadEntry }>;
  readonly projects: ReadonlyArray<
    UsageGroupTotals & {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly threadCount: number;
    }
  >;
  readonly models: ReadonlyArray<
    UsageGroupTotals & {
      readonly provider: UsageProviderKind | null;
      readonly model: string | null;
    }
  >;
}

function group<K>(
  turns: Iterable<readonly [K, TurnUsage]>,
): Map<K, { tokens: TokenCounts; turns: TurnUsage[] }> {
  const groups = new Map<K, { tokens: TokenCounts; turns: TurnUsage[] }>();
  for (const [key, turn] of turns) {
    const entry = groups.get(key) ?? { tokens: ZERO_TOKENS, turns: [] };
    entry.tokens = addTokens(entry.tokens, turn.tokens);
    entry.turns.push(turn);
    groups.set(key, entry);
  }
  return groups;
}

const byTotalDescending = (a: UsageGroupTotals, b: UsageGroupTotals) =>
  totalTokens(b.tokens) - totalTokens(a.tokens);

/** Threads, projects and models that used tokens in the window, largest first. */
export function aggregateUsage(
  entries: readonly UsageThreadEntry[],
  start: number | null,
): UsageAggregate {
  const threads: Array<UsageGroupTotals & { readonly entry: UsageThreadEntry }> = [];
  for (const entry of entries) {
    const turns = turnsInWindow(entry.usage?.turns ?? [], start);
    if (turns.length === 0) continue;
    threads.push({
      entry,
      turns,
      tokens: turns.reduce((sum, t) => addTokens(sum, t.tokens), ZERO_TOKENS),
    });
  }
  threads.sort(byTotalDescending);
  const allTurns = threads.flatMap((thread) => thread.turns);
  const projectGroups = new Map<
    string,
    {
      environmentId: EnvironmentId;
      projectId: ProjectId;
      tokens: TokenCounts;
      turns: TurnUsage[];
      threadCount: number;
    }
  >();
  for (const thread of threads) {
    const key = `${thread.entry.environmentId}\u0000${thread.entry.projectId}`;
    const current = projectGroups.get(key) ?? {
      environmentId: thread.entry.environmentId,
      projectId: thread.entry.projectId,
      tokens: ZERO_TOKENS,
      turns: [],
      threadCount: 0,
    };
    current.tokens = addTokens(current.tokens, thread.tokens);
    current.turns.push(...thread.turns);
    current.threadCount += 1;
    projectGroups.set(key, current);
  }
  const models = [
    ...group(
      allTurns.map((turn) => [`${turn.provider ?? ""}\u0000${turn.model ?? ""}`, turn] as const),
    ).values(),
  ].map((entry) => ({
    ...entry,
    provider: entry.turns[0]!.provider,
    model: entry.turns[0]!.model,
  }));
  return {
    tokens: threads.reduce((sum, thread) => addTokens(sum, thread.tokens), ZERO_TOKENS),
    turns: allTurns,
    threads,
    projects: [...projectGroups.values()].sort(byTotalDescending),
    models: models.sort(byTotalDescending),
  };
}
