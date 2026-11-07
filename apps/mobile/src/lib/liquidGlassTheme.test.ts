import { describe, expect, it } from "vite-plus/test";

import { androidGlassTabColors } from "../features/layout/workspace/android-workspace-navigation-colors";
import {
  flattenThemeColor,
  isMobileThemeAvailable,
  mobileThemePaletteId,
  themeColorContrastRatio,
} from "./mobileTheme";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";
import { createNativeThemeColors } from "./nativeTheme";

describe("Liquid Glass theme", () => {
  it.each(["light", "dark"] as const)("keeps %s labels legible", (appearance) => {
    const variables = getMobileThemeRuntimeVariables("liquid-glass", appearance, "android");
    const screen = variables["--color-screen"];
    const native = createNativeThemeColors(variables);
    for (const surface of [native.surface, native.surfaceContainer, native.surfaceContainerHigh]) {
      expect(themeColorContrastRatio(native.onSurface, surface)).toBeGreaterThanOrEqual(4.5);
    }
    for (const [text, surface] of [
      ["--color-primary-foreground", "--color-primary"],
      ["--color-user-bubble-foreground", "--color-user-bubble"],
      ["--color-foreground-muted", "--color-grouped-card"],
      ["--color-primary-text", "--color-screen"],
    ] as const) {
      const flattened = flattenThemeColor(variables[surface], screen);
      expect(themeColorContrastRatio(variables[text], flattened), text).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["light", "dark"] as const)("keeps %s tab icons visible at rest", (appearance) => {
    const variables = getMobileThemeRuntimeVariables("liquid-glass", appearance, "android");
    const tabs = androidGlassTabColors(variables);
    const pill = flattenThemeColor(tabs.tintColor, variables["--color-screen"]);
    const indicator = flattenThemeColor(tabs.indicatorColor, pill);
    expect(themeColorContrastRatio(tabs.unselectedColor, pill)).toBeGreaterThanOrEqual(3);
    expect(themeColorContrastRatio(tabs.selectedColor, indicator)).toBeGreaterThanOrEqual(3);
  });

  it("is offered on Android only and reuses the default palette", () => {
    expect(isMobileThemeAvailable("liquid-glass", "android", false)).toBe(true);
    expect(isMobileThemeAvailable("liquid-glass", "ios", true)).toBe(false);
    expect(mobileThemePaletteId("liquid-glass")).toBe("t3-code");
  });
});
