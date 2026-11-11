import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { localServer } from "../local-server/localServerModule";
import { SettingsSection } from "./components/SettingsSection";
import { useRefreshAgentProvider } from "./LocalServerAgentTool";
import { LocalServerPage } from "./LocalServerPage";
import { PI_ACCOUNT_PROVIDERS, PI_API_KEY_PROVIDERS } from "./LocalServerPiSignIn";

export function SettingsLocalServerPiSignInRouteScreen() {
  const navigation = useNavigation();
  const refreshProvider = useRefreshAgentProvider("pi");
  const [provider, setProvider] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const server = localServer;
    if (!server || provider === null) return;
    setSaving(true);
    setError(null);
    try {
      await server.savePiApiKey(provider, key);
    } catch (cause) {
      setSaving(false);
      setError(cause instanceof Error ? cause.message : "Could not save the key.");
      return;
    }
    setSaving(false);
    setKey("");
    await refreshProvider();
    navigation.goBack();
  };

  return (
    <LocalServerPage title="Sign in to Pi" needsLinux>
      {() => (
        <>
          <SettingsSection
            title="With an account"
            footer="Opens the Linux shell: tap the link, sign in, then paste the code if Pi asks for one."
          >
            {PI_ACCOUNT_PROVIDERS.map((entry) => (
              <ListRow
                key={entry.id}
                label={entry.label}
                onPress={() =>
                  navigation.navigate("LinuxShell", {
                    run: `pi auth login ${entry.id} --no-browser`,
                  })
                }
              />
            ))}
          </SettingsSection>

          <SettingsSection title="With an API key" footer="Pi saves the key in ~/.pi in Linux.">
            {PI_API_KEY_PROVIDERS.map((entry) => (
              <ListChoiceRow
                key={entry.id}
                label={entry.label}
                selected={provider === entry.id}
                onPress={() => setProvider(entry.id)}
              />
            ))}
            {provider !== null ? (
              <View className="gap-2 px-4 py-3">
                <TextInput
                  accessibilityLabel="API key"
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect={false}
                  importantForAutofill="no"
                  secureTextEntry
                  className="rounded-lg bg-subtle p-3 text-foreground"
                  onChangeText={setKey}
                  onSubmitEditing={() => void save()}
                  placeholder="Paste your API key"
                  returnKeyType="done"
                  value={key}
                />
                {error ? (
                  <Text
                    selectable
                    accessibilityRole="alert"
                    className="text-sm text-danger-foreground"
                  >
                    {error}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {provider !== null ? (
              <SettingsActionRow
                icon="checkmark"
                label="Save key"
                loading={saving}
                disabled={key.trim().length === 0}
                onPress={() => void save()}
              />
            ) : null}
          </SettingsSection>

          <SettingsSection footer="Opens Pi in the Linux shell; type /login to pick from every provider Pi supports.">
            <ListRow
              icon="terminal"
              label="Other providers"
              onPress={() => navigation.navigate("LinuxShell", { run: "pi" })}
            />
          </SettingsSection>
        </>
      )}
    </LocalServerPage>
  );
}
