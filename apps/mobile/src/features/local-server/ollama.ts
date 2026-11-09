import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  type ServerSettings,
} from "@t3tools/contracts";

export const OLLAMA_INSTANCE_ID = ProviderInstanceId.make("claudeOllama");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const OLLAMA_URL = "http://127.0.0.1:11434";

export interface OllamaModel {
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
  readonly models: ReadonlyArray<OllamaModel>;
  readonly pulling: string | null;
  readonly pullProgress: number;
  readonly pullDetail: string | null;
}

/** Small models that call tools well enough for Claude Code, smallest first. */
export const SUGGESTED_OLLAMA_MODELS = ["qwen3:1.7b", "qwen3:4b", "qwen3:8b"] as const;

export function formatModelSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/**
 * A Claude Code instance on the built-in server that talks to the phone's Ollama, whose
 * Anthropic-compatible API Claude Code can use. The smallest model answers Claude Code's own
 * background requests, which otherwise ask for a Claude model Ollama does not have.
 */
function ollamaInstance(
  models: ReadonlyArray<OllamaModel>,
  enabled: boolean,
): ProviderInstanceConfig {
  const bySize = [...models].sort((a, b) => a.size - b.size);
  const smallest = bySize[0]!.name;
  const largest = bySize[bySize.length - 1]!.name;
  const variables: ReadonlyArray<readonly [string, string]> = [
    ["ANTHROPIC_BASE_URL", OLLAMA_URL],
    ["ANTHROPIC_AUTH_TOKEN", "ollama"],
    ["ANTHROPIC_API_KEY", ""],
    ["ANTHROPIC_DEFAULT_HAIKU_MODEL", smallest],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL", largest],
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", largest],
    ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"],
    // Reading Claude Code's instructions takes a phone over ten minutes, Claude Code's default timeout.
    ["API_TIMEOUT_MS", "3600000"],
  ];
  return {
    driver: CLAUDE_DRIVER,
    displayName: "Ollama",
    enabled,
    environment: variables.map(([name, value]) => ({ name, value, sensitive: false })),
    config: { customModels: models.map((model) => model.name).sort() },
  };
}

/**
 * Keeps the Ollama instance matching what is installed: created with the first model, updated as
 * models come and go, and removed with Ollama. Returns null when nothing needs to change.
 */
export function planOllamaInstance(input: {
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly installed: boolean;
  readonly models: ReadonlyArray<OllamaModel>;
}): ProviderInstanceMutation | null {
  const current = input.providerInstances[OLLAMA_INSTANCE_ID];
  if (!input.installed) {
    return current ? { operation: "remove", instanceId: OLLAMA_INSTANCE_ID } : null;
  }
  if (input.models.length === 0) return null;
  const next = ollamaInstance(input.models, current?.enabled ?? true);
  if (current && JSON.stringify(ownedFields(current)) === JSON.stringify(ownedFields(next))) {
    return null;
  }
  return {
    operation: current ? "upsert" : "create",
    instanceId: OLLAMA_INSTANCE_ID,
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
 * The instance runs Claude Code, so the server also lists Claude's own models under it, and
 * Ollama has none of them. Returns the ones still to hide.
 */
export function ollamaModelsToHide(
  models: ReadonlyArray<{ readonly slug: string; readonly isCustom: boolean }>,
  hidden: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return models
    .filter((model) => !model.isCustom && !hidden.includes(model.slug))
    .map((model) => model.slug);
}
