import { useState } from "react";
import { TextInput, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { localServer, useOllama } from "../local-server/localServerModule";
import { formatModelSize, SUGGESTED_OLLAMA_MODELS } from "../local-server/localModels";
import { SettingsSection } from "./components/SettingsSection";

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
