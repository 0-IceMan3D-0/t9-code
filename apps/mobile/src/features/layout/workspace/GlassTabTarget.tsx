import type { ComponentRef, ReactNode, RefObject } from "react";
import type { View } from "react-native";

export type GlassTabTargetRef = RefObject<ComponentRef<typeof View> | null>;

// oxlint-disable-next-line t3code/no-hookless-use-function -- Non-Android stub of a hook; the .android.tsx file holds the real one.
export function useGlassTabTarget(_floatingBar: boolean): GlassTabTargetRef | undefined {
  return undefined;
}

export function GlassTabTarget(props: {
  readonly target: GlassTabTargetRef | undefined;
  readonly children: ReactNode;
}) {
  return props.children;
}
