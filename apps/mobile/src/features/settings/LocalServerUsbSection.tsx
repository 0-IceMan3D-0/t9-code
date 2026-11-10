import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { localServer, useUsbDevices } from "../local-server/localServerModule";
import { SettingsSection } from "./components/SettingsSection";

const usbId = (value: number) => value.toString(16).padStart(4, "0");

export function LocalServerUsbSection() {
  const devices = useUsbDevices();
  return (
    <SettingsSection
      title="USB devices"
      footer="Allowed devices work with adb, fastboot, lsusb and other USB tools in Linux."
    >
      {devices.length === 0 ? (
        <View className="p-4">
          <Text className="text-sm text-foreground-muted">
            Nothing attached. Connect a device with a USB OTG adapter or cable.
          </Text>
        </View>
      ) : (
        devices.map((device) => (
          <SettingsActionRow
            key={device.name}
            icon="cable.connector"
            label={device.label}
            description={`${usbId(device.vendorId)}:${usbId(device.productId)}`}
            detail={device.allowed ? "Allowed" : "Allow"}
            disabled={device.allowed}
            onPress={() => localServer?.allowUsbDevice(device.name)}
          />
        ))
      )}
    </SettingsSection>
  );
}
