import type { EnvironmentId } from "@t3tools/contracts";
import { formatTokens, formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import { useMemo, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { cn } from "../../lib/cn";
import { useUsage } from "../../state/usage";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  derivePriceTable,
  estimateCost,
  inputTokens,
  totalTokens,
  type CostEstimate,
  type PriceTable,
  type TokenCounts,
  type TurnUsage,
  type UsageWindow,
} from "./threadTokenUsage";

export const USAGE_WINDOW_OPTIONS = [
  { value: "today", label: "Today", accessibilityLabel: "Today" },
  { value: "7d", label: "7d", accessibilityLabel: "Past 7 days" },
  { value: "30d", label: "30d", accessibilityLabel: "Past 30 days" },
  { value: "all", label: "All", accessibilityLabel: "All time" },
] as const satisfies readonly { value: UsageWindow; label: string; accessibilityLabel: string }[];

export const NO_USAGE_RECORDED = "No usage recorded";

export function UsageWindowControl(props: {
  readonly window: UsageWindow;
  readonly onSelect: (window: UsageWindow) => void;
}) {
  return (
    <SegmentedControl
      options={USAGE_WINDOW_OPTIONS}
      selected={props.window}
      onSelect={props.onSelect}
      size="compact"
    />
  );
}

/**
 * Rates from each environment's last 30 days of priced usage, the same scan Settings > Usage
 * shows. Environments that cannot report usage, or predate category costs, price nothing.
 */
export function useUsagePriceTables(): ReadonlyMap<EnvironmentId, PriceTable> {
  const window = makeWindow(30);
  const { environments } = useUsage(window);
  return useMemo(
    () =>
      new Map(
        environments.flatMap((environment) =>
          environment.summary === null
            ? []
            : [[environment.environmentId, derivePriceTable(environment.summary.buckets)] as const],
        ),
      ),
    [environments],
  );
}

/** Sums each group's estimate with its own environment's rates; null when nothing was priced. */
export function estimateGroups(
  groups: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly turns: readonly TurnUsage[];
  }>,
  prices: ReadonlyMap<EnvironmentId, PriceTable>,
): CostEstimate | null {
  let usd = 0;
  let unpricedTokens = 0;
  let priced = false;
  for (const group of groups) {
    const table = prices.get(group.environmentId);
    const estimate = table === undefined ? null : estimateCost(group.turns, table);
    if (estimate === null) {
      unpricedTokens += group.turns.reduce((sum, turn) => sum + totalTokens(turn.tokens), 0);
      continue;
    }
    usd += estimate.usd;
    unpricedTokens += estimate.unpricedTokens;
    priced = true;
  }
  return priced ? { usd, unpricedTokens } : null;
}

export function formatEstimate(estimate: CostEstimate | null): string {
  if (estimate === null) return "Not priced";
  return `≈ ${formatUsd(estimate.usd)}`;
}

function Metric(props: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly columns: number;
}) {
  return (
    <View className="gap-0.5 p-4" style={{ width: `${100 / props.columns}%` }}>
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="text-xl font-t3-medium tabular-nums text-foreground">{props.value}</Text>
      {props.detail ? (
        <Text className="text-xs text-foreground-tertiary">{props.detail}</Text>
      ) : null}
    </View>
  );
}

export function UsageTotals(props: {
  readonly title?: string;
  readonly tokens: TokenCounts;
  readonly estimate: CostEstimate | null;
  /** Shown instead of an estimate, labelled as the provider's own figure. */
  readonly reportedCost?: { readonly amount: number; readonly currency: string } | null;
  readonly columns?: number;
  readonly footer?: string;
}) {
  const { tokens } = props;
  const columns = props.columns ?? 2;
  const reported = props.reportedCost ?? null;
  return (
    <SettingsSection title={props.title ?? "Tokens"} footer={props.footer}>
      <View className="flex-row flex-wrap">
        <Metric
          columns={columns}
          label="Total"
          value={formatTokens(totalTokens(tokens))}
          detail={
            tokens.other > 0
              ? `incl. ${formatTokens(tokens.other)} subagents and compaction`
              : undefined
          }
        />
        <Metric
          columns={columns}
          label="Input"
          value={formatTokens(inputTokens(tokens))}
          detail={`${formatTokens(tokens.uncachedInput)} uncached · ${formatTokens(tokens.cacheRead)} cache read · ${formatTokens(tokens.cacheWrite)} cache write`}
        />
        <Metric
          columns={columns}
          label="Output"
          value={formatTokens(tokens.output)}
          detail={
            tokens.reasoning > 0 ? `incl. ${formatTokens(tokens.reasoning)} reasoning` : undefined
          }
        />
        {reported !== null ? (
          <Metric
            columns={columns}
            label="Cost"
            value={`${reported.currency} ${reported.amount.toFixed(reported.amount < 0.01 && reported.amount > 0 ? 4 : 2)}`}
            detail="Reported by the provider"
          />
        ) : (
          <Metric
            columns={columns}
            label="Estimated cost"
            value={formatEstimate(props.estimate)}
            detail={
              props.estimate === null
                ? "This server has no prices for these models"
                : props.estimate.unpricedTokens > 0
                  ? `Estimate · ${formatTokens(props.estimate.unpricedTokens)} tokens unpriced`
                  : "Estimate from this server's prices"
            }
          />
        )}
      </View>
    </SettingsSection>
  );
}

export function UsageRow(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly value: string;
  readonly leading?: ReactNode;
  readonly first?: boolean;
  readonly onPress?: () => void;
}) {
  const content = (
    <View
      className={cn(
        "flex-row items-center gap-3 px-4 py-3",
        !props.first && "border-t border-border-subtle",
      )}
    >
      {props.leading}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      <Text className="text-base tabular-nums text-foreground">{props.value}</Text>
    </View>
  );
  return props.onPress ? (
    <Pressable accessibilityRole="button" onPress={props.onPress} className="active:bg-subtle">
      {content}
    </Pressable>
  ) : (
    content
  );
}

export function UsageEmpty(props: { readonly children?: string }) {
  return (
    <Text className="py-10 text-center text-base text-foreground-muted">
      {props.children ?? NO_USAGE_RECORDED}
    </Text>
  );
}

export function turnCountLabel(count: number): string {
  return count === 1 ? "1 turn" : `${count} turns`;
}
