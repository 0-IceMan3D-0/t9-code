import { describe, expect, it } from "vite-plus/test";

import {
  claudeModelsToHide,
  OLLAMA_PROVIDER,
  PHONE_GPU_PROVIDER,
  planLocalInstance,
} from "./localModels";

const OLLAMA_INSTANCE_ID = OLLAMA_PROVIDER.instanceId;
const planOllamaInstance = (input: Parameters<typeof planLocalInstance>[1]) =>
  planLocalInstance(OLLAMA_PROVIDER, input);

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
      ANTHROPIC_BASE_URL: "http://127.0.0.1:11434",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3:1.7b",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3:4b",
    });
    expect(plan.instance.config).toEqual({ customModels: ["qwen3:1.7b", "qwen3:4b"] });
  });

  it("leaves the phone GPU's background requests to whichever model is loaded", () => {
    const plan = planLocalInstance(PHONE_GPU_PROVIDER, {
      providerInstances: {},
      installed: true,
      models,
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
