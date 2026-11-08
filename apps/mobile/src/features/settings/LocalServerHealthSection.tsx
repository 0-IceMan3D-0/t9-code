import { useIsFocused } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { useAppActive } from "../../lib/appState";
import {
  localServer,
  type HealthSample,
  type StorageSample,
} from "../local-server/localServerModule";
import {
  cpuPercent,
  describeCpu,
  describeMemory,
  describeStorage,
  healthWarning,
} from "../local-server/serverHealth";
import { SettingsSection } from "./components/SettingsSection";

const SAMPLE_MILLIS = 3_000;
const STORAGE_MILLIS = 60_000;

interface Health {
  readonly sample: HealthSample;
  readonly cpu: number | null;
}

function useServerHealth(active: boolean) {
  const [health, setHealth] = useState<Health | null>(null);
  const [storage, setStorage] = useState<StorageSample | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Polls /proc through the native module only while this screen is visible.
  useEffect(() => {
    const server = localServer;
    if (!active || !server) return;
    let previous: HealthSample | null = null;
    let stopped = false;
    let measuring = false;
    let measuredAt = -Infinity;
    const tick = () => {
      void server.sampleHealth().then((next) => {
        if (stopped) return;
        const cpu = cpuPercent(previous, next);
        previous = next;
        setHealth({ sample: next, cpu });
        // Walking the rootfs costs a few seconds of I/O, so storage refreshes far less often.
        if (measuring || next.at - measuredAt < STORAGE_MILLIS) return;
        measuring = true;
        measuredAt = next.at;
        void server.measureStorage().then((value) => {
          measuring = false;
          if (!stopped) setStorage(value);
        });
      });
    };
    tick();
    const timer = setInterval(tick, SAMPLE_MILLIS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active]);
  return { health, storage };
}

/** Live memory, CPU and storage of the built-in environment, with a low-memory warning. */
export function LocalServerHealthSection() {
  const focused = useIsFocused();
  const appActive = useAppActive();
  const { health, storage } = useServerHealth(focused && appActive);
  if (!health) return null;
  const warning = healthWarning(health.sample);
  return (
    <SettingsSection
      title="Health"
      footer="Updates every few seconds while this screen is open. Memory counts the server, shells and agents running in Linux."
    >
      {warning ? (
        <View className="p-4">
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {warning}
          </Text>
        </View>
      ) : null}
      <ListRowLayout icon="cube" label="Memory" description={describeMemory(health.sample)} />
      <ListRowLayout
        icon="chart.bar.xaxis"
        label="CPU"
        description={describeCpu(health.cpu, health.sample)}
      />
      <ListRowLayout
        icon="internaldrive"
        label="Storage"
        description={storage ? describeStorage(storage) : "Measuring…"}
      />
    </SettingsSection>
  );
}
