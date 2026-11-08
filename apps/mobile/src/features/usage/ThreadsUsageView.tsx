import { useNavigation } from "@react-navigation/native";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useNowMinuteMs } from "../../lib/clock";
import { useThreadUsageEntries } from "../../state/thread-usage";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";
import {
  addTokens,
  aggregateUsage,
  totalTokens,
  usageWindowStart,
  ZERO_TOKENS,
  type TokenCounts,
  type TurnUsage,
  type UsageAggregate,
  type UsageThreadEntry,
  type UsageWindow,
} from "./threadTokenUsage";
import {
  estimateGroups,
  formatEstimate,
  NO_USAGE_RECORDED,
  turnCountLabel,
  UsageEmpty,
  UsageRow,
  UsageTotals,
  UsageWindowControl,
  useUsagePriceTables,
} from "./ThreadUsageViews";
import { useUsageToday } from "./usageToday";

function loadingNote(pending: number, failed: number): string | null {
  const notes = [
    pending > 0 ? `Reading ${pending === 1 ? "1 thread" : `${pending} threads`}…` : null,
    failed > 0 ? `${failed === 1 ? "1 thread" : `${failed} threads`} could not be read.` : null,
  ].filter((note): note is string => note !== null);
  return notes.length === 0 ? null : notes.join(" ");
}

interface ProjectUsage {
  readonly key: string;
  readonly label: string;
  readonly tokens: TokenCounts;
  readonly threadCount: number;
  readonly groups: ReadonlyArray<{ environmentId: EnvironmentId; turns: readonly TurnUsage[] }>;
}

/** Settings > Usage > Threads: every connected environment's thread usage for a time window. */
export function ThreadsUsageView(props: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly wide: boolean;
}) {
  const navigation = useNavigation();
  const [window, setWindow] = useState<UsageWindow>("7d");
  const now = useNowMinuteMs();
  const start = usageWindowStart(window, now);
  const { entries, pending, failed } = useThreadUsageEntries(start, props.selectedEnvironmentIds);
  const aggregate = useMemo(() => aggregateUsage(entries, start), [entries, start]);
  const prices = useUsagePriceTables();
  const today = useUsageToday();
  const { projectGroups, selectProject } = useSettingsEnvironmentFilter();
  const projects = groupProjects(aggregate, projectGroups);
  const estimate = estimateGroups(
    aggregate.threads.map((thread) => ({
      environmentId: thread.entry.environmentId,
      turns: thread.turns,
    })),
    prices,
  );
  const note = loadingNote(pending, failed);
  const columns = props.wide ? 4 : 2;

  return (
    <View className="gap-6">
      <UsageWindowControl window={window} onSelect={setWindow} />
      {props.selectedEnvironmentIds === null ? (
        <SettingsSection title="Today">
          <UsageRow
            first
            title={
              today.totalTokens === 0
                ? today.loading
                  ? "Reading today's threads…"
                  : "No usage recorded today"
                : `${formatTokens(today.totalTokens)} tokens`
            }
            subtitle={today.topProject ? `Most in ${today.topProject.title}` : undefined}
            value={today.topProject ? formatTokens(today.topProject.totalTokens) : ""}
          />
        </SettingsSection>
      ) : null}
      {note ? <Text className="px-2 text-sm text-foreground-muted">{note}</Text> : null}
      {aggregate.turns.length === 0 ? (
        <UsageEmpty>{pending > 0 ? "Reading threads…" : undefined}</UsageEmpty>
      ) : (
        <>
          <UsageTotals
            tokens={aggregate.tokens}
            estimate={estimate}
            columns={columns}
            footer="Turns in T3 threads that reported usage. Provider transcripts outside T3 are on the Tokens tab."
          />
          <SettingsSection title="By project">
            {projects.map((project, index) => (
              <UsageRow
                key={project.key}
                first={index === 0}
                title={project.label}
                subtitle={`${project.threadCount === 1 ? "1 thread" : `${project.threadCount} threads`} · ${formatEstimate(estimateGroups(project.groups, prices))}`}
                value={formatTokens(totalTokens(project.tokens))}
                onPress={() => {
                  selectProject(project.key);
                  navigation.navigate("SettingsProjectOverview");
                }}
              />
            ))}
          </SettingsSection>
          <SettingsSection title="By model">
            {aggregate.models.map((model, index) => (
              <UsageRow
                key={`${model.provider ?? ""}:${model.model ?? ""}`}
                first={index === 0}
                title={model.model ?? "Unknown model"}
                subtitle={`${turnCountLabel(model.turns.length)} · ${formatEstimate(
                  estimateGroups(modelGroups(aggregate, model.turns), prices),
                )}`}
                value={formatTokens(totalTokens(model.tokens))}
              />
            ))}
          </SettingsSection>
          <SettingsSection title="Top threads">
            {aggregate.threads.slice(0, 10).map((thread, index) => (
              <UsageRow
                key={`${thread.entry.environmentId}:${thread.entry.threadId}`}
                first={index === 0}
                title={thread.entry.title || "Untitled thread"}
                subtitle={turnCountLabel(thread.turns.length)}
                value={formatTokens(totalTokens(thread.tokens))}
                onPress={() =>
                  navigation.navigate("ThreadUsage", {
                    environmentId: thread.entry.environmentId,
                    threadId: thread.entry.threadId,
                  })
                }
              />
            ))}
          </SettingsSection>
        </>
      )}
    </View>
  );
}

/** One row per project group, so a repository checked out on two machines reads as one project. */
function groupProjects(
  aggregate: UsageAggregate,
  groups: ReadonlyArray<{
    readonly key: string;
    readonly representative: EnvironmentProject;
    readonly members: ReadonlyArray<{ readonly project: EnvironmentProject }>;
  }>,
): readonly ProjectUsage[] {
  const rows = new Map<string, ProjectUsage>();
  for (const project of aggregate.projects) {
    const group = groups.find((candidate) =>
      candidate.members.some(
        (member) =>
          member.project.environmentId === project.environmentId &&
          member.project.id === project.projectId,
      ),
    );
    const key = group?.key ?? `${project.environmentId}:${project.projectId}`;
    const current = rows.get(key);
    rows.set(key, {
      key,
      label: group
        ? deriveProjectGroupLabel({
            representative: group.representative,
            members: group.members.map((member) => member.project),
          })
        : "Unknown project",
      tokens: addTokens(current?.tokens ?? ZERO_TOKENS, project.tokens),
      threadCount: (current?.threadCount ?? 0) + project.threadCount,
      groups: [
        ...(current?.groups ?? []),
        { environmentId: project.environmentId, turns: project.turns },
      ],
    });
  }
  return [...rows.values()].sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens));
}

function modelGroups(aggregate: UsageAggregate, turns: readonly TurnUsage[]) {
  const wanted = new Set(turns);
  return aggregate.threads.map((thread) => ({
    environmentId: thread.entry.environmentId,
    turns: thread.turns.filter((turn) => wanted.has(turn)),
  }));
}

/** Project overview: the project's threads on the chosen environments, largest first. */
export function ProjectUsageSection(props: { readonly members: readonly EnvironmentProject[] }) {
  const navigation = useNavigation();
  const [window, setWindow] = useState<UsageWindow>("30d");
  const now = useNowMinuteMs();
  const start = usageWindowStart(window, now);
  const environmentIds = useMemo(
    () => new Set(props.members.map((member) => member.environmentId)),
    [props.members],
  );
  const { entries, pending, failed } = useThreadUsageEntries(start, environmentIds);
  const memberKeys = new Set(props.members.map((member) => `${member.environmentId}:${member.id}`));
  const projectEntries = entries.filter((entry) =>
    memberKeys.has(`${entry.environmentId}:${entry.projectId}`),
  );
  const aggregate = aggregateUsage(projectEntries, start);
  const prices = useUsagePriceTables();
  const estimate = estimateGroups(
    aggregate.threads.map((thread) => ({
      environmentId: thread.entry.environmentId,
      turns: thread.turns,
    })),
    prices,
  );
  const note = loadingNote(pending, failed);
  // Threads that never reported usage, as opposed to ones that used nothing in this window.
  const unrecorded = projectEntries.filter(
    (entry) => entry.usage !== null && entry.usage.turns.length === 0,
  );
  const openThreadUsage = (entry: UsageThreadEntry) =>
    navigation.navigate("ThreadUsage", {
      environmentId: entry.environmentId,
      threadId: entry.threadId,
    });
  return (
    <View className="gap-4">
      <View className="gap-2">
        <Text textRole="footnote" className="px-2 font-t3-medium text-foreground-muted">
          Usage
        </Text>
        <UsageWindowControl window={window} onSelect={setWindow} />
      </View>
      {note ? <Text className="px-2 text-sm text-foreground-muted">{note}</Text> : null}
      {aggregate.turns.length === 0 && unrecorded.length === 0 ? (
        <UsageEmpty>{pending > 0 ? "Reading threads…" : undefined}</UsageEmpty>
      ) : (
        <>
          {aggregate.turns.length > 0 ? (
            <UsageTotals tokens={aggregate.tokens} estimate={estimate} />
          ) : null}
          <SettingsSection title="Threads by tokens">
            {aggregate.threads.map((thread, index) => (
              <UsageRow
                key={`${thread.entry.environmentId}:${thread.entry.threadId}`}
                first={index === 0}
                title={thread.entry.title || "Untitled thread"}
                subtitle={turnCountLabel(thread.turns.length)}
                value={formatTokens(totalTokens(thread.tokens))}
                onPress={() => openThreadUsage(thread.entry)}
              />
            ))}
            {unrecorded.map((entry, index) => (
              <UsageRow
                key={`${entry.environmentId}:${entry.threadId}`}
                first={aggregate.threads.length === 0 && index === 0}
                title={entry.title || "Untitled thread"}
                subtitle={NO_USAGE_RECORDED}
                value=""
                onPress={() => openThreadUsage(entry)}
              />
            ))}
          </SettingsSection>
        </>
      )}
    </View>
  );
}
