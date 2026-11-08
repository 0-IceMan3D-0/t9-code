import { EnvironmentId, ProjectId, ThreadId, UsageDay, type UsageBucket } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  aggregateUsage,
  derivePriceTable,
  estimateCost,
  inputTokens,
  summarizeThreadUsage,
  totalTokens,
  usageWindowStart,
  type ThreadUsage,
} from "./threadTokenUsage";

type Projection = Parameters<typeof summarizeThreadUsage>[0];

const at = (iso: string) => DateTime.makeUnsafe(iso);

function projection(turns: ReadonlyArray<Record<string, unknown>>): Projection {
  return {
    thread: { activeProviderThreadId: "pt-1", modelSelection: { model: "thread-model" } },
    providerThreads: [
      {
        id: "pt-1",
        driver: "claudeAgent",
        contextUsage: { usedTokens: 1, cost: { amount: 0.42, currency: "USD" } },
      },
    ],
    attempts: [{ id: "attempt-1", runId: "run-1" }],
    runs: [{ id: "run-1", modelSelection: { model: "claude-sonnet-4-5" } }],
    providerTurns: turns.map((turn, index) => ({
      id: `turn-${index}`,
      providerThreadId: "pt-1",
      runAttemptId: "attempt-1",
      ordinal: index + 1,
      startedAt: null,
      completedAt: at("2026-11-08T10:00:00Z"),
      ...turn,
    })),
  } as unknown as Projection;
}

describe("summarizeThreadUsage", () => {
  it("splits input into uncached, cache reads and cache writes and skips turns without usage", () => {
    const usage = summarizeThreadUsage(
      projection([
        {
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 1_000,
            cachedInputTokens: 600,
            cacheCreationTokens: 300,
            outputTokens: 200,
            reasoningTokens: 50,
            otherUsage: { inputTokens: 10, outputTokens: 5 },
          },
        },
        {
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "unavailable",
            hasSubagents: false,
          },
        },
        {
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 9,
            outputTokens: 9,
            localCommand: true,
          },
        },
        {},
      ]),
    );
    expect(usage.reportedCost).toEqual({ amount: 0.42, currency: "USD" });
    expect(usage.turns).toHaveLength(1);
    const [turn] = usage.turns;
    expect(turn!.tokens).toEqual({
      uncachedInput: 100,
      cacheRead: 600,
      cacheWrite: 300,
      output: 200,
      reasoning: 50,
      other: 15,
    });
    expect(inputTokens(turn!.tokens)).toBe(1_000);
    expect(totalTokens(turn!.tokens)).toBe(1_215);
    expect(turn!.provider).toBe("claude");
    // No reported model ids, so the run's selection names the model.
    expect(turn!.model).toBe("claude-sonnet-4-5");
  });

  it("clamps cache counters that exceed input and prefers the provider's model id", () => {
    const usage = summarizeThreadUsage(
      projection([
        {
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "partial",
            hasSubagents: false,
            inputTokens: 100,
            cachedInputTokens: 80,
            cacheCreationTokens: 80,
            outputTokens: 10,
            models: ["claude-opus-4-1"],
          },
        },
      ]),
    );
    expect(usage.turns[0]).toMatchObject({
      partial: true,
      model: "claude-opus-4-1",
      tokens: { uncachedInput: 0, cacheRead: 80, cacheWrite: 20 },
    });
  });
});

describe("usageWindowStart", () => {
  it("starts windows at local midnight and counts today as day one", () => {
    const now = new Date(2026, 10, 8, 15, 30).getTime();
    expect(usageWindowStart("today", now)).toBe(new Date(2026, 10, 8).getTime());
    expect(usageWindowStart("7d", now)).toBe(new Date(2026, 10, 2).getTime());
    expect(usageWindowStart("30d", now)).toBe(new Date(2026, 9, 10).getTime());
    expect(usageWindowStart("all", now)).toBeNull();
  });
});

const tokens = (input: number, output: number) => ({
  uncachedInput: input,
  cacheRead: 0,
  cacheWrite: 0,
  output,
  reasoning: 0,
  other: 0,
});

function threadUsage(
  entries: ReadonlyArray<[at: number, input: number, model: string]>,
): ThreadUsage {
  return {
    reportedCost: null,
    turns: entries.map(([time, input, model], index) => ({
      id: `t${index}`,
      ordinal: index + 1,
      at: time,
      provider: "claude",
      model,
      partial: false,
      tokens: tokens(input, 0),
    })),
  };
}

describe("aggregateUsage", () => {
  const env = EnvironmentId.make("env-1");
  const entry = (id: string, project: string, usage: ThreadUsage | null) => ({
    environmentId: env,
    threadId: ThreadId.make(id),
    projectId: ProjectId.make(project),
    title: id,
    usage,
  });

  it("groups turns in the window by thread, project and model, largest first", () => {
    const aggregate = aggregateUsage(
      [
        entry(
          "a",
          "p1",
          threadUsage([
            [100, 10, "m1"],
            [300, 20, "m2"],
          ]),
        ),
        entry("b", "p2", threadUsage([[400, 50, "m1"]])),
        entry("c", "p1", threadUsage([[50, 999, "m1"]])),
        entry("d", "p2", null),
        entry("e", "p2", threadUsage([])),
      ],
      200,
    );
    expect(totalTokens(aggregate.tokens)).toBe(70);
    expect(aggregate.threads.map((thread) => thread.entry.threadId)).toEqual(["b", "a"]);
    expect(
      aggregate.projects.map((project) => [
        project.projectId,
        totalTokens(project.tokens),
        project.threadCount,
      ]),
    ).toEqual([
      ["p2", 50, 1],
      ["p1", 20, 1],
    ]);
    expect(aggregate.models.map((model) => [model.model, totalTokens(model.tokens)])).toEqual([
      ["m1", 50],
      ["m2", 20],
    ]);
  });
});

describe("pricing", () => {
  const bucket = (overrides: Partial<UsageBucket>): UsageBucket => ({
    day: UsageDay.make("2026-11-08"),
    provider: "claude",
    model: "m1",
    totals: {
      uncachedInputTokens: 1_000,
      cachedInputTokens: 2_000,
      cacheCreationTokens: 0,
      outputTokens: 500,
      reasoningTokens: 0,
    },
    costUsd: 0,
    cacheSavingsUsd: 0,
    categoryCostUsd: { input: 0.003, cacheRead: 0.0006, cacheWrite: 0, output: 0.0075 },
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  });

  it("prices turns with the rates a server's buckets imply and counts what it cannot price", () => {
    const prices = derivePriceTable([
      bucket({}),
      bucket({ model: "unpriced", costSource: "unpriced" }),
    ]);
    const usage = threadUsage([
      [0, 2_000, "m1"],
      [0, 1_000, "unpriced"],
    ]);
    const turns = [
      { ...usage.turns[0]!, tokens: { ...tokens(2_000, 100), cacheRead: 1_000, cacheWrite: 7 } },
      usage.turns[1]!,
    ];
    const estimate = estimateCost(turns, prices);
    // 2000 * 3e-6 + 1000 * 3e-7 + 100 * 1.5e-5; the cache write and the unpriced model are left out.
    expect(estimate?.usd).toBeCloseTo(0.0078, 10);
    expect(estimate?.unpricedTokens).toBe(1_007);
    expect(estimateCost([usage.turns[1]!], prices)).toBeNull();
  });
});
