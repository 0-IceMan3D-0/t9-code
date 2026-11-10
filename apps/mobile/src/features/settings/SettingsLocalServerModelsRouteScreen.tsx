import { useLinuxMaintenance } from "../local-server/linuxMaintenance";
import { LocalServerOllamaSection } from "./LocalServerOllamaSection";
import { isSetUp, LocalServerPage } from "./LocalServerPage";
import { LocalServerPhoneGpuSection } from "./LocalServerPhoneGpuSection";

export function SettingsLocalServerModelsRouteScreen() {
  const maintaining = useLinuxMaintenance()?.state === "running";
  return (
    <LocalServerPage title="Models">
      {(status) =>
        !isSetUp(status) || maintaining ? null : (
          <>
            <LocalServerPhoneGpuSection serverRunning={status.state === "running"} />
            <LocalServerOllamaSection serverRunning={status.state === "running"} />
          </>
        )
      }
    </LocalServerPage>
  );
}
