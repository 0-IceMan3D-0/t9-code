import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { useConnectionController } from "../connection/useConnectionController";
import { offerBatteryExemption } from "../local-server/batteryOptimization";
import { useLinuxMaintenance } from "../local-server/linuxMaintenance";
import {
  localServer,
  useAgentTool,
  useLocalServerStatus,
  useOllama,
  usePhoneModels,
  type LocalServerStatus,
} from "../local-server/localServerModule";
import { useLocalConnection } from "../local-server/useLocalConnection";
import { pairEnvironment } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "./components/SettingsSection";
import { LocalServerHealthSection } from "./LocalServerHealthSection";
import { isSetUp, LocalServerPage } from "./LocalServerPage";
import { formatStopAfter } from "./SettingsLocalServerOptionsRouteScreen";
const STATE_LABELS: Record<LocalServerStatus["state"], string> = {
  notInstalled: "Not set up",
  installing: "Setting up",
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  failed: "Failed",
};

/** A saved connection to a wiped environment has a stale id, so it is replaced rather than kept. */
async function pairLocalServer(
  port: number | undefined,
  savedEnvironmentId: EnvironmentId | undefined,
  removeEnvironment: (environmentId: EnvironmentId) => unknown,
): Promise<string | null> {
  const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`);
  const { environmentId } = (await response.json()) as { readonly environmentId: EnvironmentId };
  if (savedEnvironmentId === environmentId) return null;
  const pairingUrl = localServer?.takePairingUrl();
  if (!pairingUrl) return null;
  if (savedEnvironmentId) await removeEnvironment(savedEnvironmentId);
  return (await pairEnvironment(pairingUrl)).error;
}

export function SettingsLocalServerRouteScreen() {
  const navigation = useNavigation();
  const status = useLocalServerStatus();
  const maintenance = useLinuxMaintenance();
  const connection = useLocalConnection(status?.port);
  const { removeEnvironment } = useConnectionController();
  const [pairingError, setPairingError] = useState<string | null>(null);
  const claude = useAgentTool("claude");
  const openCode = useAgentTool("opencode");
  const pi = useAgentTool("pi");
  const phone = usePhoneModels();
  const ollama = useOllama();

  const state = status?.state;
  const port = status?.port;
  const savedEnvironmentId = connection?.environmentId;
  const connected = connection !== undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Pairs with the server once it reports ready.
  useEffect(() => {
    if (state !== "running") return;
    void pairLocalServer(port, savedEnvironmentId, removeEnvironment).then(setPairingError);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- removeEnvironment is new each render.
  }, [state, port, savedEnvironmentId]);

  const server = localServer;
  if (!server) return null;

  const agents = [
    claude?.installed ? "Claude Code" : null,
    openCode?.installed ? "OpenCode" : null,
    pi?.installed ? "Pi" : null,
  ].filter((name) => name !== null);
  const models = (phone?.installed.length ?? 0) + (ollama?.models.length ?? 0);

  return (
    <LocalServerPage title="This phone">
      {(status) => {
        const busy = status.state === "installing" || status.state === "starting";
        const running = status.state === "running";
        return (
          <>
            <SettingsSection title="Built-in server">
              <View className="gap-1 p-4">
                <Text className="text-base text-foreground">{STATE_LABELS[status.state]}</Text>
                {status.detail ? (
                  <Text selectable className="text-sm text-foreground-muted" numberOfLines={3}>
                    {status.state === "installing"
                      ? `${Math.round(status.progress * 100)}% · ${status.detail}`
                      : status.detail}
                  </Text>
                ) : null}
                {running ? (
                  <Text className="text-sm text-foreground-muted">
                    {connected ? "Connected to this app." : "Connecting to this app…"}
                  </Text>
                ) : null}
                {pairingError ? (
                  <Text
                    selectable
                    accessibilityRole="alert"
                    className="text-sm text-danger-foreground"
                  >
                    {pairingError}
                  </Text>
                ) : null}
              </View>
              {running || busy ? (
                <SettingsActionRow icon="stop.fill" label="Stop" onPress={() => server.stop()} />
              ) : (
                <SettingsActionRow
                  icon="arrow.clockwise"
                  label={status.linuxInstalled ? "Start" : "Set up (about 500 MB download)"}
                  disabled={maintenance?.state === "running"}
                  onPress={() => {
                    server.start();
                    offerBatteryExemption();
                  }}
                />
              )}
            </SettingsSection>

            <SettingsSection>
              {isSetUp(status) ? (
                <>
                  <ListRow
                    icon="sparkles"
                    label="Agents"
                    description={
                      agents.length > 0 ? agents.join(", ") : "Claude Code, OpenCode and Pi"
                    }
                    onPress={() => navigation.navigate("SettingsLocalServerAgents")}
                  />
                  <ListRow
                    icon="brain"
                    label="Models"
                    description={
                      models > 0
                        ? `${models} ${models === 1 ? "model" : "models"} downloaded`
                        : "Phone GPU and Ollama"
                    }
                    onPress={() => navigation.navigate("SettingsLocalServerModels")}
                  />
                  <ListRow
                    icon="terminal"
                    label="Linux"
                    description="Shell, files, Git, web servers and USB"
                    onPress={() => navigation.navigate("SettingsLocalServerLinux")}
                  />
                </>
              ) : null}
              <ListRow
                icon="slider.horizontal.3"
                label="Options"
                description={[
                  status.startOnAppOpen ? "Starts with the app" : "Starts when you tap Start",
                  status.stopOnLeave
                    ? `stops ${formatStopAfter(status.stopAfterMinutes)} after you leave`
                    : "keeps running",
                ].join(" · ")}
                onPress={() => navigation.navigate("SettingsLocalServerOptions")}
              />
              <ListRow
                icon="hammer"
                label="Maintenance"
                description={
                  maintenance?.state === "running"
                    ? "Backup or restore running"
                    : "Back up, restore and reset Linux"
                }
                onPress={() => navigation.navigate("SettingsLocalServerMaintenance")}
              />
            </SettingsSection>

            {isSetUp(status) ? <LocalServerHealthSection /> : null}
          </>
        );
      }}
    </LocalServerPage>
  );
}
