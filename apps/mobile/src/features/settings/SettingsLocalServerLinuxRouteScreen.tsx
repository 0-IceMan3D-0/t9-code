import { useNavigation } from "@react-navigation/native";

import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { useLinuxMaintenance } from "../local-server/linuxMaintenance";
import { SettingsSection } from "./components/SettingsSection";
import { LocalServerDevServersSection } from "./LocalServerDevServersSection";
import { LocalServerPage } from "./LocalServerPage";
import { LocalServerUsbSection } from "./LocalServerUsbSection";

export function SettingsLocalServerLinuxRouteScreen() {
  const navigation = useNavigation();
  const maintaining = useLinuxMaintenance()?.state === "running";
  return (
    <LocalServerPage title="Linux" needsLinux>
      {() => (
        <>
          <SettingsSection>
            <SettingsActionRow
              icon="terminal"
              label="Open Linux shell"
              disabled={maintaining}
              onPress={() => navigation.navigate("LinuxShell")}
            />
            <SettingsActionRow
              icon="folder"
              label="Browse files"
              disabled={maintaining}
              onPress={() => navigation.navigate("LocalFileExplorer", { volume: "linux" })}
            />
            <ListRow
              icon="arrow.triangle.branch"
              label="Git and GitHub"
              description="Identity and SSH key"
              disabled={maintaining}
              onPress={() => navigation.navigate("SettingsLocalServerGit")}
            />
          </SettingsSection>
          <LocalServerDevServersSection />
          <LocalServerUsbSection />
        </>
      )}
    </LocalServerPage>
  );
}
