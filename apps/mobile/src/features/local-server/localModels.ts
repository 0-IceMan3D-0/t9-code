import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { fallbackTextGenerationModelSelection } from "@t3tools/shared/serverSettings";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/** A model server on the phone that speaks Anthropic's API, and its instance on the built-in server. */
export interface LocalModelProvider {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly baseUrl: string;
  /**
   * Sends Claude Code's background requests to the smallest model. The phone GPU holds one model
   * at a time and answers them with whichever is loaded, so it leaves this off.
   */
  readonly pinBackgroundModels: boolean;
}

export const OLLAMA_PROVIDER: LocalModelProvider = {
  instanceId: ProviderInstanceId.make("claudeOllama"),
  displayName: "Ollama",
  // The app's relay in front of Ollama; Claude Code drops Ollama's silent prompt reading.
  baseUrl: "http://127.0.0.1:11436",
  pinBackgroundModels: true,
};

export const PHONE_GPU_PROVIDER: LocalModelProvider = {
  instanceId: ProviderInstanceId.make("claudePhoneGpu"),
  displayName: "Phone GPU",
  baseUrl: "http://127.0.0.1:11435",
  pinBackgroundModels: false,
};

export interface LocalModel {
  readonly name: string;
  readonly size: number;
}

export interface OllamaState {
  readonly installed: boolean;
  readonly installing: boolean;
  readonly progress: number;
  readonly detail: string | null;
  readonly error: string | null;
  readonly running: boolean;
  readonly models: ReadonlyArray<LocalModel>;
  readonly pulling: string | null;
  readonly pullProgress: number;
  readonly pullDetail: string | null;
}

export interface PhoneModelsState {
  readonly catalog: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly bytes: number;
  }>;
  readonly installed: ReadonlyArray<string>;
  readonly downloading: string | null;
  readonly progress: number;
  readonly error: string | null;
  readonly running: boolean;
  readonly loaded: string | null;
  readonly contextTokens: number;
  readonly busy: boolean;
}

export function installedPhoneModels(state: PhoneModelsState): ReadonlyArray<LocalModel> {
  return state.catalog
    .filter((model) => state.installed.includes(model.id))
    .map((model) => ({ name: model.id, size: model.bytes }));
}

/** Small models that call tools well enough for Claude Code, smallest first. */
export const SUGGESTED_OLLAMA_MODELS = ["qwen3:1.7b", "qwen3:4b", "qwen3:8b"] as const;

export function formatModelSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/**
 * A Claude Code instance on the built-in server that talks to a model server on the phone through
 * Anthropic's API. Claude Code's own background requests otherwise ask for a Claude model the
 * phone does not have.
 */
function localInstance(
  provider: LocalModelProvider,
  models: ReadonlyArray<LocalModel>,
  contextTokens: number,
  enabled: boolean,
): ProviderInstanceConfig {
  const bySize = [...models].sort((a, b) => a.size - b.size);
  const smallest = bySize[0]!.name;
  const largest = bySize[bySize.length - 1]!.name;
  const variables: ReadonlyArray<readonly [string, string]> = [
    ["ANTHROPIC_BASE_URL", provider.baseUrl],
    ["ANTHROPIC_AUTH_TOKEN", "local"],
    ["ANTHROPIC_API_KEY", ""],
    ...(provider.pinBackgroundModels
      ? ([
          ["ANTHROPIC_DEFAULT_HAIKU_MODEL", smallest],
          ["ANTHROPIC_DEFAULT_SONNET_MODEL", largest],
          ["ANTHROPIC_DEFAULT_OPUS_MODEL", largest],
        ] as const)
      : []),
    ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"],
    // Reading Claude Code's instructions takes a phone's CPU over ten minutes, Claude Code's default timeout.
    ["API_TIMEOUT_MS", "3600000"],
    // Its default drops a stream that sends only pings for five minutes, less than a phone needs for the prompt.
    ["CLAUDE_STREAM_IDLE_TIMEOUT_MS", "3600000"],
    // Claude Code assumes 200K for a model it does not know, and would not summarize in time.
    ["CLAUDE_CODE_MAX_CONTEXT_TOKENS", String(contextTokens)],
    // It keeps this much of the context free for the reply; its default of 32K would leave no room for the prompt.
    ["CLAUDE_CODE_MAX_OUTPUT_TOKENS", "4096"],
  ];
  return {
    driver: CLAUDE_DRIVER,
    displayName: provider.displayName,
    enabled,
    environment: variables.map(([name, value]) => ({ name, value, sensitive: false })),
    config: { customModels: models.map((model) => model.name).sort() },
  };
}

/**
 * Keeps a local model instance matching what is installed: created with the first model, updated
 * as models come and go, and removed with the last one or the model server. Returns null when
 * nothing needs to change.
 */
export function planLocalInstance(
  provider: LocalModelProvider,
  input: {
    readonly providerInstances: ServerSettings["providerInstances"];
    readonly installed: boolean;
    readonly models: ReadonlyArray<LocalModel>;
    /** How many tokens the model server holds per conversation. */
    readonly contextTokens: number;
  },
): ProviderInstanceMutation | null {
  const current = input.providerInstances[provider.instanceId];
  if (!input.installed) {
    return current ? { operation: "remove", instanceId: provider.instanceId } : null;
  }
  if (input.models.length === 0) return null;
  const next = localInstance(provider, input.models, input.contextTokens, current?.enabled ?? true);
  if (current && JSON.stringify(ownedFields(current)) === JSON.stringify(ownedFields(next))) {
    return null;
  }
  return {
    operation: current ? "upsert" : "create",
    instanceId: provider.instanceId,
    instance: next,
  };
}

function ownedFields(instance: ProviderInstanceConfig) {
  return {
    driver: instance.driver,
    displayName: instance.displayName,
    environment: instance.environment?.map(({ name, value }) => [name, value]),
    config: instance.config,
  };
}

/**
 * The instance runs Claude Code, so the server also lists Claude's own models under it, and the
 * phone has none of them. Returns the ones still to hide.
 */
export function claudeModelsToHide(
  models: ReadonlyArray<{ readonly slug: string; readonly isCustom: boolean }>,
  hidden: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return models
    .filter((model) => !model.isCustom && !hidden.includes(model.slug))
    .map((model) => model.slug);
}

/**
 * The server falls back from a turned-off provider for thread titles, but not from one that is on
 * and missing, such as Codex on this phone. Returns the provider to use instead, if any.
 */
export function planTextGenerationFallback(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const usable = (instanceId: string) =>
    providers.some(
      (provider) =>
        provider.instanceId === instanceId &&
        provider.enabled &&
        provider.installed &&
        provider.status !== "error" &&
        provider.auth.status !== "unauthenticated",
    );
  const current = providers.find(
    (provider) => provider.instanceId === settings.textGenerationModelSelection.instanceId,
  );
  // The server leaves a provider it cannot find out of the list, such as Codex on this phone.
  if (
    providers.length === 0 ||
    (current !== undefined && (!current.enabled || current.installed))
  ) {
    return null;
  }
  return fallbackTextGenerationModelSelection(settings.providerInstances, usable, {
    defaultModelSelection: settings.defaultModelSelection,
  });
}
