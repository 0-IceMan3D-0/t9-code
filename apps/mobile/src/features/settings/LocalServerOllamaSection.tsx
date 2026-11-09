import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { TextInput, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { localServer, useLocalServerStatus, useOllama } from "../local-server/localServerModule";
import {
  formatModelSize,
  OLLAMA_INSTANCE_ID,
  ollamaModelsToHide,
  planOllamaInstance,
  SUGGESTED_OLLAMA_MODELS,
} from "../local-server/ollama";
import { useLocalConnection } from "../local-server/useLocalConnection";
import { SettingsSection } from "./components/SettingsSection";

/** Keeps the built-in server's Ollama instance in step with the models on the phone. */
function useOllamaInstanceSync(
  environmentId: EnvironmentId | null,
  installed: boolean,
  models: NonNullable<ReturnType<typeof useOllama>>["models"] | undefined,
) {
  const config = useEnvironmentServerConfig(environmentId);
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });
  const saveSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "hide Claude models under Ollama",
  );
  const sent = useRef<string | null>(null);
  const sentHidden = useRef<string | null>(null);
  const plan =
    config === null || models === undefined
      ? null
      : planOllamaInstance({
          providerInstances: config.settings.providerInstances,
          installed,
          models,
        });
  const key = plan === null ? null : JSON.stringify(plan);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the provider instance to the server when the phone's models change
  useEffect(() => {
    if (environmentId === null || plan === null || key === sent.current) return;
    sent.current = key;
    void mutate({ environmentId, input: { patch: {}, providerInstanceMutation: plan } });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the key stands for the plan.
  }, [environmentId, key]);

  const toHide =
    config === null
      ? []
      : ollamaModelsToHide(
          config.providers.find((provider) => provider.instanceId === OLLAMA_INSTANCE_ID)?.models ??
            [],
          config.settings.providerModelPreferences?.[OLLAMA_INSTANCE_ID]?.hiddenModels ?? [],
        );
  const hideKey = toHide.length === 0 ? null : toHide.join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hides Claude's own models under the Ollama instance once the server lists them
  useEffect(() => {
    // Ollama has none of these models, so a later "Show" is hidden again too.
    if (hideKey === null) sentHidden.current = null;
    if (environmentId === null || hideKey === null || hideKey === sentHidden.current) return;
    sentHidden.current = hideKey;
    void saveSettings({
      environmentId,
      input: {
        patch: {
          setModelsHidden: toHide.map((model) => ({
            provider: OLLAMA_INSTANCE_ID,
            model,
            hidden: true,
          })),
        },
      },
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the key stands for the list.
  }, [environmentId, hideKey]);
}

/** Mounted for the app's lifetime, so the model picker matches the phone's models from any screen. */
export function OllamaCoordinator() {
  const status = useLocalServerStatus();
  const ollama = useOllama();
  const connection = useLocalConnection(status?.state === "running" ? status.port : undefined);
  useOllamaInstanceSync(
    connection?.environmentId ?? null,
    ollama?.installed ?? false,
    ollama?.models,
  );
  return null;
}

export function LocalServerOllamaSection(props: { readonly serverRunning: boolean }) {
  const ollama = useOllama();
  const [model, setModel] = useState("");
  const server = localServer;
  if (!server || !ollama) return null;

  const pulling = ollama.pulling !== null;
  const summary = ollama.installing
    ? (ollama.detail ?? "Installing")
    : !ollama.installed
      ? "Not installed"
      : ollama.running
        ? ollama.models.length === 0
          ? "Running. Download a model to start."
          : `Running · ${ollama.models.length} ${ollama.models.length === 1 ? "model" : "models"}`
        : props.serverRunning
          ? "Starting"
          : "Starts with the built-in server";

  const pull = (name: string) => {
    if (name.trim().length === 0) return;
    server.pullOllamaModel(name.trim());
    setModel("");
  };

  return (
    <SettingsSection
      title="Ollama"
      footer="Runs models on this phone's processor. Pick Ollama in a thread's model picker to use them with Claude Code. Every turn starts with Claude Code's long instructions, so expect it to take a few minutes on a phone."
    >
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">{summary}</Text>
        {ollama.installing ? (
          <Text className="text-sm text-foreground-muted">
            {Math.round(ollama.progress * 100)}%
          </Text>
        ) : null}
        {ollama.error ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {ollama.error}
          </Text>
        ) : null}
      </View>

      {!ollama.installed ? (
        <SettingsActionRow
          icon="arrow.down.circle"
          label="Install Ollama"
          description="Downloads 1.6 GB once and keeps about 60 MB"
          loading={ollama.installing}
          disabled={ollama.installing}
          onPress={() => server.installOllama()}
        />
      ) : (
        <>
          {ollama.models.map((entry) => (
            <SettingsActionRow
              key={entry.name}
              icon="trash"
              label={entry.name}
              description={formatModelSize(entry.size)}
              disabled={!ollama.running}
              onPress={() =>
                Dialog.confirm({
                  title: `Delete ${entry.name}?`,
                  message: "It is removed from the phone. You can download it again later.",
                  confirmText: "Delete",
                  destructive: true,
                  onConfirm: () => server.deleteOllamaModel(entry.name),
                })
              }
            />
          ))}
          {pulling ? (
            <View className="gap-1 px-4 py-3">
              <Text className="text-base text-foreground">Downloading {ollama.pulling}</Text>
              <Text className="text-sm text-foreground-muted">
                {ollama.pullDetail ?? ""} · {Math.round(ollama.pullProgress * 100)}%
              </Text>
            </View>
          ) : null}
          {ollama.running && !pulling ? (
            <View className="gap-2 px-4 py-3">
              <TextInput
                accessibilityLabel="Model to download"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                importantForAutofill="no"
                className="rounded-lg bg-subtle p-3 text-foreground"
                onChangeText={setModel}
                onSubmitEditing={() => pull(model)}
                placeholder="Model from ollama.com, for example qwen3:4b"
                returnKeyType="done"
                value={model}
              />
              <Text className="text-sm text-foreground-muted">
                Small models that use tools: {SUGGESTED_OLLAMA_MODELS.join(", ")}.
              </Text>
            </View>
          ) : null}
          {ollama.running && !pulling ? (
            <SettingsActionRow
              icon="arrow.down.circle"
              label="Download model"
              disabled={model.trim().length === 0}
              onPress={() => pull(model)}
            />
          ) : null}
          <SettingsActionRow
            icon="trash"
            label="Remove Ollama"
            description="Deletes Ollama and every downloaded model"
            tone="danger"
            disabled={pulling}
            onPress={() =>
              Dialog.confirm({
                title: "Remove Ollama?",
                message:
                  "Ollama and all its models are deleted from the phone, and the Ollama choice leaves the model picker.",
                confirmText: "Remove",
                destructive: true,
                onConfirm: () => server.uninstallOllama(),
              })
            }
          />
        </>
      )}
    </SettingsSection>
  );
}
