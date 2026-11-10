import { useNavigation } from "@react-navigation/native";

import { ListRow } from "../../components/ui/ListRow";
import { useLinuxMaintenance } from "../local-server/linuxMaintenance";
import { SettingsSection } from "./components/SettingsSection";
import { LocalServerOllamaSection } from "./LocalServerOllamaSection";
import { isSetUp, LocalServerPage } from "./LocalServerPage";
import { LocalServerPhoneGpuSection } from "./LocalServerPhoneGpuSection";

export function SettingsLocalServerModelsRouteScreen() {
  const navigation = useNavigation();
  const maintaining = useLinuxMaintenance()?.state === "running";
  return (
    <LocalServerPage title="Models">
      {(status) =>
        !isSetUp(status) || maintaining ? null : (
          <>
            <LocalServerPhoneGpuSection serverRunning={status.state === "running"} />
            <LocalServerOllamaSection serverRunning={status.state === "running"} />
            <SettingsSection>
              <ListRow
                icon="slider.horizontal.3"
                label="Model settings"
                description="Context size, threads and memory"
                onPress={() => navigation.navigate("SettingsLocalServerModelSettings")}
              />
            </SettingsSection>
          </>
        )
      }
    </LocalServerPage>
  );
}
