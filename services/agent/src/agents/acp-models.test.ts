import { strict as assert } from "node:assert";
import { test } from "vitest";
import { modelStateFrom } from "./acp-agent.js";

test("modelStateFrom: reads the ACP model-state shape", () => {
  const st = modelStateFrom({
    sessionId: "s1",
    models: {
      currentModelId: "custom:~x-ai/grok-latest",
      availableModels: [
        { modelId: "nous:anthropic/claude-fable-5.1", name: "Nous Portal · claude-fable-5.1", description: "Provider: Nous Portal" },
        { modelId: "custom:~x-ai/grok-latest", name: "Grok" },
      ],
    },
  });
  assert.ok(st);
  assert.equal(st.models.length, 2);
  assert.equal(st.models[0]!.id, "nous:anthropic/claude-fable-5.1");
  assert.equal(st.currentModelId, "custom:~x-ai/grok-latest");
});

test("modelStateFrom: falls back to the id when an entry has no name", () => {
  const st = modelStateFrom({ models: { availableModels: [{ modelId: "bare/model" }] } });
  assert.equal(st?.models[0]!.name, "bare/model");
  assert.equal(st?.currentModelId, null); // absent currentModelId is null, not undefined
});

test("modelStateFrom: null for agents that don't use this shape", () => {
  // Claude Code: models arrive as a config option, so `models` is absent entirely.
  assert.equal(modelStateFrom({ sessionId: "s1", configOptions: [] }), null);
  assert.equal(modelStateFrom({ models: { availableModels: [] } }), null);
  assert.equal(modelStateFrom({ models: {} }), null);
  assert.equal(modelStateFrom(null), null);
  assert.equal(modelStateFrom(undefined), null);
});

test("modelStateFrom: skips malformed entries rather than surfacing empty ids", () => {
  const st = modelStateFrom({ models: { availableModels: [{ name: "no id" }, { modelId: "" }, { modelId: "ok/one" }] } });
  assert.equal(st?.models.length, 1);
  assert.equal(st?.models[0]!.id, "ok/one");
});
