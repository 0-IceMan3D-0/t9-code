import { useEffect, useState } from "react";
import { Linking, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { localServer, useAgentTool } from "../local-server/localServerModule";
import { SettingsSection } from "./components/SettingsSection";
import { AgentToolRows, agentToolSummary } from "./LocalServerAgentTool";

const signInErrorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Sign-in failed.";

export function LocalServerClaudeSection() {
  const claude = useAgentTool("claude");
  const installed = claude?.installed === true;
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const check = () => {
    void localServer?.claudeLoggedIn().then(setSignedIn);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Sign-in state lives in the guest environment.
  useEffect(() => {
    if (installed) void localServer?.claudeLoggedIn().then(setSignedIn);
  }, [installed]);

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
    const server = localServer;
    if (!server) return;
    setError(null);
    try {
      await server.submitClaudeCode(code.trim());
    } catch (cause) {
      setError(signInErrorMessage(cause));
    }
    setCode("");
  };

  const signIn = signedIn === null ? "checking sign-in" : signedIn ? "signed in" : "not signed in";
  const summary =
    claude === null
      ? "Not installed"
      : installed && claude.busy === null
        ? `${agentToolSummary(claude)} · ${signIn}`
        : agentToolSummary(claude);

  return (
    <SettingsSection
      title="Claude Code"
      footer="Pick Claude in a thread's model picker; Ollama and Phone GPU models run through it too."
    >
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">{summary}</Text>
        {claude?.error ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {claude.error}
          </Text>
        ) : null}
        {error ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
      </View>
      {installed && signingIn ? (
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
      {!installed ? null : signingIn ? (
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
      {claude ? (
        <AgentToolRows
          id="claude"
          name="Claude Code"
          tool={claude}
          removeMessage="Your Claude sign-in and settings stay, so installing it again picks them up. Ollama and Phone GPU models need Claude Code."
        />
      ) : null}
    </SettingsSection>
  );
}
