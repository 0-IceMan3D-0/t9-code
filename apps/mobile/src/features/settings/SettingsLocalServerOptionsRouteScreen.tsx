import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { localServer, refreshLocalServerStatus } from "../local-server/localServerModule";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { LocalServerBatterySection } from "./LocalServerBatterySection";
import { LocalServerPage } from "./LocalServerPage";

export function SettingsLocalServerOptionsRouteScreen() {
  const server = localServer;
  if (!server) return null;
  const setOption = (write: () => void) => {
    write();
    refreshLocalServerStatus();
  };
  return (
    <LocalServerPage title="Options">
      {(status) => (
        <>
          <SettingsSection title="Built-in server">
            <SettingsSwitchRow
              label="Start when the app opens"
              subtitle="After a phone restart, it waits until you open the app."
              value={status.startOnAppOpen}
              onValueChange={(value) => setOption(() => server.setStartOnAppOpen(value))}
            />
            <SettingsSwitchRow
              label="Stop when I leave the app"
              subtitle={`Stops ${formatStopAfter(status.stopAfterMinutes)} after you leave, once nothing in Linux is busy.`}
              value={status.stopOnLeave}
              onValueChange={(value) => setOption(() => server.setStopOnLeave(value))}
            />
            {status.stopOnLeave ? (
              <StopAfterRow
                minutes={status.stopAfterMinutes}
                onChange={(minutes) => setOption(() => server.setStopAfterMinutes(minutes))}
              />
            ) : null}
            <SettingsSwitchRow
              label="Shared project folder"
              subtitle="Adds T3Projects in phone storage as /root/shared-projects after a restart."
              value={status.sharedStorage}
              onValueChange={(value) =>
                void (async () => {
                  if (value && !status.sharedStorageGranted) await server.requestStorageAccess();
                  setOption(() => server.setSharedStorage(value));
                })()
              }
            />
          </SettingsSection>
          <LocalServerBatterySection />
        </>
      )}
    </LocalServerPage>
  );
}

const STOP_AFTER_PRESETS = [2, 5, 15, 30, 60] as const;
const MAX_STOP_AFTER_MINUTES = 240;

function StopAfterRow(props: {
  readonly minutes: number;
  readonly onChange: (minutes: number) => void;
}) {
  const preset = (STOP_AFTER_PRESETS as readonly number[]).includes(props.minutes);
  const [custom, setCustom] = useState(!preset);
  const [draft, setDraft] = useState(String(props.minutes));
  const commit = () => {
    const minutes = Math.round(Number(draft));
    if (!Number.isFinite(minutes) || minutes < 1) {
      setDraft(String(props.minutes));
      return;
    }
    const clamped = Math.min(minutes, MAX_STOP_AFTER_MINUTES);
    setDraft(String(clamped));
    props.onChange(clamped);
  };
  return (
    <View className="gap-3 px-4 py-3">
      <Text className="text-foreground text-lg android:text-base">Stop after</Text>
      <SegmentedControl
        variant="card"
        options={[
          ...STOP_AFTER_PRESETS.map((value) => ({
            value: String(value),
            label: value < 60 ? `${value}m` : `${value / 60}h`,
            accessibilityLabel: formatStopAfter(value),
          })),
          { value: "custom", label: "Custom" },
        ]}
        selected={custom ? "custom" : String(props.minutes)}
        onSelect={(value) => {
          if (value === "custom") {
            setDraft(String(props.minutes));
            setCustom(true);
            return;
          }
          setCustom(false);
          props.onChange(Number(value));
        }}
      />
      {custom ? (
        <View className="flex-row items-center gap-3">
          <TextInput
            accessibilityLabel="Minutes before stopping"
            className="w-24 rounded-lg bg-subtle p-3 text-foreground"
            keyboardType="number-pad"
            maxLength={3}
            onBlur={commit}
            onChangeText={setDraft}
            onSubmitEditing={commit}
            returnKeyType="done"
            value={draft}
          />
          <Text className="flex-1 text-sm text-foreground-muted">
            minutes, up to {MAX_STOP_AFTER_MINUTES / 60} hours
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function formatStopAfter(minutes: number): string {
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourText = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return rest === 0 ? hourText : `${hourText} ${rest} min`;
}
