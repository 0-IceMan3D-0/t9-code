import { useNavigation } from "@react-navigation/native";
import { useEffect, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { localServer } from "../local-server/localServerModule";
import { useRefreshAgentProvider } from "./LocalServerAgentTool";

/** Pi's provider ids for account sign-in, which runs in a terminal. */
export const PI_ACCOUNT_PROVIDERS = [
  { id: "anthropic", label: "Claude Pro or Max" },
  { id: "openai-codex", label: "ChatGPT Plus or Pro" },
  { id: "github-copilot", label: "GitHub Copilot" },
] as const;

export const PI_API_KEY_PROVIDERS = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google Gemini" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "opencode", label: "OpenCode Zen" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "mistral", label: "Mistral" },
  { id: "groq", label: "Groq" },
  { id: "xai", label: "xAI" },
] as const;

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(PI_API_KEY_PROVIDERS.map((provider) => [provider.id, provider.label])),
  "openai-codex": "ChatGPT",
  "github-copilot": "GitHub Copilot",
};

export const piProviderName = (id: string) => PROVIDER_NAMES[id] ?? id;

/** Re-read when the screen comes back into view, after a sign-in in the Linux shell. */
function usePiSignedIn() {
  const navigation = useNavigation();
  const [providers, setProviders] = useState(() => localServer?.piSignedIn() ?? []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Pi saves sign-ins from the Linux shell while this screen is hidden.
  useEffect(
    () => navigation.addListener("focus", () => setProviders(localServer?.piSignedIn() ?? [])),
    [navigation],
  );
  const reload = () => setProviders(localServer?.piSignedIn() ?? []);
  return { providers, reload };
}

/** Pi's saved sign-ins, each with Sign out, and the way to add one. */
export function PiSignInRows() {
  const navigation = useNavigation();
  const { providers, reload } = usePiSignedIn();
  const refreshProvider = useRefreshAgentProvider("pi");
  return (
    <>
      {providers.map((id) => (
        <SettingsActionRow
          key={id}
          icon="person.crop.circle"
          label={piProviderName(id)}
          description="Signed in"
          detail="Sign out"
          onPress={() =>
            Dialog.confirm({
              title: `Sign Pi out of ${piProviderName(id)}?`,
              message: "Pi forgets this sign-in or API key. You can sign in again later.",
              confirmText: "Sign out",
              destructive: true,
              onConfirm: () => void localServer?.signOutPi(id).then(reload).then(refreshProvider),
            })
          }
        />
      ))}
      <ListRow
        icon="person.crop.circle"
        label={providers.length === 0 ? "Sign in to Pi" : "Add a provider"}
        description="With an account or an API key"
        onPress={() => navigation.navigate("SettingsLocalServerPiSignIn")}
      />
    </>
  );
}
