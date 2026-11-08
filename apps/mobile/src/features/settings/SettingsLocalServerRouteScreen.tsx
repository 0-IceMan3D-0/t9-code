import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Linking, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
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
} from "../local-server/localServerModule";
import {
  pairEnvironment,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { LocalServerBatterySection } from "./LocalServerBatterySection";
import { LocalServerDevServersSection } from "./LocalServerDevServersSection";
import { LocalServerGitSection } from "./LocalServerGitSection";
import { LocalServerHealthSection } from "./LocalServerHealthSection";
import { LocalServerMaintenanceRows } from "./LocalServerMaintenanceRows";

const STATE_LABELS: Record<LocalServerStatus["state"], string> = {
  notInstalled: "Not set up",
  installing: "Setting up",
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  failed: "Failed",
};

function useLocalConnection(port: number | undefined) {
  const { savedConnectionsById } = useSavedRemoteConnections();
  return Object.values(savedConnectionsById).find(
    (connection) => connection.httpBaseUrl.replace(/\/$/, "") === `http://127.0.0.1:${port}`,
  );
}

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
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const check = () => {
    void localServer?.claudeLoggedIn().then(setSignedIn);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Sign-in state lives in the guest environment.
  useEffect(check, []);

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
    setError(null);
    try {
      await localServer?.submitClaudeCode(code.trim());
    } catch (cause) {
      setError(signInErrorMessage(cause));
    }
    setCode("");
  };

  return (
    <SettingsSection title="Claude Code">
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">
          {signedIn === null ? "Checking…" : signedIn ? "Signed in" : "Not signed in"}
        </Text>
        {error ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
      </View>
      {signingIn ? (
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
      {signingIn ? (
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
          </SettingsSection>
        )}

        {state === "notInstalled" || state === "installing" || maintaining ? null : (
          <LocalServerGitSection />
        )}

        {state === "notInstalled" || state === "installing" ? null : (
          <LocalServerDevServersSection />
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
            subtitle="Stops the built-in server 2 minutes after you leave the app, once no thread is working or waiting on you and no Linux shell or web server is running."
            value={status.stopOnLeave}
            onValueChange={(value) => setOption(() => server.setStopOnLeave(value))}
          />
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
