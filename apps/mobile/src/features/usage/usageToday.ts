/**
 * "Usage today" for widgets: tokens all environments' threads used since local midnight (input with
 * cache reads and writes, plus output) and the top project. Use `useUsageToday()` in React, or
 * `subscribeUsageToday` / `readUsageToday` outside it. Only threads changed today are read.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useNowMinuteMs } from "../../lib/clock";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import { threadUsageEntriesAtom, threadUsageEntriesKey } from "../../state/thread-usage";
import {
  aggregateUsage,
  totalTokens,
  usageWindowStart,
  type UsageAggregate,
} from "./threadTokenUsage";

export interface UsageToday {
  /** Local midnight the totals start from (epoch ms). */
  readonly since: number;
  readonly totalTokens: number;
  readonly topProject: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly totalTokens: number;
  } | null;
  /** Some threads are still being read, so totals may still grow. */
  readonly loading: boolean;
}

/** @public Pure, for callers that aggregate their own entries. */
export function selectUsageToday(
  aggregate: UsageAggregate,
  since: number,
  projectTitle: (environmentId: EnvironmentId, projectId: ProjectId) => string | null,
  loading: boolean,
): UsageToday {
  const top = aggregate.projects[0];
  return {
    since,
    totalTokens: totalTokens(aggregate.tokens),
    topProject:
      top === undefined
        ? null
        : {
            environmentId: top.environmentId,
            projectId: top.projectId,
            title: projectTitle(top.environmentId, top.projectId) ?? "Untitled project",
            totalTokens: totalTokens(top.tokens),
          },
    loading,
  };
}

const usageTodayFamily = Atom.family((since: number) =>
  Atom.make((get): UsageToday => {
    const { entries, pending } = get(threadUsageEntriesAtom(threadUsageEntriesKey(since, null)));
    return selectUsageToday(
      aggregateUsage(entries, since),
      since,
      (environmentId, projectId) =>
        get(environmentProjects.projectAtom({ environmentId, projectId }))?.title ?? null,
      pending > 0,
    );
  }).pipe(Atom.withLabel(`mobile-usage:today:${since}`)),
);

/** @public The atom for the day containing `now`; a new day gets a new atom. */
export function usageTodayAtom(now: number = Date.now()) {
  return usageTodayFamily(usageWindowStart("today", now)!);
}

/** @public Moves to the new day within a minute of midnight. */
export function useUsageToday(): UsageToday {
  return useAtomValue(usageTodayAtom(useNowMinuteMs()));
}

/** @public */
export function readUsageToday(now: number = Date.now()): UsageToday {
  return appAtomRegistry.get(usageTodayAtom(now));
}

/** @public Calls `listener` with each new value until the returned function runs. Day changes need a resubscribe. */
export function subscribeUsageToday(listener: (value: UsageToday) => void): () => void {
  const atom = usageTodayAtom();
  listener(appAtomRegistry.get(atom));
  return appAtomRegistry.subscribe(atom, listener);
}
