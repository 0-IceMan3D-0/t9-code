import { Platform } from "react-native";

import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { vendorGuideUrl, vendorName } from "../local-server/batteryGuidance";
import {
  openBatterySettings,
  openVendorGuide,
  useBatteryState,
} from "../local-server/batteryOptimization";
import { SettingsSection } from "./components/SettingsSection";

const manufacturer = Platform.OS === "android" ? Platform.constants.Manufacturer : undefined;
const guide = vendorGuideUrl(manufacturer);

/** Shows whether Android may stop the server in the background, and opens its own prompt. */
export function LocalServerBatterySection() {
  const battery = useBatteryState();
  if (!battery) return null;
  return (
    <SettingsSection
      title="Running in the background"
      footer={
        guide
          ? undefined
          : "Some phones have their own battery settings too; look for T3² Code under Battery."
      }
    >
      <SettingsActionRow
        icon="bolt.circle"
        label={battery.optimized ? "Allow background use" : "Background use allowed"}
        description={
          battery.optimized
            ? "Battery optimisation is on. Android may stop agents while the app is closed."
            : "Battery optimisation is off for this app."
        }
        detail={battery.optimized ? undefined : "Change"}
        onPress={openBatterySettings}
      />
      {guide ? (
        <SettingsActionRow
          icon="safari"
          label={`Battery tips for ${vendorName(manufacturer)} phones`}
          description="dontkillmyapp.com"
          onPress={() => openVendorGuide(guide)}
        />
      ) : null}
    </SettingsSection>
  );
}
