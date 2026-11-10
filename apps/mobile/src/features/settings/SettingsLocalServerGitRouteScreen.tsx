import { useLinuxMaintenance } from "../local-server/linuxMaintenance";
import { LocalServerGitSection } from "./LocalServerGitSection";
import { isSetUp, LocalServerPage } from "./LocalServerPage";

export function SettingsLocalServerGitRouteScreen() {
  const maintaining = useLinuxMaintenance()?.state === "running";
  return (
    <LocalServerPage title="Git and GitHub">
      {(status) => (!isSetUp(status) || maintaining ? null : <LocalServerGitSection />)}
    </LocalServerPage>
  );
}
