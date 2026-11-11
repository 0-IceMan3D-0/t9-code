import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useLinuxMaintenance } from "../local-server/linuxMaintenance";
import { SettingsSection } from "./components/SettingsSection";
import { LocalServerAgentSection } from "./LocalServerAgentSection";
import { LocalServerClaudeSection } from "./LocalServerClaudeSection";
import { LocalServerPage } from "./LocalServerPage";
import { PiSignInRows } from "./LocalServerPiSignIn";

export function SettingsLocalServerAgentsRouteScreen() {
  const maintaining = useLinuxMaintenance()?.state === "running";
  return (
    <LocalServerPage title="Agents" needsLinux>
      {(status) =>
        maintaining ? null : (
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
            <LocalServerAgentSection
              id="opencode"
              name="OpenCode"
              footer="Free models work without an account; to add your own providers, run opencode auth login in the Linux shell."
              removeMessage="Its settings and sign-ins stay, so installing it again picks them up."
            />
            <LocalServerAgentSection
              id="pi"
              name="Pi"
              footer="A lighter agent for phones with less memory; it also runs the phone's Ollama and Phone GPU models."
              removeMessage="Its settings and sign-ins stay, so installing it again picks them up."
            >
              <PiSignInRows />
            </LocalServerAgentSection>
          </>
        )
      }
    </LocalServerPage>
  );
}
