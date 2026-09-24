import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENLIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "openlive-prov-"));

const { setSetting } = await import("@openlive/db");
const { liveReasoning, providerInfo, resolveLive } = await import("./providers");

// A local provider is keyless — picking it must not fall through to a keyed
// default the user never chose (issue #13: Ollama → "No API key for Anthropic").
describe("resolveLive", () => {
  beforeAll(async () => { await setSetting("liveProviderId", "ollama"); await setSetting("liveModel", "qwen3:8b"); });

  it("honours a keyless provider with no API keys configured", () => {
    const { provider, model, apiKey } = resolveLive();
    expect(provider.id).toBe("ollama");
    expect(provider.keyless).toBe(true);
    expect(model).toBe("qwen3:8b");
    expect(apiKey).toBeNull();
  });

  it("reaches Ollama at the configured address", async () => {
    await setSetting("ollamaBaseUrl", "http://nas.local:11434");
    expect(resolveLive().provider.baseURL).toBe("http://nas.local:11434/v1");
    await setSetting("ollamaBaseUrl", "");
    expect(resolveLive().provider.baseURL).toBe("http://localhost:11434/v1");
  });

  it("keeps the chosen provider when it has no key, rather than answering from another", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-not-a-real-key";
    await setSetting("liveProviderId", "openai");
    try {
      const { provider, apiKey } = resolveLive();
      expect(provider.id).toBe("openai");
      expect(apiKey).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
      await setSetting("liveProviderId", "ollama");
    }
  });
});

describe("liveReasoning", () => {
  const live = (id: string, model: string, effort?: "low" | "high") => ({ provider: providerInfo(id)!, model, apiKey: null, effort });

  it("sends no reasoning setting to a model without a reasoning channel", () => {
    expect(liveReasoning(live("ollama", "llama3.2", "high"))).toEqual({});
    expect(liveReasoning(live("openai", "gpt-4o", "high"))).toEqual({});
  });

  it("keeps auto as thinking off, in each provider's own form", () => {
    expect(liveReasoning(live("openai", "gpt-5"))).toEqual({ reasoningEffort: "minimal" });
    expect(liveReasoning(live("anthropic", "claude-sonnet-4-6"))).toEqual({});
  });

  it("passes a chosen effort through", () => {
    expect(liveReasoning(live("openai", "gpt-5", "high"))).toEqual({ reasoningEffort: "high" });
    expect(liveReasoning(live("anthropic", "claude-sonnet-4-6", "low"))).toEqual({ effort: "low" });
  });
});
