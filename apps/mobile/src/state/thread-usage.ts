import { useAtomValue } from "@effect/atom-react";
import { request } from "@t3tools/client-runtime/rpc";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { ORCHESTRATION_V2_WS_METHODS, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  summarizeThreadUsage,
  type ThreadUsage,
  type UsageThreadEntry,
} from "../features/usage/threadTokenUsage";
import { environmentThreadShells } from "./threads";

// Each read returns a whole thread projection; a few at a time keeps a phone-hosted server responsive.
const projectionReads = Semaphore.makeUnsafe(2);

/** One thread's usage, read once per finished run (`version`) and kept as a small summary. */
const threadUsageQuery = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile-usage:thread",
  staleTimeMs: Number.POSITIVE_INFINITY,
  idleTtlMs: 30 * 60_000,
  execute: (input: { readonly threadId: ThreadId; readonly version: string }) =>
    request(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, { threadId: input.threadId }).pipe(
      Effect.map(summarizeThreadUsage),
      projectionReads.withPermit,
    ),
});

const NO_USAGE: ThreadUsage = { turns: [], reportedCost: null };

function usageVersion(shell: EnvironmentThreadShell): string | null {
  const run = shell.latestRun;
  return run === null ? null : `${run.runId}:${run.status}:${run.completedAt ?? ""}`;
}

export interface ThreadUsageEntries {
  readonly entries: readonly UsageThreadEntry[];
  /** Threads whose usage is still being read. */
  readonly pending: number;
  /** Threads whose server did not answer. */
  readonly failed: number;
}

/**
 * Usage of every thread the app knows that changed since `start` (epoch ms, null for all). A
 * thread's last change bounds its last turn, so older threads are never read for a short window.
 */
export const threadUsageEntriesAtom = Atom.family((key: string) => {
  const { start, environmentIds } = JSON.parse(key) as {
    readonly start: number | null;
    readonly environmentIds: readonly EnvironmentId[] | null;
  };
  const allowed = environmentIds === null ? null : new Set(environmentIds);
  return Atom.make((get): ThreadUsageEntries => {
    const entries: UsageThreadEntry[] = [];
    let pending = 0;
    let failed = 0;
    for (const shell of get(environmentThreadShells.threadShellsAtom)) {
      if (allowed !== null && !allowed.has(shell.environmentId)) continue;
      if (start !== null && Date.parse(shell.updatedAt) < start) continue;
      const version = usageVersion(shell);
      let usage: ThreadUsage | null = NO_USAGE;
      if (version !== null) {
        const result = get(
          threadUsageQuery({
            environmentId: shell.environmentId,
            input: { threadId: shell.id, version },
          }),
        );
        usage = AsyncResult.getOrElse(result, () => null);
        if (usage === null) {
          if (result._tag === "Failure" && !result.waiting) failed += 1;
          else pending += 1;
        }
      }
      entries.push({
        environmentId: shell.environmentId,
        threadId: shell.id,
        projectId: shell.projectId,
        title: shell.title,
        usage,
      });
    }
    return { entries, pending, failed };
  }).pipe(Atom.withLabel(`mobile-usage:entries:${key}`));
});

export function threadUsageEntriesKey(
  start: number | null,
  environmentIds: ReadonlySet<EnvironmentId> | null,
): string {
  return JSON.stringify({
    start,
    environmentIds: environmentIds === null ? null : [...environmentIds].sort(),
  });
}

export function useThreadUsageEntries(
  start: number | null,
  environmentIds: ReadonlySet<EnvironmentId> | null = null,
): ThreadUsageEntries {
  return useAtomValue(threadUsageEntriesAtom(threadUsageEntriesKey(start, environmentIds)));
}
