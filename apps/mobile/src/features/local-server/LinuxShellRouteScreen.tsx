import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { TerminalSurface } from "../terminal/NativeTerminalSurface";
import { resolveModifiedTerminalInput, type PendingModifier } from "../terminal/terminalInput";
import { localServer } from "./localServerModule";
import { appendOutput, EMPTY_OUTPUT } from "./sessionOutput";

const KEYS = [
  { label: "Esc", data: "\u001b" },
  { label: "Tab", data: "\t" },
  { label: "↑", data: "\u001b[A" },
  { label: "↓", data: "\u001b[B" },
  { label: "←", data: "\u001b[D" },
  { label: "→", data: "\u001b[C" },
] as const;

export function LinuxShellRouteScreen() {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const keyboardHeight = useKeyboardState((state) => state.height);
  const [output, setOutput] = useState(EMPTY_OUTPUT);
  const [exited, setExited] = useState(false);
  const [modifier, setModifier] = useState<PendingModifier | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribes to the native shell's output.
  useEffect(() => {
    if (!localServer) return;
    const data = localServer.addListener("onShellOutput", (event) =>
      setOutput((current) => appendOutput(current, event.data)),
    );
    const exit = localServer.addListener("onShellExit", () => setExited(true));
    void localServer.openShell(80, 24).then((history) => {
      if (history) setOutput((current) => appendOutput(current, history));
    });
    return () => {
      data.remove();
      exit.remove();
    };
  }, []);

  const write = (data: string) => {
    if (modifier === null) {
      localServer?.writeShell(data);
      return;
    }
    setModifier(null);
    const resolved = resolveModifiedTerminalInput({ data, modifier, hostPlatform: "unknown" });
    localServer?.writeShell(resolved.kind === "write" ? resolved.data : data);
  };

  const toggle = (next: PendingModifier) =>
    setModifier((current) => (current === next ? null : next));

  const keyClass = "flex-1 items-center justify-center py-2.5";
  const bottom = keyboardVisible ? keyboardHeight : insets.bottom;

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top, paddingBottom: bottom }}>
      <TerminalSurface
        autoFocus
        buffer=""
        isRunning={!exited}
        onInput={write}
        onResize={({ cols, rows }) => localServer?.resizeShell(cols, rows)}
        output={output}
        style={{ flex: 1 }}
        terminalKey="linux-shell"
      />
      {exited ? (
        <Text className="p-2 text-center text-sm text-foreground-muted">
          Shell ended. Go back and open it again.
        </Text>
      ) : null}
      <View className="flex-row bg-subtle">
        <Pressable
          accessibilityLabel="Ctrl"
          accessibilityRole="button"
          accessibilityState={{ selected: modifier === "ctrl" }}
          className={keyClass}
          onPress={() => toggle("ctrl")}
        >
          <Text className={modifier === "ctrl" ? "text-primary-foreground" : "text-foreground"}>
            Ctrl
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Alt"
          accessibilityRole="button"
          accessibilityState={{ selected: modifier === "meta" }}
          className={keyClass}
          onPress={() => toggle("meta")}
        >
          <Text className={modifier === "meta" ? "text-primary-foreground" : "text-foreground"}>
            Alt
          </Text>
        </Pressable>
        {KEYS.map((key) => (
          <Pressable
            key={key.label}
            accessibilityLabel={key.label}
            accessibilityRole="button"
            className={keyClass}
            onPress={() => write(key.data)}
          >
            <Text className="text-foreground">{key.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
