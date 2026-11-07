import { useNavigation } from "@react-navigation/native";
import type { TerminalOutputState } from "@t3tools/client-runtime/state/terminal";
import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { TerminalSurface } from "../terminal/NativeTerminalSurface";
import { resolveModifiedTerminalInput, type PendingModifier } from "../terminal/terminalInput";
import { localServer } from "./localServerModule";
import { appendOutput, EMPTY_OUTPUT } from "./sessionOutput";

type Key =
  | { readonly label: string; readonly data: string }
  | { readonly label: string; readonly modifier: PendingModifier };

const KEY_ROWS: ReadonlyArray<ReadonlyArray<Key>> = [
  [
    { label: "ESC", data: "\u001b" },
    { label: "/", data: "/" },
    { label: "-", data: "-" },
    { label: "HOME", data: "\u001b[H" },
    { label: "↑", data: "\u001b[A" },
    { label: "END", data: "\u001b[F" },
    { label: "PGUP", data: "\u001b[5~" },
  ],
  [
    { label: "TAB", data: "\t" },
    { label: "CTRL", modifier: "ctrl" },
    { label: "ALT", modifier: "meta" },
    { label: "←", data: "\u001b[D" },
    { label: "↓", data: "\u001b[B" },
    { label: "→", data: "\u001b[C" },
    { label: "PGDN", data: "\u001b[6~" },
  ],
];
const CTRL_V = "\u0016";

function runningSessions(): ReadonlyArray<number> {
  return localServer?.getTermuxStatus().sessions ?? [];
}

export function TermuxRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const keyboardHeight = useKeyboardState((state) => state.height);
  const [outputs, setOutputs] = useState<Readonly<Record<number, TerminalOutputState>>>(() =>
    Object.fromEntries(
      runningSessions().map((id) => [
        id,
        appendOutput(EMPTY_OUTPUT, localServer?.termuxHistory(id) ?? ""),
      ]),
    ),
  );
  const [sessions, setSessions] = useState(runningSessions);
  const [active, setActive] = useState(() => runningSessions().at(-1) ?? null);
  const [modifier, setModifier] = useState<PendingModifier | null>(null);

  const addSession = () => {
    void localServer?.createTermuxSession(80, 24).then((id) => {
      setSessions((current) => [...current, id]);
      setActive(id);
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribes to native sessions, which outlive this screen.
  useEffect(() => {
    if (!localServer) return;
    const server = localServer;
    const output = server.addListener("onTermuxOutput", ({ id, data }) =>
      setOutputs((current) => ({
        ...current,
        [id]: appendOutput(current[id] ?? EMPTY_OUTPUT, data),
      })),
    );
    const exit = server.addListener("onTermuxExit", ({ id }) => {
      setSessions((current) => {
        const remaining = current.filter((session) => session !== id);
        setActive((selected) => (selected === id ? (remaining.at(-1) ?? null) : selected));
        if (remaining.length === 0) navigation.goBack();
        return remaining;
      });
    });
    if (server.getTermuxStatus().sessions.length === 0) {
      void server.createTermuxSession(80, 24).then((id) => {
        setSessions([id]);
        setActive(id);
      });
    }
    return () => {
      output.remove();
      exit.remove();
    };
  }, [navigation]);

  const send = (data: string) => {
    if (active !== null) localServer?.writeTermux(active, data);
  };

  const paste = () => {
    void Clipboard.getStringAsync().then(send);
  };

  const write = (data: string) => {
    if (modifier === null) {
      send(data);
      return;
    }
    setModifier(null);
    const resolved = resolveModifiedTerminalInput({ data, modifier, hostPlatform: "unknown" });
    send(resolved.kind === "write" ? resolved.data : CTRL_V);
  };

  const bottom = keyboardVisible ? keyboardHeight : insets.bottom;

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top, paddingBottom: bottom }}>
      <View className="flex-row items-center bg-subtle">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1">
          {sessions.map((id, index) => (
            <Pressable
              key={id}
              accessibilityLabel={`Session ${index + 1}`}
              accessibilityRole="button"
              accessibilityState={{ selected: id === active }}
              className="px-4 py-2.5"
              onPress={() => setActive(id)}
            >
              <Text className={id === active ? "text-foreground" : "text-foreground-muted"}>
                {index + 1}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <Pressable
          accessibilityLabel="New session"
          accessibilityRole="button"
          className="px-4 py-2.5"
          onPress={addSession}
        >
          <Text className="text-foreground">+</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Close session"
          accessibilityRole="button"
          className="px-4 py-2.5"
          onPress={() => active !== null && localServer?.closeTermuxSession(active)}
        >
          <Text className="text-foreground">×</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Paste"
          accessibilityRole="button"
          className="px-4 py-2.5"
          onPress={paste}
        >
          <Text className="text-foreground">Paste</Text>
        </Pressable>
      </View>
      {active === null ? (
        <View className="flex-1" />
      ) : (
        <TerminalSurface
          key={active}
          autoFocus
          buffer=""
          isRunning
          onInput={write}
          onResize={({ cols, rows }) => localServer?.resizeTermux(active, cols, rows)}
          output={outputs[active] ?? EMPTY_OUTPUT}
          style={{ flex: 1 }}
          terminalKey={`termux-${active}`}
        />
      )}
      {KEY_ROWS.map((row) => (
        <View key={row[0]?.label} className="flex-row bg-subtle">
          {row.map((key) => {
            const pressed = "modifier" in key && modifier === key.modifier;
            return (
              <Pressable
                key={key.label}
                accessibilityLabel={key.label}
                accessibilityRole="button"
                accessibilityState={{ selected: pressed }}
                className="flex-1 items-center justify-center py-2.5"
                onPress={() =>
                  "modifier" in key
                    ? setModifier((current) => (current === key.modifier ? null : key.modifier))
                    : write(key.data)
                }
              >
                <Text className={pressed ? "text-primary-foreground" : "text-foreground"}>
                  {key.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
