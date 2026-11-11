import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import {
  saveLocalModelSettings,
  useLocalModelSettings,
  useOllama,
  type LocalModelSettingValues,
} from "../local-server/localServerModule";
import { SettingsSection } from "./components/SettingsSection";
import { LocalServerPage } from "./LocalServerPage";

const kilo = (tokens: number) => `${Math.round(tokens / 1024)}K`;

/** A typed value: shown and entered in [unit]s, stored as `shown * scale`. */
interface CustomValue {
  readonly unit: string;
  readonly scale: number;
  readonly min: number;
  readonly max: number;
}

function ChoiceRow(props: {
  readonly label: string;
  readonly description: string;
  readonly options: ReadonlyArray<{ readonly value: number; readonly label: string }>;
  readonly custom: CustomValue;
  readonly selected: number;
  readonly disabled?: boolean;
  readonly onSelect: (value: number) => void;
}) {
  const { custom } = props;
  const preset = props.options.some((option) => option.value === props.selected);
  const [customOpen, setCustomOpen] = useState(!preset);
  const shown = (value: number) => (value > 0 ? String(Math.round(value / custom.scale)) : "");
  const [draft, setDraft] = useState(shown(props.selected));
  const commit = () => {
    const typed = Math.round(Number(draft));
    if (!Number.isFinite(typed) || typed < custom.min) {
      setDraft(shown(props.selected));
      return;
    }
    const clamped = Math.min(typed, custom.max);
    setDraft(String(clamped));
    props.onSelect(clamped * custom.scale);
  };
  return (
    <View className="gap-3 px-4 py-3">
      <View className="gap-1">
        <Text className="text-foreground text-lg android:text-base">{props.label}</Text>
        <Text className="text-sm text-foreground-muted">{props.description}</Text>
      </View>
      <SegmentedControl
        variant="card"
        options={[
          ...props.options.map((option) => ({ value: String(option.value), label: option.label })),
          { value: "custom", label: "Custom" },
        ]}
        selected={customOpen ? "custom" : String(props.selected)}
        onSelect={(value) => {
          if (props.disabled) return;
          if (value === "custom") {
            setDraft(shown(props.selected));
            setCustomOpen(true);
            return;
          }
          setCustomOpen(false);
          props.onSelect(Number(value));
        }}
      />
      {customOpen ? (
        <View className="flex-row items-center gap-3">
          <TextInput
            accessibilityLabel={`${props.label} in ${custom.unit}`}
            className="w-24 rounded-lg bg-subtle p-3 text-foreground"
            editable={!props.disabled}
            keyboardType="number-pad"
            maxLength={4}
            onBlur={commit}
            onChangeText={setDraft}
            onSubmitEditing={commit}
            returnKeyType="done"
            value={draft}
          />
          <Text className="flex-1 text-sm text-foreground-muted">
            {custom.unit}, {custom.min} to {custom.max}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const CONTEXT_CUSTOM: CustomValue = { unit: "thousand tokens", scale: 1024, min: 2, max: 128 };

export function SettingsLocalServerModelSettingsRouteScreen() {
  const ollama = useOllama();
  const settings = useLocalModelSettings();
  const [error, setError] = useState<string | null>(null);
  if (!settings) return null;

  const change = (changes: Partial<LocalModelSettingValues>) => {
    setError(null);
    saveLocalModelSettings(changes).catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Could not save the setting."),
    );
  };

  const pulling = ollama?.pulling != null;
  const threads = [2, 4, 8].filter((count) => count <= settings.cores);

  return (
    <LocalServerPage title="Model settings">
      {() => (
        <>
          {error ? (
            <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
              {error}
            </Text>
          ) : null}
          <SettingsSection
            title="Phone GPU"
            footer="Larger sizes fit longer threads but need more memory. A change applies to the next message."
          >
            <ChoiceRow
              label="Context size"
              description={
                settings.autoGpuContext === null
                  ? "Auto tries 32K first, then smaller sizes, and remembers what loads."
                  : `Auto uses ${kilo(settings.autoGpuContext)}, the size that loaded on this phone.`
              }
              options={[
                { value: 0, label: "Auto" },
                { value: 16384, label: "16K" },
                { value: 24576, label: "24K" },
                { value: 32768, label: "32K" },
              ]}
              custom={CONTEXT_CUSTOM}
              selected={settings.gpuContext}
              onSelect={(gpuContext) => change({ gpuContext })}
            />
          </SettingsSection>

          <SettingsSection
            title="Ollama"
            footer={
              pulling
                ? "Wait for the download to finish to change these."
                : "Changes restart Ollama, which unloads its model."
            }
          >
            <ChoiceRow
              label="Context size"
              description={`Auto uses ${kilo(settings.autoOllamaContext)} for this phone's memory. Claude Code needs at least 24K.`}
              options={[
                { value: 0, label: "Auto" },
                { value: 16384, label: "16K" },
                { value: 24576, label: "24K" },
                { value: 32768, label: "32K" },
              ]}
              custom={CONTEXT_CUSTOM}
              selected={settings.ollamaContext}
              disabled={pulling}
              onSelect={(ollamaContext) => change({ ollamaContext })}
            />
            <ChoiceRow
              label="Threads"
              description={`Auto uses ${settings.autoOllamaThreads}, one per fast core. Threads on slow cores hold the rest back.`}
              options={[
                { value: 0, label: "Auto" },
                ...threads.map((count) => ({ value: count, label: String(count) })),
              ]}
              custom={{ unit: "threads", scale: 1, min: 1, max: settings.cores }}
              selected={settings.ollamaThreads}
              disabled={pulling}
              onSelect={(ollamaThreads) => change({ ollamaThreads })}
            />
            <ChoiceRow
              label="Keep model loaded"
              description="After a reply, so the next one starts fast. Unloading frees memory sooner."
              options={[
                { value: 5, label: "5m" },
                { value: 30, label: "30m" },
                { value: 120, label: "2h" },
              ]}
              custom={{ unit: "minutes", scale: 1, min: 1, max: 240 }}
              selected={settings.ollamaKeepAliveMinutes}
              disabled={pulling}
              onSelect={(ollamaKeepAliveMinutes) => change({ ollamaKeepAliveMinutes })}
            />
          </SettingsSection>
        </>
      )}
    </LocalServerPage>
  );
}
