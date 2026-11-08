import { useIsFocused } from "@react-navigation/native";
import { useEffect } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { RowPressable } from "../../components/ui/RowPressable";
import { useAppActive } from "../../lib/appState";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { CopyTextButton } from "../threads/CopyTextButton";
import { loadDevServerPageTitles, useDevServers, type DevServer } from "../local-server/devServers";
import { SettingsSection } from "./components/SettingsSection";

function DevServerRow({ server }: { readonly server: DevServer }) {
  return (
    <RowPressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${server.address}`}
      onPress={() => void tryOpenExternalUrl(server.url, "dev-server")}
      className="bg-grouped-card"
    >
      <ListRowLayout
        icon="globe"
        label={server.title}
        description={`${server.address} · ${server.command}`}
        detail="Open"
        accessory={<CopyTextButton accessibilityLabel="Copy link" text={server.url} />}
      />
    </RowPressable>
  );
}

/** Servers that programs in Linux are listening with, such as an agent's `vite`. */
export function LocalServerDevServersSection() {
  const servers = useDevServers();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const visible = focused && appActive;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reads each new server's page title over HTTP while the list is on screen.
  useEffect(() => {
    if (visible) loadDevServerPageTitles(servers);
  }, [visible, servers]);
  return (
    <SettingsSection
      title="Running web servers"
      footer="Web servers started in Linux, by you or an agent. Links work only on this phone."
    >
      {servers.length === 0 ? (
        <View className="p-4">
          <Text className="text-sm text-foreground-muted">
            None running. Start one in the Linux shell, such as python3 -m http.server 8000.
          </Text>
        </View>
      ) : (
        servers.map((server) => <DevServerRow key={server.key} server={server} />)
      )}
    </SettingsSection>
  );
}
