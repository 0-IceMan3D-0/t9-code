import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { localServer, useLocalServerStatus, useOpenCode } from "../local-server/localServerModule";
import { useLocalConnection } from "../local-server/useLocalConnection";
import { SettingsSection } from "./components/SettingsSection";

const OPENCODE_INSTANCE = ProviderInstanceId.make("opencode");

export function LocalServerOpenCodeSection() {
  const openCode = useOpenCode();
  const status = useLocalServerStatus();
  const connection = useLocalConnection(status?.state === "running" ? status.port : undefined);
  const environmentId = connection?.environmentId ?? null;
  const config = useEnvironmentServerConfig(environmentId);
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance);
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const server = localServer;
  if (!server || !openCode) return null;

  // OpenCode is off on a new server, so installing it from here turns it on too.
  const install = async () => {
    await server.installOpenCode();
    if (environmentId === null || !server.openCodeState().installed) return;
    const current = config?.settings.providerInstances[OPENCODE_INSTANCE];
    if (current?.enabled !== true) {
      await mutate({
        environmentId,
        input: {
          patch: {},
          providerInstanceMutation: {
            operation: current ? "upsert" : "create",
            instanceId: OPENCODE_INSTANCE,
            instance: { ...current, driver: ProviderDriverKind.make("opencode"), enabled: true },
          },
        },
      });
    }
    await refresh({ environmentId, input: { instanceId: OPENCODE_INSTANCE, refreshModels: true } });
  };

  const summary =
    openCode.busy !== null
      ? (openCode.detail ?? openCode.busy)
      : openCode.installed
        ? `Installed${openCode.version ? ` · ${openCode.version}` : ""}`
        : "Not installed";

  return (
    <SettingsSection
      title="OpenCode"
      footer="Pick OpenCode in a thread's model picker. Its free models work without an account; to add your own providers, run opencode auth login in the Linux shell. The phone's Ollama and GPU models are listed in OpenCode too."
    >
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">{summary}</Text>
        {openCode.error ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {openCode.error}
          </Text>
        ) : null}
      </View>
      <SettingsActionRow
        icon="arrow.down.circle"
        label={openCode.installed ? "Update OpenCode" : "Install OpenCode"}
        loading={openCode.busy === "Installing"}
        disabled={openCode.busy !== null}
        onPress={() => void install()}
      />
      {openCode.installed ? (
        <SettingsActionRow
          icon="trash"
          label="Remove OpenCode"
          loading={openCode.busy === "Removing"}
          disabled={openCode.busy !== null}
          onPress={() =>
            Dialog.confirm({
              title: "Remove OpenCode?",
              message: "Its settings and sign-ins stay, so installing it again picks them up.",
              confirmText: "Remove",
              destructive: true,
              onConfirm: () => void server.removeOpenCode(),
            })
          }
        />
      ) : null}
    </SettingsSection>
  );
}
