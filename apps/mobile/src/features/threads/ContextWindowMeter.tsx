import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
  type ContextWindowSnapshot,
} from "@t3tools/client-runtime/state/context-window";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { contextMeterModel, type ContextMeterTone } from "./contextMeter";

/** The thread's context window as web derives it: live turn usage, the provider thread, then compaction. */
export function threadContextWindow(
  projection: ThreadStructure | null | undefined,
): ContextWindowSnapshot | null {
  if (!projection) return null;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  return deriveLatestContextWindowSnapshot(
    projection.visibleTurnItems,
    latestProviderTurnTokenUsage(projection.providerTurns, projection, providerThread),
    providerThread,
  );
}

const TONE_CLASS: Record<ContextMeterTone, string> = {
  normal: "text-foreground-muted",
  warning: "text-warning",
  danger: "text-danger",
};

export function useContextToneColor(tone: ContextMeterTone): string | undefined {
  const color = StyleSheet.flatten(useResolveClassNames(TONE_CLASS[tone]))?.color;
  return typeof color === "string" ? color : undefined;
}

export function ContextRing(props: {
  readonly fill: number | null;
  readonly tick: number | null;
  readonly tone: ContextMeterTone;
  readonly size: number;
}) {
  const color = useContextToneColor(props.tone);
  const track = StyleSheet.flatten(useResolveClassNames("text-border"))?.color;
  const stroke = Math.max(2.5, props.size / 8);
  const radius = (props.size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = props.size / 2;
  const fill = props.fill ?? 0;
  return (
    <Svg width={props.size} height={props.size} style={{ transform: [{ rotate: "-90deg" }] }}>
      <Circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={typeof track === "string" ? track : undefined}
        strokeWidth={stroke}
      />
      {fill > 0 ? (
        <Circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - Math.max(fill, 0.04))}
        />
      ) : null}
      {props.tick !== null ? (
        <Circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeOpacity={0.9}
          strokeWidth={stroke + 2}
          strokeDasharray={`1.5 ${circumference}`}
          strokeDashoffset={-circumference * props.tick}
        />
      ) : null}
    </Svg>
  );
}

/** A small ring beside the composer's send controls; tapping it opens the thread's usage. */
export function ContextWindowMeterButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly size: "regular" | "large";
}) {
  const navigation = useNavigation();
  const structure = useQuietThreadStructure(scopeThreadRef(props.environmentId, props.threadId));
  const snapshot = threadContextWindow(structure?.projection);
  if (snapshot === null) return null;
  const model = contextMeterModel(snapshot);
  return (
    <Pressable
      accessibilityLabel={model.accessibilityLabel}
      accessibilityHint="Opens context and token usage"
      accessibilityRole="button"
      className="size-[44px] shrink-0 items-center justify-center active:opacity-60"
      onPress={() =>
        navigation.navigate("ThreadUsage", {
          environmentId: props.environmentId,
          threadId: props.threadId,
        })
      }
    >
      <View pointerEvents="none">
        <ContextRing
          fill={model.fill}
          tick={model.tick}
          tone={model.tone}
          size={props.size === "large" ? 24 : 20}
        />
      </View>
    </Pressable>
  );
}
