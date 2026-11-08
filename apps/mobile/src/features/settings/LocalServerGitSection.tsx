import { useIsFocused } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  classifyGitHubTest,
  describeGitHubTest,
  parseGitSetupStatus,
  validateGitIdentity,
  type GitSetupStatus,
} from "../local-server/gitSetup";
import { localServer } from "../local-server/localServerModule";
import { SettingsSection } from "./components/SettingsSection";

const GITHUB_NEW_KEY_URL = "https://github.com/settings/ssh/new";

const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Something went wrong.";

const errorCode = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : null;

type Busy = "install" | "identity" | "key" | "test" | null;

interface TestOutcome {
  readonly summary: string;
  readonly output: string;
  readonly ok: boolean;
}

async function runGitHubTest(): Promise<TestOutcome> {
  const raw = await localServer?.testGitHub();
  const { output } = JSON.parse(raw ?? "{}") as { readonly output?: string };
  const result = classifyGitHubTest(output ?? "");
  return {
    summary: describeGitHubTest(result),
    output: output ?? "",
    ok: result.kind === "authenticated",
  };
}

function confirmReplaceKey(onConfirm: () => void) {
  Dialog.confirm({
    title: "Replace the SSH key?",
    message:
      "The current key in Linux is deleted for good. GitHub and other servers that know it will stop accepting this phone until you add the new key.",
    confirmText: "Replace",
    destructive: true,
    onConfirm,
  });
}

function confirmDeleteKey(onConfirm: () => void) {
  Dialog.confirm({
    title: "Delete the SSH key?",
    message:
      "Git over SSH stops working in Linux and for agents. Remove the key from your GitHub account too.",
    confirmText: "Delete",
    destructive: true,
    onConfirm,
  });
}

/** Git identity and a GitHub SSH key for root in Linux, which the server's agents share. */
export function LocalServerGitSection() {
  const focused = useIsFocused();
  const [status, setStatus] = useState<GitSetupStatus | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestOutcome | null>(null);

  const refresh = () =>
    localServer
      ?.gitStatus()
      .then((json) => setStatus(parseGitSetupStatus(json)))
      .catch((cause: unknown) => setError(errorMessage(cause)));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Git and SSH state live in the Linux environment.
  useEffect(() => {
    if (focused) void refresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refresh only reads the native module.
  }, [focused]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Shows apt's progress while git and SSH install.
  useEffect(() => {
    const subscription = localServer?.addListener("onGitSetup", (event) =>
      setProgress(
        event.stage === "update"
          ? event.detail
          : `${Math.round(event.percent)}% · ${event.detail.trim()}`,
      ),
    );
    return () => subscription?.remove();
  }, []);

  const server = localServer;
  if (!server) return null;

  const run = (kind: Exclude<Busy, null>, work: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    void work()
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => {
        setBusy(null);
        setProgress(null);
        void refresh();
      });
  };

  const tools = status !== null && status.git && status.ssh;
  const nameValue = name ?? status?.name ?? "";
  const emailValue = email ?? status?.email ?? "";
  const identityChanged =
    status !== null &&
    (nameValue.trim() !== (status.name ?? "") || emailValue.trim() !== (status.email ?? ""));
  const identityProblem = validateGitIdentity(nameValue, emailValue);

  const saveIdentity = () =>
    run("identity", async () => {
      await server.setGitIdentity(nameValue.trim(), emailValue.trim());
      setName(null);
      setEmail(null);
    });

  const createKey = (overwrite: boolean) =>
    run("key", async () => {
      setTest(null);
      await server.createSshKey(overwrite).catch((cause: unknown) => {
        if (errorCode(cause) !== "ERR_KEY_EXISTS") throw cause;
        confirmReplaceKey(() => createKey(true));
      });
    });

  const deleteKey = () =>
    confirmDeleteKey(() =>
      run("key", async () => {
        setTest(null);
        await server.deleteSshKey();
      }),
    );

  const testConnection = () =>
    run("test", async () => {
      setTest(null);
      setTest(await runGitHubTest());
    });

  return (
    <SettingsSection
      title="Git and GitHub"
      footer="The built-in server's agents use this identity and key too. Prefer the GitHub CLI? In the Linux shell, run apt install gh, then gh auth login."
    >
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">
          {status === null
            ? "Checking…"
            : !tools
              ? "git and SSH are not installed in Linux"
              : status.publicKey
                ? "SSH key ready"
                : "No SSH key yet"}
        </Text>
        {busy === "install" && progress ? (
          <Text className="text-sm text-foreground-muted" numberOfLines={2}>
            {progress}
          </Text>
        ) : null}
        {error ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
      </View>

      {status !== null && !tools ? (
        <SettingsActionRow
          icon="arrow.down.circle"
          label="Install git and SSH"
          description="About 15 MB with apt"
          loading={busy === "install"}
          disabled={busy !== null}
          onPress={() => run("install", () => server.installGitTools())}
        />
      ) : null}

      {tools ? (
        <>
          <View className="gap-2 px-4 pb-4">
            <TextInput
              accessibilityLabel="Git user name"
              autoCapitalize="words"
              autoComplete="off"
              autoCorrect={false}
              importantForAutofill="no"
              className="rounded-lg bg-subtle p-3 text-foreground"
              onChangeText={setName}
              placeholder="Name for commits"
              value={nameValue}
            />
            <TextInput
              accessibilityLabel="Git email"
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              importantForAutofill="no"
              inputMode="email"
              className="rounded-lg bg-subtle p-3 text-foreground"
              onChangeText={setEmail}
              placeholder="Email for commits"
              value={emailValue}
            />
            {identityChanged && identityProblem ? (
              <Text className="text-sm text-danger-foreground">{identityProblem}</Text>
            ) : null}
          </View>
          <SettingsActionRow
            icon="checkmark"
            label="Save identity"
            description="Sets user.name and user.email in /root/.gitconfig"
            loading={busy === "identity"}
            disabled={!identityChanged || identityProblem !== null || busy !== null}
            onPress={saveIdentity}
          />

          {status.publicKey ? (
            <>
              <View className="gap-1 px-4 py-3">
                <Text className="text-sm text-foreground-muted">
                  Public key ({status.keyPath}.pub)
                </Text>
                <Text selectable className="font-mono text-xs text-foreground">
                  {status.publicKey}
                </Text>
              </View>
              <SettingsActionRow
                icon="doc.on.doc"
                label="Copy public key"
                onPress={() => void tryCopyTextWithHaptic(status.publicKey ?? "")}
              />
              <SettingsActionRow
                icon="arrow.up.right"
                label="Add to GitHub"
                description="Opens GitHub's New SSH key page. Paste the key there."
                onPress={() => void tryOpenExternalUrl(GITHUB_NEW_KEY_URL, "git-setup")}
              />
              <SettingsActionRow
                icon="checkmark.circle"
                label="Test connection"
                description="Runs ssh -T git@github.com"
                loading={busy === "test"}
                disabled={busy !== null}
                onPress={testConnection}
              />
              {test ? (
                <View className="gap-1 px-4 py-3">
                  <Text
                    accessibilityRole="alert"
                    className={
                      test.ok ? "text-sm text-foreground" : "text-sm text-danger-foreground"
                    }
                  >
                    {test.summary}
                  </Text>
                  <Text selectable className="font-mono text-xs text-foreground-muted">
                    {test.output}
                  </Text>
                </View>
              ) : null}
              <SettingsActionRow
                icon="arrow.clockwise"
                label="Replace key"
                disabled={busy !== null}
                onPress={() => confirmReplaceKey(() => createKey(true))}
              />
              <SettingsActionRow
                icon="trash"
                label="Delete key"
                tone="danger"
                disabled={busy !== null}
                onPress={deleteKey}
              />
            </>
          ) : (
            <SettingsActionRow
              icon="key"
              label={status.keyExists ? "Replace incomplete key" : "Create SSH key"}
              description={
                status.keyExists
                  ? "A private key exists without its .pub file"
                  : `ed25519 at ${status.keyPath}`
              }
              loading={busy === "key"}
              disabled={busy !== null}
              onPress={() => createKey(false)}
            />
          )}
        </>
      ) : null}
    </SettingsSection>
  );
}
