// Guards the agent registry — the single source of agent identity everything
// (driver, API routes, UI) reads. The claude pin test is load-bearing: OpenLive
// relies on claude-agent-acp@0.59.0's `_meta.claudeCode.options` passthrough, and
// a drifted pin silently breaks native session persistence / `claude --resume`.
import assert from "node:assert";
import { test } from "vitest";
import { AGENT_IDS, AGENT_LIST, AGENT_REGISTRY, adapterCommand, agentLabel, isAgentId } from "./agent-registry";

test("every agent id has a complete registry entry", () => {
  for (const id of AGENT_IDS) {
    const a = AGENT_REGISTRY[id];
    assert.equal(a.id, id);
    assert.ok(a.label.trim());
    assert.ok(a.adapter.command.trim());
    assert.ok(a.bins.length > 0);
    assert.ok(a.login.trim());
    assert.ok(a.sessionsDir.startsWith("~"));
    assert.ok(a.startHint.trim());
    // A bundled mark (logoSrc) or a letter badge — every agent renders somehow.
    assert.ok(a.logoSrc || a.brand.letter, `${id} needs a bundled mark or letter fallback`);
  }
  assert.deepEqual(AGENT_LIST.map((a) => a.id), [...AGENT_IDS]);
});

test("the claude adapter PIN is intact (byte-identical)", () => {
  assert.equal(adapterCommand("claude-code"), "npx -y @agentclientprotocol/claude-agent-acp@0.59.0");
});

test("the hermes adapter PIN is intact", () => {
  assert.equal(adapterCommand("hermes"), "uvx hermes-agent[acp]==0.18.2 hermes-acp");
});

test("cred probes are well-formed (paths ~-relative, anyOf non-empty)", () => {
  const check = (p: (typeof AGENT_REGISTRY)["codex"]["credProbe"]): void => {
    if (p.kind === "anyOf") { assert.ok(p.probes.length > 0); p.probes.forEach(check); return; }
    if (p.kind === "keychain") { assert.ok(p.service.trim()); return; }
    assert.ok(p.path.startsWith("~"), `probe paths must be home-relative: ${p.path}`);
  };
  for (const a of AGENT_LIST) check(a.credProbe);
});

test("only file-backed session stores are externally deletable", () => {
  for (const a of AGENT_LIST) {
    const sqlite = a.sessionParser.endsWith("sqlite");
    assert.equal(a.externalDeletable, !sqlite, `${a.id}: never delete inside a live sqlite db`);
  }
});

test("helpers: isAgentId / agentLabel", () => {
  assert.ok(isAgentId("codex"));
  assert.ok(!isAgentId("emacs"));
  assert.equal(agentLabel("claude-code"), "Claude Code");
  assert.equal(agentLabel(null), "OpenLive");
  assert.equal(agentLabel("nope"), "OpenLive");
});
