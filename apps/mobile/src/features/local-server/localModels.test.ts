import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeModelsToHide,
  OLLAMA_PROVIDER,
  PHONE_GPU_PROVIDER,
  planLocalInstance,
  planTextGenerationFallback,
} from "./localModels";

const OLLAMA_INSTANCE_ID = OLLAMA_PROVIDER.instanceId;
const planOllamaInstance = (
  input: Omit<Parameters<typeof planLocalInstance>[1], "contextTokens"> & {
    readonly contextTokens?: number;
  },
) => planLocalInstance(OLLAMA_PROVIDER, { contextTokens: 32_768, ...input });

const models = [
  { name: "qwen3:4b", size: 2_500_000_000 },
  { name: "qwen3:1.7b", size: 1_400_000_000 },
];

describe("planLocalInstance", () => {
  it("creates the instance with the first model and points Claude Code at Ollama", () => {
    const plan = planOllamaInstance({ providerInstances: {}, installed: true, models });
    expect(plan?.operation).toBe("create");
    if (plan?.operation !== "create") return;
    const env = Object.fromEntries(
      (plan.instance.environment ?? []).map((variable) => [variable.name, variable.value]),
    );
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:11436",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3:1.7b",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3:4b",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "32768",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
    });
    expect(plan.instance.config).toEqual({ customModels: ["qwen3:1.7b", "qwen3:4b"] });
  });

  it("leaves the phone GPU's background requests to whichever model is loaded", () => {
    const plan = planLocalInstance(PHONE_GPU_PROVIDER, {
      providerInstances: {},
      installed: true,
      models,
      contextTokens: 24_576,
    });
    if (plan?.operation !== "create") throw new Error("expected create");
    const names = (plan.instance.environment ?? []).map((variable) => variable.name);
    expect(names).toContain("ANTHROPIC_BASE_URL");
    expect(names).not.toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL");
  });

  it("changes nothing until the models change, and keeps the user's enabled choice", () => {
    const created = planOllamaInstance({ providerInstances: {}, installed: true, models });
    if (created?.operation !== "create") throw new Error("expected create");
    const providerInstances = {
      [OLLAMA_INSTANCE_ID]: { ...created.instance, enabled: false },
    };
    expect(planOllamaInstance({ providerInstances, installed: true, models })).toBeNull();
    expect(
      planOllamaInstance({ providerInstances, installed: true, models, contextTokens: 16_384 })
        ?.operation,
    ).toBe("upsert");
    const updated = planOllamaInstance({
      providerInstances,
      installed: true,
      models: models.slice(0, 1),
    });
    expect(updated?.operation).toBe("upsert");
    if (updated?.operation === "upsert") expect(updated.instance.enabled).toBe(false);
  });

  it("waits for a model, and removes the instance with Ollama", () => {
    expect(planOllamaInstance({ providerInstances: {}, installed: true, models: [] })).toBeNull();
    const created = planOllamaInstance({ providerInstances: {}, installed: true, models });
    if (created?.operation !== "create") throw new Error("expected create");
    expect(
      planOllamaInstance({
        providerInstances: { [OLLAMA_INSTANCE_ID]: created.instance },
        installed: false,
        models: [],
      }),
    ).toEqual({ operation: "remove", instanceId: OLLAMA_INSTANCE_ID });
  });
});

describe("claudeModelsToHide", () => {
  it("hides Claude's own models once, never the Ollama ones", () => {
    const models = [
      { slug: "claude-opus-5-5", isCustom: false },
      { slug: "claude-haiku-5-5", isCustom: false },
      { slug: "qwen3:1.7b", isCustom: true },
    ];
    expect(claudeModelsToHide(models, ["claude-haiku-5-5"])).toEqual(["claude-opus-5-5"]);
    expect(claudeModelsToHide(models, ["claude-opus-5-5", "claude-haiku-5-5"])).toEqual([]);
  });
});

describe("planTextGenerationFallback", () => {
  const provider = (driver: string, overrides: Partial<ServerProvider> = {}) =>
    ({
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "unknown" },
      ...overrides,
    }) as ServerProvider;

  it("moves titles off a provider that is on but not installed", () => {
    const providers = [
      provider("codex", { installed: false, status: "error" }),
      provider("claudeAgent", { auth: { status: "unauthenticated" } }),
      provider("opencode"),
    ];
    expect(planTextGenerationFallback(DEFAULT_SERVER_SETTINGS, providers)).toEqual({
      instanceId: "opencode",
      model: "opencode/big-pickle",
    });
  });

  it("moves titles off a provider the server does not list", () => {
    expect(planTextGenerationFallback(DEFAULT_SERVER_SETTINGS, [provider("opencode")])).toEqual({
      instanceId: "opencode",
      model: "opencode/big-pickle",
    });
    expect(planTextGenerationFallback(DEFAULT_SERVER_SETTINGS, [])).toBeNull();
  });

  it("keeps an installed provider, and leaves a turned-off one to the server", () => {
    expect(planTextGenerationFallback(DEFAULT_SERVER_SETTINGS, [provider("codex")])).toBeNull();
    expect(
      planTextGenerationFallback(DEFAULT_SERVER_SETTINGS, [
        provider("codex", { enabled: false, installed: false }),
        provider("opencode"),
      ]),
    ).toBeNull();
  });
});
