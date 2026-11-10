import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAgentTool, useLocalServerStatus, useOllama, usePhoneModels } from "./localServerModule";
import {
  claudeModelsToHide,
  installedPhoneModels,
  type LocalModel,
  type LocalModelProvider,
  OLLAMA_PROVIDER,
  PHONE_GPU_PROVIDER,
  planLocalInstance,
  planTextGenerationFallback,
} from "./localModels";
import { useLocalConnection } from "./useLocalConnection";

// A request the server keeps accepting without the change showing up stops here.
const MAX_ATTEMPTS = 3;
// The server may still be starting when the app opens, so a failed request is retried for a minute.
const RETRY_MS = 5_000;
const MAX_FAILURES = 12;

/**
 * Keeps a local model instance on the built-in server in step with the models on the phone, and
 * hides Claude's own models under it. One request carries both, so they cannot overwrite each other.
 */
function useLocalInstanceSync(
  provider: LocalModelProvider,
  environmentId: EnvironmentId | null,
  installed: boolean,
  models: ReadonlyArray<LocalModel> | undefined,
) {
  const config = useEnvironmentServerConfig(environmentId);
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });
  const attempts = useRef(new Map<string, number>());
  const failures = useRef(new Map<string, number>());
  const busy = useRef(false);
  const [settled, setSettled] = useState(0);
  const plan =
    config === null || models === undefined
      ? null
      : planLocalInstance(provider, {
          providerInstances: config.settings.providerInstances,
          installed,
          models,
        });
  const listed =
    config?.providers.find((entry) => entry.instanceId === provider.instanceId)?.models ??
    // A new instance runs Claude Code too, so it will list the same models as Claude.
    (plan?.operation === "create"
      ? (config?.providers.find(
          (entry) =>
            entry.driver === plan.instance.driver &&
            entry.instanceId !== OLLAMA_PROVIDER.instanceId &&
            entry.instanceId !== PHONE_GPU_PROVIDER.instanceId,
        )?.models ?? [])
      : []);
  const toHide =
    config === null || plan?.operation === "remove"
      ? []
      : claudeModelsToHide(
          listed,
          config.settings.providerModelPreferences?.[provider.instanceId]?.hiddenModels ?? [],
        );
  const requestKey = plan === null && toHide.length === 0 ? null : JSON.stringify({ plan, toHide });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the provider instance and its hidden models to the server when the phone's models change
  useEffect(() => {
    if (requestKey === null) {
      attempts.current.clear();
      failures.current.clear();
    }
    if (environmentId === null || requestKey === null || busy.current) return;
    const tries = attempts.current.get(requestKey) ?? 0;
    const failed = failures.current.get(requestKey) ?? 0;
    if (tries >= MAX_ATTEMPTS || failed >= MAX_FAILURES) return;
    busy.current = true;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the key stands for the plan and the list.
    void mutate({
      environmentId,
      input: {
        patch:
          toHide.length === 0
            ? {}
            : {
                setModelsHidden: toHide.map((model) => ({
                  provider: provider.instanceId,
                  model,
                  hidden: true,
                })),
              },
        ...(plan === null ? {} : { providerInstanceMutation: plan }),
      },
    }).then((result) => {
      if (result._tag === "Success") attempts.current.set(requestKey, tries + 1);
      else failures.current.set(requestKey, failed + 1);
      setTimeout(
        () => {
          busy.current = false;
          setSettled((count) => count + 1);
        },
        result._tag === "Success" ? 0 : RETRY_MS,
      );
    });
  }, [environmentId, requestKey, settled]);
}

/** Thread titles and commit messages on this phone use a provider that is installed here. */
function useTextGenerationFallback(environmentId: EnvironmentId | null) {
  const config = useEnvironmentServerConfig(environmentId);
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
    reportDefect: false,
  });
  const done = useRef(new Set<string>());
  const failures = useRef(0);
  const busy = useRef(false);
  const [settled, setSettled] = useState(0);
  const fallback =
    config === null ? null : planTextGenerationFallback(config.settings, config.providers);
  const key = fallback === null ? null : `${fallback.instanceId}/${fallback.model}`;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the server's title provider when the current one is not installed
  useEffect(() => {
    if (environmentId === null || key === null || busy.current || done.current.has(key)) return;
    if (failures.current >= MAX_FAILURES) return;
    busy.current = true;
    void update({
      environmentId,
      // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the key stands for the fallback.
      input: { patch: { textGenerationModelSelection: { ...fallback, options: [] } } },
    }).then((result) => {
      if (result._tag === "Success") done.current.add(key);
      else failures.current += 1;
      setTimeout(
        () => {
          busy.current = false;
          setSettled((count) => count + 1);
        },
        result._tag === "Success" ? 0 : RETRY_MS,
      );
    });
  }, [environmentId, key, settled]);
}

/** Mounted for the app's lifetime, so the model picker matches the phone's models from any screen. */
export function LocalModelsCoordinator() {
  const status = useLocalServerStatus();
  const ollama = useOllama();
  const phone = usePhoneModels();
  // Both instances run Claude Code, so they only exist while it is installed in Linux.
  const claudeInstalled = useAgentTool("claude")?.installed ?? false;
  const connection = useLocalConnection(status?.state === "running" ? status.port : undefined);
  const environmentId = connection?.environmentId ?? null;
  const phoneModels = phone === null ? undefined : installedPhoneModels(phone);
  useLocalInstanceSync(
    OLLAMA_PROVIDER,
    environmentId,
    claudeInstalled && (ollama?.installed ?? false),
    ollama?.models,
  );
  useLocalInstanceSync(
    PHONE_GPU_PROVIDER,
    environmentId,
    claudeInstalled && (phoneModels?.length ?? 0) > 0,
    phoneModels,
  );
  useTextGenerationFallback(environmentId);
  return null;
}
