import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type AgentToolId,
  type AgentToolState,
  localServer,
  useLocalServerStatus,
} from "../local-server/localServerModule";
import { useLocalConnection } from "../local-server/useLocalConnection";

/** The built-in server's provider that runs each tool. */
const PROVIDERS: Record<AgentToolId, { readonly instanceId: string; readonly driver: string }> = {
  opencode: { instanceId: "opencode", driver: "opencode" },
  claude: { instanceId: "claudeAgent", driver: "claudeAgent" },
  pi: { instanceId: "pi", driver: "pi" },
};

/** The server checks providers on a timer; this shows a change at once. */
export function useRefreshAgentProvider(id: AgentToolId) {
  const status = useLocalServerStatus();
  const connection = useLocalConnection(status?.state === "running" ? status.port : undefined);
  const environmentId = connection?.environmentId ?? null;
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  return async () => {
    if (environmentId === null) return;
    const instanceId = ProviderInstanceId.make(PROVIDERS[id].instanceId);
    await refresh({ environmentId, input: { instanceId, refreshModels: true } });
  };
}

export function agentToolSummary(tool: AgentToolState): string {
  if (tool.busy !== null) return tool.detail ?? tool.busy;
  if (!tool.installed) return "Not installed";
  return `Installed${tool.version ? ` · ${tool.version}` : ""}`;
}

/** Install, Update and Remove for an agent CLI in Linux, and the provider that runs it. */
export function AgentToolRows(props: {
  readonly id: AgentToolId;
  readonly name: string;
  readonly tool: AgentToolState;
  readonly removeMessage: string;
}) {
  const status = useLocalServerStatus();
  const connection = useLocalConnection(status?.state === "running" ? status.port : undefined);
  const environmentId = connection?.environmentId ?? null;
  const config = useEnvironmentServerConfig(environmentId);
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance);
  const refreshProvider = useRefreshAgentProvider(props.id);
  const server = localServer;
  if (!server) return null;
  const { id, name, tool } = props;
  const instanceId = ProviderInstanceId.make(PROVIDERS[id].instanceId);

  // OpenCode and Pi are off on a new server, so installing a tool from here turns its provider on too.
  const install = async () => {
    await server.installAgentTool(id);
    if (environmentId === null || !server.agentToolState(id).installed) return;
    const current = config?.settings.providerInstances[instanceId];
    if (current?.enabled !== true) {
      await mutate({
        environmentId,
        input: {
          patch: {},
          providerInstanceMutation: {
            operation: current ? "upsert" : "create",
            instanceId,
            instance: {
              ...current,
              driver: ProviderDriverKind.make(PROVIDERS[id].driver),
              enabled: true,
            },
          },
        },
      });
    }
    await refreshProvider();
  };

  if (!tool.installed) {
    return (
      <SettingsActionRow
        icon="arrow.down.circle"
        label={`Install ${name}`}
        loading={tool.busy === "Installing"}
        disabled={tool.busy !== null}
        onPress={() => void install()}
      />
    );
  }
  return (
    <>
      <SettingsActionRow
        icon="arrow.down.circle"
        label={`Update ${name}`}
        description="Installs the newest release"
        loading={tool.busy === "Updating"}
        disabled={tool.busy !== null}
        onPress={() => void server.updateAgentTool(id).then(refreshProvider)}
      />
      <SettingsActionRow
        icon="trash"
        label={`Remove ${name}`}
        loading={tool.busy === "Removing"}
        disabled={tool.busy !== null}
        onPress={() =>
          Dialog.confirm({
            title: `Remove ${name}?`,
            message: props.removeMessage,
            confirmText: "Remove",
            destructive: true,
            onConfirm: () => void server.removeAgentTool(id).then(refreshProvider),
          })
        }
      />
    </>
  );
}
