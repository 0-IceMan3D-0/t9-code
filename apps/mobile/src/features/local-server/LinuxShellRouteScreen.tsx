import { useIsFocused } from "@react-navigation/native";
import type { MenuAction } from "@react-native-menu/menu";
import type { TerminalOutputState } from "@t3tools/client-runtime/state/terminal";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { useAppActive } from "../../lib/appState";
import { stepTerminalFontSize } from "../../lib/appearancePreferences";
import { cn } from "../../lib/cn";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { TerminalSurface } from "../terminal/NativeTerminalSurface";
import {
  encodeTerminalPaste,
  resolveModifiedTerminalInput,
  type PendingModifier,
} from "../terminal/terminalInput";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  normalizeTerminalFontSize,
} from "../terminal/terminalPreferences";
import { shellTabTitle, tabAfterClose } from "./linuxShellTabs";
import { localServer, type LinuxShellInfo } from "./localServerModule";
import { appendOutput, EMPTY_OUTPUT } from "./sessionOutput";

const KEYS = [
  { label: "Esc", data: "\u001b" },
  { label: "Tab", data: "\t" },
  { label: "↑", data: "\u001b[A" },
  { label: "↓", data: "\u001b[B" },
  { label: "←", data: "\u001b[D" },
  { label: "→", data: "\u001b[C" },
] as const;

const MAX_TABS = 8;
const DESCRIBE_INTERVAL_MS = 2000;

const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Something went wrong.";

const withoutKey = <T,>(record: Readonly<Record<string, T>>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));

function confirmCloseRunning(info: LinuxShellInfo, onConfirm: () => void) {
  Dialog.confirm({
    title: "Close this tab?",
    message: `${shellTabTitle(info)} is still running. Closing the tab ends it and everything started in it.`,
    confirmText: "Close",
    destructive: true,
    onConfirm,
  });
}

export function LinuxShellRouteScreen() {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const keyboardHeight = useKeyboardState((state) => state.height);
  const focused = useIsFocused();
  const appActive = useAppActive();
  const { appearance, setTerminalFontSize } = useAppearancePreferences();
  const fontSize = appearance.terminalFontSize;
  const [tabs, setTabs] = useState<{
    readonly ids: ReadonlyArray<string>;
    readonly active: string | null;
  }>(() => {
    const existing = localServer?.listShells() ?? [];
    return { ids: existing, active: existing[existing.length - 1] ?? null };
  });
  const { ids, active: activeId } = tabs;
  const select = (id: string) => setTabs((current) => ({ ...current, active: id }));
  const [outputs, setOutputs] = useState<Readonly<Record<string, TerminalOutputState>>>({});
  const [infos, setInfos] = useState<Readonly<Record<string, LinuxShellInfo>>>({});
  // Until the first shell opens, or the open ones' output is back.
  const [loading, setLoading] = useState(true);
  const [modifier, setModifier] = useState<PendingModifier | null>(null);
  const [captureRequest, setCaptureRequest] = useState(0);
  const size = useRef({ cols: 80, rows: 24 });
  const tabStrip = useRef<ComponentRef<typeof ScrollView>>(null);

  const open = () =>
    localServer
      ?.openShell(size.current.cols, size.current.rows)
      .then((id) => setTabs((current) => ({ ids: [...current.ids, id], active: id })))
      .catch((cause: unknown) => Dialog.alert("Could not open a shell", errorMessage(cause)));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribes to the native shells, which keep running while this screen is closed.
  useEffect(() => {
    const server = localServer;
    if (!server) return;
    const data = server.addListener("onShellOutput", (event) =>
      setOutputs((current) => ({
        ...current,
        [event.id]: appendOutput(current[event.id] ?? EMPTY_OUTPUT, event.data),
      })),
    );
    const exit = server.addListener("onShellExit", (event) => {
      setTabs((current) => ({
        ids: current.ids.filter((id) => id !== event.id),
        active: tabAfterClose(current.ids, event.id, current.active),
      }));
      setOutputs((current) => withoutKey(current, event.id));
      setInfos((current) => withoutKey(current, event.id));
    });
    const existing = server.listShells();
    const ready =
      existing.length === 0
        ? open()
        : // History replaces whatever arrived meanwhile, which it already holds.
          Promise.all(
            existing.map(async (id) => [id, await server.shellHistory(id)] as const),
          ).then((histories) =>
            setOutputs((current) => {
              const next = { ...current };
              for (const [id, history] of histories) {
                if (history !== null) next[id] = appendOutput(EMPTY_OUTPUT, history);
              }
              return next;
            }),
          );
    void ready?.finally(() => setLoading(false));
    return () => {
      data.remove();
      exit.remove();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- open only reads the native module and refs.
  }, []);

  const visible = focused && appActive && ids.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Polls Linux for each tab's program and folder while the tabs are on screen.
  useEffect(() => {
    if (!visible) return;
    const describe = () =>
      void localServer
        ?.describeShells()
        .then((list) => setInfos(Object.fromEntries(list.map((info) => [info.id, info]))));
    describe();
    const timer = setInterval(describe, DESCRIBE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [visible]);

  const write = (data: string) => {
    if (activeId === null) return;
    if (modifier === null) {
      localServer?.writeShell(activeId, data);
      return;
    }
    setModifier(null);
    const resolved = resolveModifiedTerminalInput({ data, modifier, hostPlatform: "unknown" });
    localServer?.writeShell(activeId, resolved.kind === "write" ? resolved.data : data);
  };

  const paste = () => {
    const id = activeId;
    if (id === null) return;
    void Clipboard.getStringAsync().then((text) => {
      if (text) localServer?.writeShell(id, encodeTerminalPaste(text));
    });
  };

  const close = (id: string) => {
    const server = localServer;
    if (!server) return;
    const end = () => void server.closeShell(id);
    // Fresh, so a program started a moment ago still asks first.
    void server.describeShells().then((list) => {
      const info = list.find((entry) => entry.id === id);
      if (info?.busy) confirmCloseRunning(info, end);
      else end();
    });
  };

  const setFontSize = (value: number) => setTerminalFontSize(normalizeTerminalFontSize(value));

  const toggle = (next: PendingModifier) =>
    setModifier((current) => (current === next ? null : next));

  const menuActions: MenuAction[] = [
    {
      id: "new",
      title: "New tab",
      image: "plus",
      attributes: { disabled: ids.length >= MAX_TABS },
    },
    { id: "paste", title: "Paste", attributes: { disabled: activeId === null } },
    { id: "copy-screen", title: "Copy screen", attributes: { disabled: activeId === null } },
    {
      id: "bigger",
      title: `Larger text (${stepTerminalFontSize(fontSize, 1).toFixed(1)} pt)`,
      attributes: { disabled: fontSize >= MAX_TERMINAL_FONT_SIZE },
    },
    {
      id: "smaller",
      title: `Smaller text (${stepTerminalFontSize(fontSize, -1).toFixed(1)} pt)`,
      attributes: { disabled: fontSize <= MIN_TERMINAL_FONT_SIZE },
    },
    {
      id: "close",
      title: "Close tab",
      attributes: { destructive: true, disabled: activeId === null },
    },
  ];

  const onMenuAction = (action: string) => {
    if (action === "new") void open();
    else if (action === "paste") paste();
    else if (action === "copy-screen") setCaptureRequest((current) => current + 1);
    else if (action === "bigger") setFontSize(stepTerminalFontSize(fontSize, 1));
    else if (action === "smaller") setFontSize(stepTerminalFontSize(fontSize, -1));
    else if (action === "close" && activeId !== null) close(activeId);
  };

  const keyClass = "flex-1 items-center justify-center py-1.5";
  // An armed modifier is filled until the next key consumes it.
  const modifierLabel = (label: string, armed: boolean) => (
    <View className={cn("rounded-full px-3 py-1", armed && "bg-primary")}>
      <Text className={armed ? "font-t3-bold text-primary-foreground" : "text-foreground"}>
        {label}
      </Text>
    </View>
  );
  const bottom = keyboardVisible ? keyboardHeight : insets.bottom;
  const activeOutput = activeId === null ? null : (outputs[activeId] ?? EMPTY_OUTPUT);

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top, paddingBottom: bottom }}>
      <View className="flex-row items-center bg-subtle">
        <ScrollView
          ref={tabStrip}
          horizontal
          showsHorizontalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="items-center gap-1 px-1 py-1"
          keyboardShouldPersistTaps="always"
        >
          {ids.map((id) => {
            const active = id === activeId;
            const title = shellTabTitle(infos[id]);
            return (
              <View
                key={id}
                // A new tab, or one that moved after a close, scrolls into view when it is active.
                onLayout={(event) => {
                  if (active) {
                    const { x } = event.nativeEvent.layout;
                    tabStrip.current?.scrollTo({ x: Math.max(0, x - 24), animated: true });
                  }
                }}
                className={cn(
                  "flex-row items-center rounded-full",
                  active ? "bg-screen" : "bg-transparent",
                )}
              >
                <Pressable
                  accessibilityRole="tab"
                  accessibilityLabel={`Shell ${title}`}
                  accessibilityState={{ selected: active }}
                  className="py-1.5 pl-3 pr-1"
                  onPress={() => select(id)}
                >
                  <Text
                    numberOfLines={1}
                    className={cn(
                      "max-w-40 text-sm",
                      active ? "font-t3-bold text-foreground" : "text-foreground-muted",
                    )}
                  >
                    {title}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Close ${title}`}
                  hitSlop={6}
                  className="py-1.5 pl-1 pr-2.5"
                  onPress={() => close(id)}
                >
                  <SymbolView
                    name={{ ios: "xmark", android: "close" }}
                    size={12}
                    tintColorClassName="accent-foreground-muted"
                    type="monochrome"
                  />
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New tab"
          accessibilityState={{ disabled: ids.length >= MAX_TABS }}
          disabled={ids.length >= MAX_TABS}
          className={cn("px-3 py-2", ids.length >= MAX_TABS && "opacity-40")}
          onPress={() => void open()}
        >
          <Text className="text-lg text-foreground">+</Text>
        </Pressable>
        <Menu
          actions={menuActions}
          onPressAction={({ nativeEvent }) => onMenuAction(nativeEvent.event)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Shell options"
            className="px-3 py-2"
          >
            <SymbolView
              name={{ ios: "ellipsis", android: "more_vert" }}
              size={18}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </Pressable>
        </Menu>
      </View>

      {loading ? (
        <View className="flex-1" />
      ) : activeId !== null && activeOutput !== null ? (
        <TerminalSurface
          autoFocus
          buffer=""
          captureRequest={captureRequest}
          fontSize={fontSize}
          isRunning
          onCapture={(text) => {
            setCaptureRequest(0);
            void tryCopyTextWithHaptic(text);
          }}
          onFontSizeChange={setFontSize}
          onInput={write}
          onResize={({ cols, rows }) => {
            size.current = { cols, rows };
            localServer?.resizeShell(activeId, cols, rows);
          }}
          output={activeOutput}
          style={{ flex: 1 }}
          terminalKey={`linux-shell-${activeId}`}
        />
      ) : (
        <View className="flex-1 items-center justify-center gap-3 p-6">
          <Text className="text-center text-sm text-foreground-muted">No shell is open.</Text>
          <Pressable
            accessibilityRole="button"
            className="rounded-full bg-primary px-5 py-2.5"
            onPress={() => void open()}
          >
            <Text className="font-t3-bold text-primary-foreground">Open a shell</Text>
          </Pressable>
        </View>
      )}
      <View className="flex-row bg-subtle">
        <Pressable
          accessibilityLabel="Ctrl"
          accessibilityRole="button"
          accessibilityState={{ selected: modifier === "ctrl" }}
          className={keyClass}
          onPress={() => toggle("ctrl")}
        >
          {modifierLabel("Ctrl", modifier === "ctrl")}
        </Pressable>
        <Pressable
          accessibilityLabel="Alt"
          accessibilityRole="button"
          accessibilityState={{ selected: modifier === "meta" }}
          className={keyClass}
          onPress={() => toggle("meta")}
        >
          {modifierLabel("Alt", modifier === "meta")}
        </Pressable>
        {KEYS.map((key) => (
          <Pressable
            key={key.label}
            accessibilityLabel={key.label}
            accessibilityRole="button"
            className={keyClass}
            onPress={() => write(key.data)}
          >
            <View className="px-3 py-1">
              <Text className="text-foreground">{key.label}</Text>
            </View>
          </Pressable>
        ))}
        <Pressable
          accessibilityLabel="Paste"
          accessibilityRole="button"
          className={keyClass}
          onPress={paste}
        >
          <View className="px-3 py-1">
            <SymbolView
              name={{ ios: "doc.on.clipboard", android: "content_paste" }}
              size={18}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </View>
        </Pressable>
      </View>
    </View>
  );
}
