import assert from "node:assert";
import { test } from "vitest";
import { initialAgentModel, resolveAgentModel } from "./agent-models";

const claude = [
  { id: "default", name: "Default (recommended)" },
  { id: "opus", name: "Opus" },
  { id: "fable", name: "Fable" },
  { id: "haiku", name: "Haiku" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
];

test("an id the agent still lists is kept", () => {
  assert.equal(resolveAgentModel("opus", claude), "opus");
  assert.equal(resolveAgentModel("claude-haiku-4-5-20251001", claude), "claude-haiku-4-5-20251001");
});

test("a bracketed suffix from an older adapter is dropped", () => {
  assert.equal(resolveAgentModel("opus[1m]", claude), "opus");
  assert.equal(resolveAgentModel("haiku[200k]", claude), "haiku");
});

test("an old versioned id finds its family, preferring the alias", () => {
  assert.equal(resolveAgentModel("claude-fable-5-1[1m]", claude), "fable");
  assert.equal(resolveAgentModel("claude-3-5-haiku-20241022", claude), "haiku");
});

test("a family the agent no longer offers resolves to nothing", () => {
  assert.equal(resolveAgentModel("claude-sonnet-4-5[1m]", claude), null);
  assert.equal(resolveAgentModel("gpt-5-codex", claude), null);
  assert.equal(resolveAgentModel("opus", []), null);
});

test("a word every entry holds does not decide", () => {
  const codex = [{ id: "gpt-5.5/high", name: "GPT-5.5 high" }, { id: "gpt-5.5-codex/high", name: "GPT-5.5 Codex high" }];
  assert.equal(resolveAgentModel("gpt-5.2-codex/high", codex), "gpt-5.5-codex/high");
  assert.equal(resolveAgentModel("gpt-4o", codex), null);
});

test("a new call starts on this chat's pick, else the saved default, else the agent's own", () => {
  assert.equal(initialAgentModel(claude, "default", "opus", "haiku"), "opus");
  assert.equal(initialAgentModel(claude, "default", undefined, "haiku"), "haiku");
  assert.equal(initialAgentModel(claude, "default"), "default");
});

test("a saved model the agent no longer offers falls to the next source", () => {
  assert.equal(initialAgentModel(claude, "default", "gpt-9", "haiku"), "haiku");
  assert.equal(initialAgentModel(claude, "default", undefined, "gpt-9"), "default");
  assert.equal(initialAgentModel(claude, null, "", ""), null);
});

test("a renamed saved default still lands on its family", () => {
  assert.equal(initialAgentModel(claude, "default", undefined, "opus[1m]"), "opus");
});
