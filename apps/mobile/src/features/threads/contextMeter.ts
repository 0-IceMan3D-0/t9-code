import {
  formatContextWindowTokens,
  type ContextWindowSnapshot,
} from "@t3tools/client-runtime/state/context-window";

export type ContextMeterTone = "normal" | "warning" | "danger";

export interface ContextMeterModel {
  /** Ring fill from 0 to 1 of the whole window; null without a known window size. */
  readonly fill: number | null;
  /** Compaction point on the ring from 0 to 1, when it sits inside the window. */
  readonly tick: number | null;
  readonly tone: ContextMeterTone;
  /** "142k / 200k", or "142k" without a known window size. */
  readonly usedLabel: string;
  readonly compactionLabel: string;
  readonly lastTurn: {
    readonly input: number | null;
    readonly cached: number | null;
    readonly output: number | null;
  } | null;
  readonly accessibilityLabel: string;
}

// Warn ahead of the point that matters: compaction when it is automatic, otherwise a full window.
const WARNING_SHARE = 0.75;
const DANGER_SHARE = 0.9;

export function contextMeterModel(usage: ContextWindowSnapshot): ContextMeterModel {
  const maxTokens = usage.maxTokens ?? null;
  const max = maxTokens !== null && maxTokens > 0 ? maxTokens : null;
  const autoCompactThreshold = usage.autoCompactThreshold ?? null;
  const threshold =
    usage.compactsAutomatically !== false &&
    autoCompactThreshold !== null &&
    autoCompactThreshold > 0
      ? autoCompactThreshold
      : null;
  const used = Math.max(0, usage.usedTokens);
  const limit = threshold ?? max;
  const share = limit === null ? null : used / limit;
  const tone: ContextMeterTone =
    share === null
      ? "normal"
      : share >= DANGER_SHARE
        ? "danger"
        : share >= WARNING_SHARE
          ? "warning"
          : "normal";
  const usedLabel =
    max === null
      ? formatContextWindowTokens(used)
      : `${formatContextWindowTokens(used)} / ${formatContextWindowTokens(max)}`;
  let compactionLabel: string;
  if (usage.compactsAutomatically === false) {
    compactionLabel = "Doesn't compact automatically";
  } else if (threshold !== null) {
    const left = Math.max(0, threshold - used);
    compactionLabel =
      left === 0
        ? `Compacts at ${formatContextWindowTokens(threshold)} · due now`
        : `Compacts at ${formatContextWindowTokens(threshold)} · about ${formatContextWindowTokens(left)} left`;
  } else if (usage.compactsAutomatically === true) {
    compactionLabel = "Compacts automatically when needed";
  } else {
    compactionLabel = "Compaction not reported";
  }
  const last = {
    input: usage.lastInputTokens ?? null,
    cached: usage.lastCachedInputTokens ?? null,
    output: usage.lastOutputTokens ?? null,
  };
  const lastTurn =
    last.input === null && last.cached === null && last.output === null ? null : last;
  const percent = max === null ? null : Math.round((used / max) * 100);
  return {
    fill: max === null ? null : Math.min(1, used / max),
    tick: max !== null && threshold !== null && threshold < max ? threshold / max : null,
    tone,
    usedLabel,
    compactionLabel,
    lastTurn,
    accessibilityLabel:
      percent === null
        ? `Context window, ${formatContextWindowTokens(used)} tokens used`
        : `Context window, ${percent}% used`,
  };
}
