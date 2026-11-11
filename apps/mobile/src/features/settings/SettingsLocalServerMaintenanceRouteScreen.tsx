import { useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { useConnectionController } from "../connection/useConnectionController";
import { confirmDeleteEnvironment, useLinuxMaintenance } from "../local-server/linuxMaintenance";
import { localServer, useLocalServerStatus } from "../local-server/localServerModule";
import { useLocalConnection } from "../local-server/useLocalConnection";
import { SettingsSection } from "./components/SettingsSection";
import { LocalServerMaintenanceRows } from "./LocalServerMaintenanceRows";
import { LocalServerPage } from "./LocalServerPage";

export function SettingsLocalServerMaintenanceRouteScreen() {
  const maintaining = useLinuxMaintenance()?.state === "running";
  const [log, setLog] = useState<string | null>(null);
  const { removeEnvironment } = useConnectionController();
  const server = localServer;
  const connection = useLocalConnection(useLocalServerStatus()?.port);
  if (!server) return null;

  const reset = () =>
    void confirmDeleteEnvironment(() =>
      server.reset().then(() => {
        if (connection) void removeEnvironment(connection.environmentId);
      }),
    );

  return (
    <LocalServerPage title="Maintenance">
      {(status) => {
        const busy = status.state === "installing" || status.state === "starting";
        return (
          <SettingsSection footer="Keep backups private: they hold sign-ins and SSH keys, but not the shared project folder.">
            <LocalServerMaintenanceRows status={status} />
            {log !== null ? (
              <Text selectable className="p-4 text-xs text-foreground-muted">
                {log || "No log yet."}
              </Text>
            ) : null}
            <SettingsActionRow
              icon="doc.text"
              label={log === null ? "Show log" : "Refresh log"}
              onPress={() => void server.readLog().then(setLog)}
            />
            <SettingsActionRow
              icon="trash"
              label="Delete environment"
              tone="danger"
              disabled={
                status.state === "running" || busy || maintaining || status.state === "notInstalled"
              }
              onPress={reset}
            />
          </SettingsSection>
        );
      }}
    </LocalServerPage>
  );
}
