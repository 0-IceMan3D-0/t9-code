import { deriveLatestContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { contextMeterModel } from "./contextMeter";

const updatedAt = DateTime.makeUnsafe("2026-11-08T10:00:00Z");

function snapshot(contextUsage: Record<string, unknown>) {
  const result = deriveLatestContextWindowSnapshot([], null, {
    contextUsage: { usedTokens: 0, ...contextUsage },
    updatedAt,
  } as never);
  if (result === null) throw new Error("no snapshot");
  return result;
}

describe("contextMeterModel", () => {
  it("counts down to the auto-compaction point and warns as it nears", () => {
    const model = contextMeterModel(
      snapshot({
        usedTokens: 142_000,
        maxTokens: 200_000,
        compactsAutomatically: true,
        autoCompactThreshold: 160_000,
        lastInputTokens: 3_000,
        lastCachedInputTokens: 139_000,
        lastOutputTokens: 900,
      }),
    );
    expect(model).toMatchObject({
      usedLabel: "142k / 200k",
      compactionLabel: "Compacts at 160k · about 18k left",
      fill: 0.71,
      tick: 0.8,
      tone: "warning",
      lastTurn: { input: 3_000, cached: 139_000, output: 900 },
      accessibilityLabel: "Context window, 71% used",
    });
    expect(
      contextMeterModel(
        snapshot({ usedTokens: 150_000, maxTokens: 200_000, autoCompactThreshold: 160_000 }),
      ).tone,
    ).toBe("danger");
  });

  it("measures against the whole window when the provider does not compact", () => {
    const model = contextMeterModel(
      snapshot({
        usedTokens: 160_000,
        maxTokens: 200_000,
        compactsAutomatically: false,
        autoCompactThreshold: 160_000,
      }),
    );
    expect(model).toMatchObject({
      compactionLabel: "Doesn't compact automatically",
      tick: null,
      tone: "warning",
      lastTurn: null,
    });
    expect(
      contextMeterModel(
        snapshot({ usedTokens: 190_000, maxTokens: 200_000, compactsAutomatically: false }),
      ).tone,
    ).toBe("danger");
  });

  it("shows bare usage without a known window size", () => {
    expect(contextMeterModel(snapshot({ usedTokens: 9_500 }))).toMatchObject({
      fill: null,
      tone: "normal",
      usedLabel: "9.5k",
      compactionLabel: "Compaction not reported",
    });
  });
});
