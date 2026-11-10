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
/** 90 seconds of samples. */
const HISTORY = 30;

interface Health {
  readonly sample: HealthSample;
  readonly cpu: number | null;
  readonly cpuHistory: ReadonlyArray<number>;
  readonly memoryHistory: ReadonlyArray<number>;
}

const remember = (history: ReadonlyArray<number>, value: number) =>
  [...history, value].slice(-HISTORY);

function useServerHealth(active: boolean) {
  const [health, setHealth] = useState<Health | null>(null);
  const [storage, setStorage] = useState<StorageSample | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Polls /proc through the native module only while this screen is visible.
  useEffect(() => {
    const server = localServer;
    if (!active || !server) return;
    let previous: HealthSample | null = null;
    let cpuHistory: ReadonlyArray<number> = [];
    let memoryHistory: ReadonlyArray<number> = [];
    let stopped = false;
    let measuring = false;
    let measuredAt = -Infinity;
    const tick = () => {
      void server.sampleHealth().then((next) => {
        if (stopped) return;
        const cpu = cpuPercent(previous, next);
        previous = next;
        if (cpu !== null) cpuHistory = remember(cpuHistory, cpu);
        memoryHistory = remember(memoryHistory, next.rssBytes / next.totalMemory);
        setHealth({ sample: next, cpu, cpuHistory, memoryHistory });
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

/** Bars for the recent history of a 0–1 value, oldest on the left. */
function HistoryBars(props: { readonly values: ReadonlyArray<number> }) {
  const empty = HISTORY - props.values.length;
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      className="mt-1 h-8 flex-row items-end gap-0.5"
    >
      {Array.from({ length: HISTORY }, (_, index) => {
        const value = index < empty ? null : props.values[index - empty];
        return (
          <View
            key={index}
            className={value === null ? "flex-1" : "flex-1 rounded-sm bg-primary"}
            style={{ height: `${Math.max(4, Math.min(1, value ?? 0) * 100)}%` }}
          />
        );
      })}
    </View>
  );
}

/** Phone storage: Linux and private projects, then everything else in use. */
function StorageMeter(props: { readonly storage: StorageSample }) {
  const { totalBytes, freeBytes, linuxBytes, projectBytes } = props.storage;
  if (totalBytes <= 0) return null;
  const ours = (linuxBytes + projectBytes) / totalBytes;
  const other = Math.max(0, (totalBytes - freeBytes) / totalBytes - ours);
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      className="mt-1 h-2 flex-row overflow-hidden rounded-full bg-primary/15"
    >
      <View className="bg-primary" style={{ width: `${ours * 100}%` }} />
      <View className="bg-primary/40" style={{ width: `${other * 100}%` }} />
    </View>
  );
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
      footer="Memory counts the server, shells and agents running in Linux."
    >
      {warning ? (
        <View className="p-4">
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {warning}
          </Text>
        </View>
      ) : null}
      <ListRowLayout
        icon="chart.bar.xaxis"
        label="CPU"
        description={describeCpu(health.cpu, health.sample)}
        meta={<HistoryBars values={health.cpuHistory.map((percent) => percent / 100)} />}
      />
      <ListRowLayout
        icon="cube"
        label="Memory"
        description={describeMemory(health.sample)}
        meta={<HistoryBars values={health.memoryHistory} />}
      />
      <ListRowLayout
        icon="internaldrive"
        label="Storage"
        description={storage ? describeStorage(storage) : "Measuring…"}
        meta={storage ? <StorageMeter storage={storage} /> : undefined}
      />
    </SettingsSection>
  );
}
