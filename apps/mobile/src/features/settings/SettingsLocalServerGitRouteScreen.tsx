import { useLinuxMaintenance } from "../local-server/linuxMaintenance";
import { LocalServerGitSection } from "./LocalServerGitSection";
import { LocalServerPage } from "./LocalServerPage";

export function SettingsLocalServerGitRouteScreen() {
  const maintaining = useLinuxMaintenance()?.state === "running";
  return (
    <LocalServerPage title="Git and GitHub" needsLinux>
      {() => (maintaining ? null : <LocalServerGitSection />)}
    </LocalServerPage>
  );
}
