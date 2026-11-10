import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useLinuxMaintenance } from "../local-server/linuxMaintenance";
import { SettingsSection } from "./components/SettingsSection";
import { LocalServerClaudeSection } from "./LocalServerClaudeSection";
import { LocalServerOpenCodeSection } from "./LocalServerOpenCodeSection";
import { isSetUp, LocalServerPage } from "./LocalServerPage";

export function SettingsLocalServerAgentsRouteScreen() {
  const maintaining = useLinuxMaintenance()?.state === "running";
  return (
    <LocalServerPage title="Agents">
      {(status) =>
        !isSetUp(status) || maintaining ? null : (
          <>
            {status.state === "running" ? (
              <LocalServerClaudeSection />
            ) : (
              <SettingsSection title="Claude Code">
                <View className="p-4">
                  <Text className="text-sm text-foreground-muted">
                    Start the built-in server to install or sign in.
                  </Text>
                </View>
              </SettingsSection>
            )}
            <LocalServerOpenCodeSection />
          </>
        )
      }
    </LocalServerPage>
  );
}
