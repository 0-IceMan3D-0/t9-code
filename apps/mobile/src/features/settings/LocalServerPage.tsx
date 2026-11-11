import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { useLocalServerStatus, type LocalServerStatus } from "../local-server/localServerModule";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

/** A This phone page; renders nothing until the built-in server reports its status. */
export function LocalServerPage(props: {
  readonly title: string;
  /** Shows a set-up hint in place of the page until Linux is set up. */
  readonly needsLinux?: boolean;
  readonly children: (status: LocalServerStatus) => ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const status = useLocalServerStatus();
  if (!status) return null;
  return (
    <SettingsScreen title={props.title}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {props.needsLinux && !isSetUp(status) ? <LocalServerSetUpHint /> : props.children(status)}
      </ScrollView>
    </SettingsScreen>
  );
}

export function LocalServerSetUpHint() {
  return (
    <SettingsSection>
      <View className="p-4">
        <Text className="text-sm text-foreground-muted">
          Set up this phone first, on the This phone page.
        </Text>
      </View>
    </SettingsSection>
  );
}

export const isSetUp = (status: LocalServerStatus) =>
  status.linuxInstalled && status.state !== "installing";
