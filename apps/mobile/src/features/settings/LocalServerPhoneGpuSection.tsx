import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { localServer, usePhoneModels } from "../local-server/localServerModule";
import { formatModelSize } from "../local-server/localModels";
import { SettingsSection } from "./components/SettingsSection";

export function LocalServerPhoneGpuSection(props: { readonly serverRunning: boolean }) {
  const phone = usePhoneModels();
  const server = localServer;
  if (!server || !phone) return null;

  const loaded = phone.catalog.find((model) => model.id === phone.loaded);
  const summary =
    phone.installed.length === 0
      ? "Download a model to start."
      : !phone.running
        ? props.serverRunning
          ? "Starting"
          : "Starts with the built-in server"
        : loaded === undefined
          ? "Ready. A model loads with the first message."
          : `${loaded.title} loaded · ${Math.round(phone.contextTokens / 1024)}K tokens${phone.busy ? " · working" : ""}`;

  return (
    <SettingsSection
      title="Phone GPU"
      footer="Runs Google's Gemma models on this phone's graphics processor, much faster than Ollama. Pick Phone GPU in a thread's model picker to use them with Claude Code."
    >
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">{summary}</Text>
        {phone.error ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {phone.error}
          </Text>
        ) : null}
      </View>
      {phone.catalog.map((model) => {
        const installed = phone.installed.includes(model.id);
        const downloading = phone.downloading === model.id;
        if (installed) {
          return (
            <SettingsActionRow
              key={model.id}
              icon="trash"
              label={model.title}
              description={formatModelSize(model.bytes)}
              onPress={() =>
                Dialog.confirm({
                  title: `Delete ${model.title}?`,
                  message: "It is removed from the phone. You can download it again later.",
                  confirmText: "Delete",
                  destructive: true,
                  onConfirm: () => server.deletePhoneModel(model.id),
                })
              }
            />
          );
        }
        return (
          <SettingsActionRow
            key={model.id}
            icon={downloading ? "xmark.circle.fill" : "arrow.down.circle"}
            label={downloading ? `Downloading ${model.title}` : `Download ${model.title}`}
            description={
              downloading
                ? `${Math.round(phone.progress * 100)}% of ${formatModelSize(model.bytes)} · tap to cancel`
                : formatModelSize(model.bytes)
            }
            disabled={phone.downloading !== null && !downloading}
            onPress={() =>
              downloading ? server.cancelPhoneModelDownload() : server.downloadPhoneModel(model.id)
            }
          />
        );
      })}
    </SettingsSection>
  );
}
