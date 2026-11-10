import type { ReactNode } from "react";
import { ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLocalServerStatus, type LocalServerStatus } from "../local-server/localServerModule";
import { SettingsScreen } from "./components/SettingsScreen";

/** A This phone page; renders nothing until the built-in server reports its status. */
export function LocalServerPage(props: {
  readonly title: string;
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
        {props.children(status)}
      </ScrollView>
    </SettingsScreen>
  );
}

export const isSetUp = (status: LocalServerStatus) =>
  status.state !== "notInstalled" && status.state !== "installing";
