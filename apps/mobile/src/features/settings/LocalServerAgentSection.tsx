import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { type AgentToolId, useAgentTool } from "../local-server/localServerModule";
import { SettingsSection } from "./components/SettingsSection";
import { AgentToolRows, agentToolSummary } from "./LocalServerAgentTool";

/** An agent with no sign-in of its own in the app; it signs in through its CLI in Linux. */
export function LocalServerAgentSection(props: {
  readonly id: AgentToolId;
  readonly name: string;
  readonly footer: string;
  readonly removeMessage: string;
}) {
  const tool = useAgentTool(props.id);
  if (!tool) return null;
  return (
    <SettingsSection title={props.name} footer={props.footer}>
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">{agentToolSummary(tool)}</Text>
        {tool.error ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {tool.error}
          </Text>
        ) : null}
      </View>
      <AgentToolRows
        id={props.id}
        name={props.name}
        tool={tool}
        removeMessage={props.removeMessage}
      />
    </SettingsSection>
  );
}
