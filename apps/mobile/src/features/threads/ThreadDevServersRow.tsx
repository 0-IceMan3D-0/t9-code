import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useSavedRemoteConnection } from "../../state/use-remote-environment-registry";
import { useDevServers } from "../local-server/devServers";
import { getLocalServerStatus } from "../local-server/localServerModule";

/** Links to web servers in the phone's Linux, on threads of the built-in environment. */
export function ThreadDevServersRow(props: { readonly environmentId: EnvironmentId }) {
  const servers = useDevServers();
  const connection = useSavedRemoteConnection(props.environmentId);
  const port = getLocalServerStatus()?.port;
  const builtIn =
    port !== undefined && connection?.httpBaseUrl.replace(/\/$/, "") === `http://127.0.0.1:${port}`;
  if (!builtIn || servers.length === 0) return null;
  return (
    <View className="flex-row items-center gap-2 pb-2 pl-4">
      <SymbolView name="globe" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="text-xs text-foreground-muted">Web servers</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1">
        <View className="flex-row gap-1 pr-4">
          {servers.map((server) => (
            <Pressable
              key={server.key}
              accessibilityRole="link"
              accessibilityLabel={`Open ${server.address}, ${server.title}`}
              accessibilityHint="Long-press to copy the link"
              className="flex-row items-center rounded-full bg-subtle px-2.5 py-1"
              onPress={() => void tryOpenExternalUrl(server.url, "dev-server")}
              onLongPress={() => void tryCopyTextWithHaptic(server.url, { target: "link" })}
            >
              <Text className="text-xs text-foreground" numberOfLines={1}>
                {`:${server.port} ${server.title}`}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
