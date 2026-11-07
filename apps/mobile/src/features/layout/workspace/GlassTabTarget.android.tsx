import { useRef, type ComponentRef, type ReactNode } from "react";
import { View } from "react-native";

import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import type { GlassTabTargetRef } from "./GlassTabTarget";

/** Undefined keeps the bar opaque and leaves other themes without a blur target in their tree. */
export function useGlassTabTarget(floatingBar: boolean): GlassTabTargetRef | undefined {
  const { themeId } = useAppearancePreferences();
  const target = useRef<ComponentRef<typeof View>>(null);
  return floatingBar && themeId === "liquid-glass" ? target : undefined;
}

export function GlassTabTarget({
  target,
  children,
}: {
  readonly target: GlassTabTargetRef | undefined;
  readonly children: ReactNode;
}) {
  if (!target) return children;
  return (
    <View collapsable={false} ref={target} style={{ flex: 1 }}>
      {children}
    </View>
  );
}
