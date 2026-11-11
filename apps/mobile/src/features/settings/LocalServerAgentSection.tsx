import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import {
  type AgentToolId,
  useAgentTool,
  useLocalServerStatus,
} from "../local-server/localServerModule";
import { SettingsSection } from "./components/SettingsSection";
import { AgentToolRows, agentToolSummary } from "./LocalServerAgentTool";

/** An agent with no sign-in of its own in the app; it signs in through its CLI in Linux. */
export function LocalServerAgentSection(props: {
  readonly id: AgentToolId;
  readonly name: string;
  readonly footer: string;
  readonly removeMessage: string;
  /** Rows shown above Update and Remove while the agent is installed. */
  readonly children?: ReactNode;
}) {
  const tool = useAgentTool(props.id);
  const running = useLocalServerStatus()?.state === "running";
  if (!tool) return null;
  // Installing also turns the agent's provider on, which needs the running server.
  const canInstall = tool.installed || running;
  return (
    <SettingsSection title={props.name} footer={props.footer}>
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">{agentToolSummary(tool)}</Text>
        {canInstall ? null : (
          <Text className="text-sm text-foreground-muted">
            Start the built-in server to install.
          </Text>
        )}
        {tool.error ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {tool.error}
          </Text>
        ) : null}
      </View>
      {tool.installed ? props.children : null}
      {canInstall ? (
        <AgentToolRows
          id={props.id}
          name={props.name}
          tool={tool}
          removeMessage={props.removeMessage}
        />
      ) : null}
    </SettingsSection>
  );
}
