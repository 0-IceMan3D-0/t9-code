import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Linking, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { useConnectionController } from "../connection/useConnectionController";
import { offerBatteryExemption } from "../local-server/batteryOptimization";
import { confirmDeleteEnvironment, useLinuxMaintenance } from "../local-server/linuxMaintenance";
import {
  localServer,
  refreshLocalServerStatus,
  useLocalServerStatus,
  useUsbDevices,
  type LocalServerStatus,
  useAgentTool,
} from "../local-server/localServerModule";
import { useLocalConnection } from "../local-server/useLocalConnection";
import { pairEnvironment } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { AgentToolRows, agentToolSummary } from "./LocalServerAgentTool";
import { LocalServerBatterySection } from "./LocalServerBatterySection";
import { LocalServerDevServersSection } from "./LocalServerDevServersSection";
import { LocalServerGitSection } from "./LocalServerGitSection";
import { LocalServerHealthSection } from "./LocalServerHealthSection";
import { LocalServerMaintenanceRows } from "./LocalServerMaintenanceRows";
import { LocalServerOllamaSection } from "./LocalServerOllamaSection";
import { LocalServerOpenCodeSection } from "./LocalServerOpenCodeSection";
import { LocalServerPhoneGpuSection } from "./LocalServerPhoneGpuSection";

const STATE_LABELS: Record<LocalServerStatus["state"], string> = {
  notInstalled: "Not set up",
  installing: "Setting up",
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  failed: "Failed",
};

/** A saved connection to a wiped environment has a stale id, so it is replaced rather than kept. */
async function pairLocalServer(
  port: number | undefined,
  savedEnvironmentId: EnvironmentId | undefined,
  removeEnvironment: (environmentId: EnvironmentId) => unknown,
): Promise<string | null> {
  const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`);
  const { environmentId } = (await response.json()) as { readonly environmentId: EnvironmentId };
  if (savedEnvironmentId === environmentId) return null;
  const pairingUrl = localServer?.takePairingUrl();
  if (!pairingUrl) return null;
  if (savedEnvironmentId) await removeEnvironment(savedEnvironmentId);
  return (await pairEnvironment(pairingUrl)).error;
}

const signInErrorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Sign-in failed.";

function ClaudeSection() {
  const claude = useAgentTool("claude");
  const installed = claude?.installed === true;
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const check = () => {
    void localServer?.claudeLoggedIn().then(setSignedIn);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Sign-in state lives in the guest environment.
  useEffect(() => {
    if (installed) void localServer?.claudeLoggedIn().then(setSignedIn);
  }, [installed]);

  const start = async () => {
    const server = localServer;
    if (!server) return;
    setError(null);
    try {
      const url = await server.startClaudeLogin();
      if (!url) return;
      setSigningIn(true);
      await Linking.openURL(url);
      await server.waitForClaudeLogin();
      setSigningIn(false);
      check();
    } catch (cause) {
      setSigningIn(false);
      setError(signInErrorMessage(cause));
    }
  };

  const submit = async () => {
    const server = localServer;
    if (!server) return;
    setError(null);
    try {
      await server.submitClaudeCode(code.trim());
    } catch (cause) {
      setError(signInErrorMessage(cause));
    }
    setCode("");
  };

  const signIn = signedIn === null ? "checking sign-in" : signedIn ? "signed in" : "not signed in";
  const summary =
    claude === null
      ? "Not installed"
      : installed && claude.busy === null
        ? `${agentToolSummary(claude)} · ${signIn}`
        : agentToolSummary(claude);

  return (
    <SettingsSection
      title="Claude Code"
      footer="Pick Claude in a thread's model picker. Ollama and Phone GPU models run through Claude Code too."
    >
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">{summary}</Text>
        {claude?.error ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {claude.error}
          </Text>
        ) : null}
        {error ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
      </View>
      {installed && signingIn ? (
        <View className="gap-2 px-4 pb-4">
          <Text className="text-sm text-foreground-muted">
            Finish in your browser. If it shows a code, paste it here.
          </Text>
          <TextInput
            accessibilityLabel="Claude sign-in code"
            autoCapitalize="none"
            autoCorrect={false}
            className="rounded-lg bg-subtle p-3 text-foreground"
            onChangeText={setCode}
            value={code}
          />
        </View>
      ) : null}
      {!installed ? null : signingIn ? (
        <>
          <SettingsActionRow
            icon="checkmark"
            label="Submit code"
            disabled={code.trim().length === 0}
            onPress={() => void submit()}
          />
          <SettingsActionRow
            icon="xmark"
            label="Cancel sign-in"
            onPress={() => localServer?.cancelClaudeLogin()}
          />
        </>
      ) : (
        <SettingsActionRow
          icon="person.crop.circle"
          label={signedIn ? "Sign in again" : "Sign in to Claude"}
          onPress={() => void start()}
        />
      )}
      {claude ? (
        <AgentToolRows
          id="claude"
          name="Claude Code"
          tool={claude}
          removeMessage="Your Claude sign-in and settings stay, so installing it again picks them up. Ollama and Phone GPU models need Claude Code."
        />
      ) : null}
    </SettingsSection>
  );
}

const usbId = (value: number) => value.toString(16).padStart(4, "0");

function UsbSection() {
  const devices = useUsbDevices();
  return (
    <SettingsSection
      title="USB devices"
      footer="Allowed devices work with USB tools in the Linux shell and for agents, such as adb, fastboot, lsusb and libusb programs."
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

export function SettingsLocalServerRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const status = useLocalServerStatus();
  const maintenance = useLinuxMaintenance();
  const connection = useLocalConnection(status?.port);
  const { removeEnvironment } = useConnectionController();
  const [log, setLog] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);

  const state = status?.state;
  const port = status?.port;
  const savedEnvironmentId = connection?.environmentId;
  const connected = connection !== undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Pairs with the server once it reports ready.
  useEffect(() => {
    if (state !== "running") return;
    void pairLocalServer(port, savedEnvironmentId, removeEnvironment).then(setPairingError);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- removeEnvironment is new each render.
  }, [state, port, savedEnvironmentId]);

  const server = localServer;
  if (!server || !status) return null;

  const busy = state === "installing" || state === "starting";
  const maintaining = maintenance?.state === "running";
  const running = state === "running";

  const setOption = (write: () => void) => {
    write();
    refreshLocalServerStatus();
  };

  const toggleSharedStorage = async (value: boolean) => {
    if (value && !status.sharedStorageGranted) await server.requestStorageAccess();
    setOption(() => server.setSharedStorage(value));
  };

  const reset = () =>
    void confirmDeleteEnvironment(() => {
      void server.reset().then(() => {
        if (connection) void removeEnvironment(connection.environmentId);
      });
    });

  return (
    <SettingsScreen title="This phone">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Built-in server">
          <View className="gap-1 p-4">
            <Text className="text-base text-foreground">{STATE_LABELS[status.state]}</Text>
            {status.detail ? (
              <Text selectable className="text-sm text-foreground-muted" numberOfLines={3}>
                {state === "installing"
                  ? `${Math.round(status.progress * 100)}% · ${status.detail}`
                  : status.detail}
              </Text>
            ) : null}
            {running ? (
              <Text className="text-sm text-foreground-muted">
                {connected ? "Connected to this app." : "Connecting to this app…"}
              </Text>
            ) : null}
            {pairingError ? (
              <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
                {pairingError}
              </Text>
            ) : null}
          </View>
          {running || busy ? (
            <SettingsActionRow icon="stop.fill" label="Stop" onPress={() => server.stop()} />
          ) : (
            <SettingsActionRow
              icon="arrow.clockwise"
              label={state === "notInstalled" ? "Set up (about 500 MB download)" : "Start"}
              disabled={maintaining}
              onPress={() => {
                server.start();
                offerBatteryExemption();
              }}
            />
          )}
        </SettingsSection>

        {running ? <ClaudeSection /> : null}

        {state === "notInstalled" || state === "installing" ? null : (
          <SettingsSection title="Linux">
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
          </SettingsSection>
        )}

        {state === "notInstalled" || state === "installing" || maintaining ? null : (
          <LocalServerGitSection />
        )}

        {state === "notInstalled" || state === "installing" ? null : (
          <LocalServerDevServersSection />
        )}

        {state === "notInstalled" || state === "installing" || maintaining ? null : (
          <LocalServerOllamaSection serverRunning={running} />
        )}

        {state === "notInstalled" || state === "installing" || maintaining ? null : (
          <LocalServerPhoneGpuSection serverRunning={running} />
        )}

        {state === "notInstalled" || state === "installing" || maintaining ? null : (
          <LocalServerOpenCodeSection />
        )}

        {state === "notInstalled" || state === "installing" ? null : <LocalServerHealthSection />}

        {state === "notInstalled" || state === "installing" ? null : <UsbSection />}

        <SettingsSection title="Options">
          <SettingsSwitchRow
            label="Start when the app opens"
            subtitle="Starts the built-in server each time the app launches. It does not start after the phone restarts until you open the app."
            value={status.startOnAppOpen}
            onValueChange={(value) => setOption(() => server.setStartOnAppOpen(value))}
          />
          <SettingsSwitchRow
            label="Stop when I leave the app"
            subtitle={`Stops the built-in server ${formatStopAfter(status.stopAfterMinutes)} after you leave the app, once no thread is working or waiting on you and no Linux shell or web server is running.`}
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
            subtitle="Adds T3Projects in phone storage as /root/shared-projects. Applies after a restart. Private projects live in /root/projects."
            value={status.sharedStorage}
            onValueChange={(value) => void toggleSharedStorage(value)}
          />
        </SettingsSection>

        <LocalServerBatterySection />

        <SettingsSection
          title="Maintenance"
          footer="Backups hold Claude Code's sign-in and SSH keys, so keep them private. Projects in the shared folder are not included."
        >
          <LocalServerMaintenanceRows state={status.state} />
          {log !== null ? (
            <Text selectable className="p-4 text-xs text-foreground-muted">
              {log || "No log yet."}
            </Text>
          ) : null}
          <SettingsActionRow
            icon="doc.text"
            label={log === null ? "Show log" : "Refresh log"}
            onPress={() => void server.readLog().then(setLog)}
          />
          <SettingsActionRow
            icon="trash"
            label="Delete environment"
            tone="danger"
            disabled={running || busy || maintaining || state === "notInstalled"}
            onPress={reset}
          />
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
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

function formatStopAfter(minutes: number): string {
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourText = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return rest === 0 ? hourText : `${hourText} ${rest} min`;
}
