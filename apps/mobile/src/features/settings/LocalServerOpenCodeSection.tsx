import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useAgentTool } from "../local-server/localServerModule";
import { SettingsSection } from "./components/SettingsSection";
import { AgentToolRows, agentToolSummary } from "./LocalServerAgentTool";

export function LocalServerOpenCodeSection() {
  const openCode = useAgentTool("opencode");
  if (!openCode) return null;
  return (
    <SettingsSection
      title="OpenCode"
      footer="Pick OpenCode in a thread's model picker. Its free models work without an account; to add your own providers, run opencode auth login in the Linux shell. The phone's Ollama and GPU models are listed in OpenCode too."
    >
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">{agentToolSummary(openCode)}</Text>
        {openCode.error ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {openCode.error}
          </Text>
        ) : null}
      </View>
      <AgentToolRows
        id="opencode"
        name="OpenCode"
        tool={openCode}
        removeMessage="Its settings and sign-ins stay, so installing it again picks them up."
      />
    </SettingsSection>
  );
}
