import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatContextWindowTokens } from "@t3tools/client-runtime/state/context-window";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useThreadShell } from "../../state/entities";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { SettingsSection } from "../settings/components/SettingsSection";
import { contextMeterModel } from "../threads/contextMeter";
import {
  ContextRing,
  threadContextWindow,
  useContextToneColor,
} from "../threads/ContextWindowMeter";
import {
  addTokens,
  inputTokens,
  summarizeThreadUsage,
  totalTokens,
  ZERO_TOKENS,
  type TurnUsage,
} from "./threadTokenUsage";
import {
  estimateGroups,
  NO_USAGE_RECORDED,
  UsageRow,
  UsageTotals,
  useUsagePriceTables,
} from "./ThreadUsageViews";

type ThreadUsageTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

const TIME = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function ThreadUsageSheet({ route }: StaticScreenProps<ThreadUsageTarget>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const ref = scopeThreadRef(route.params.environmentId, route.params.threadId);
  const shell = useThreadShell(ref);
  const structure = useQuietThreadStructure(ref);
  const prices = useUsagePriceTables();
  const projection = structure?.projection ?? null;
  const context = threadContextWindow(projection);
  const usage = projection === null ? null : summarizeThreadUsage(projection);
  const turns = usage?.turns ?? [];
  const tokens = turns.reduce((sum, turn) => addTokens(sum, turn.tokens), ZERO_TOKENS);
  const estimate = estimateGroups([{ environmentId: ref.environmentId, turns }], prices);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title="Usage" onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          nestedScrollEnabled
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-2"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {shell ? (
            <Text className="px-2 text-sm text-foreground-muted" numberOfLines={1}>
              {shell.title || "Untitled thread"}
            </Text>
          ) : null}
          {context !== null ? <ContextSection usage={context} /> : null}
          {projection === null ? (
            <Text className="py-10 text-center text-base text-foreground-muted">Loading…</Text>
          ) : turns.length === 0 ? (
            <SettingsSection title="Tokens">
              <Text className="px-4 py-6 text-center text-base text-foreground-muted">
                {NO_USAGE_RECORDED}
              </Text>
            </SettingsSection>
          ) : (
            <>
              <UsageTotals tokens={tokens} estimate={estimate} reportedCost={usage?.reportedCost} />
              <SettingsSection title="By turn">
                {[...turns].reverse().map((turn, index) => (
                  <TurnRow key={turn.id} turn={turn} first={index === 0} />
                ))}
              </SettingsSection>
            </>
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}

function TurnRow(props: { readonly turn: TurnUsage; readonly first: boolean }) {
  const { turn } = props;
  const parts = [
    turn.at === null ? null : TIME.format(turn.at),
    turn.model,
    turn.partial ? "partial" : null,
  ].filter((part): part is string => part !== null);
  return (
    <UsageRow
      first={props.first}
      title={`Turn ${turn.ordinal} · ${formatTokens(inputTokens(turn.tokens))} in · ${formatTokens(turn.tokens.output)} out`}
      subtitle={parts.join(" · ")}
      value={formatTokens(totalTokens(turn.tokens))}
    />
  );
}

function ContextSection(props: {
  readonly usage: NonNullable<ReturnType<typeof threadContextWindow>>;
}) {
  const model = contextMeterModel(props.usage);
  const toneColor = useContextToneColor(model.tone);
  const last = model.lastTurn;
  return (
    <SettingsSection title="Context window">
      <View
        className="flex-row items-center gap-4 p-4"
        accessible
        accessibilityLabel={model.accessibilityLabel}
      >
        <ContextRing fill={model.fill} tick={model.tick} tone={model.tone} size={44} />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text
            className="text-xl font-t3-medium tabular-nums text-foreground"
            style={model.tone === "normal" ? undefined : { color: toneColor }}
          >
            {model.usedLabel}
          </Text>
          <Text className="text-sm text-foreground-muted">{model.compactionLabel}</Text>
        </View>
      </View>
      {last !== null ? (
        <View className="flex-row border-t border-border-subtle">
          <LastTurnCell label="Last input" value={last.input} />
          <LastTurnCell label="Cached" value={last.cached} />
          <LastTurnCell label="Output" value={last.output} />
        </View>
      ) : null}
    </SettingsSection>
  );
}

function LastTurnCell(props: { readonly label: string; readonly value: number | null }) {
  return (
    <View className="flex-1 gap-0.5 px-4 py-3">
      <Text className="text-xs text-foreground-muted">{props.label}</Text>
      <Text className="text-base tabular-nums text-foreground">
        {props.value === null ? "None" : formatContextWindowTokens(props.value)}
      </Text>
    </View>
  );
}
