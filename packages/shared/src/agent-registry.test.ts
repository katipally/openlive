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

test("hermes runs through its launcher, and Install uses the official installer", () => {
  // Regression: the adapter/bins used to be `hermes-acp`, which the official
  // installer (git clone + venv) never puts on PATH — hermes showed as "not
  // installed" on a machine where it plainly was. The `hermes` launcher is the
  // one thing every install method provides; `acp` is its ACP entry point.
  assert.equal(adapterCommand("hermes"), "hermes acp");
  assert.ok(AGENT_REGISTRY.hermes.bins.includes("hermes"));
  for (const shell of [AGENT_REGISTRY.hermes.install?.posixShell, AGENT_REGISTRY.hermes.install?.winShell]) {
    assert.match(String(shell), /hermes-agent\.nousresearch\.com\/install\./);
  }
});

test("install recipes actually install (a wizard is sign-in, not an install)", () => {
  // Regression: hermes' Install used to run its setup wizard, so clicking Install
  // on an uninstalled agent just asked you to sign in and installed nothing.
  for (const a of AGENT_LIST) {
    if (!a.install) continue;
    assert.ok(a.install.npm || a.install.posixShell || a.install.winShell,
      `${a.id}: Install must run a real install, not only an interactive flow`);
  }
});

test("cred probes are well-formed (paths ~-relative, anyOf non-empty, patterns compile)", () => {
  const check = (p: (typeof AGENT_REGISTRY)["codex"]["credProbe"]): void => {
    if (p.kind === "anyOf") { assert.ok(p.probes.length > 0); p.probes.forEach(check); return; }
    if (p.kind === "keychain") { assert.ok(p.service.trim()); return; }
    if (p.kind === "fileMatch") assert.doesNotThrow(() => new RegExp(p.pattern, "m"));
    assert.ok(p.path.startsWith("~"), `probe paths must be home-relative: ${p.path}`);
  };
  for (const a of AGENT_LIST) check(a.credProbe);
});

test("hermes cred patterns match real setups and reject pre-setup defaults", () => {
  // Regression: probing only auth.json showed "Setup incomplete" on a machine
  // where `hermes setup` had configured an API-key provider (key in ~/.hermes/.env,
  // provider in config.yaml — auth.json is only written for OAuth providers).
  const probes = AGENT_REGISTRY.hermes.credProbe;
  assert.ok(probes.kind === "anyOf");
  const [env, cfg] = probes.probes as unknown as [{ pattern: string }, { pattern: string }];
  const envRe = new RegExp(env.pattern, "m");
  assert.ok(envRe.test("FOO=bar\nMINIMAX_API_KEY=sk-abc123"));
  assert.ok(!envRe.test("# MINIMAX_API_KEY=sk-abc123\nGOOGLE_API_KEY="));
  const cfgRe = new RegExp(cfg.pattern, "m");
  assert.ok(cfgRe.test("model:\n  default: MiniMax-M3\n  provider: minimax"));
  assert.ok(cfgRe.test('model:\n  provider: "lmstudio"'));
  assert.ok(!cfgRe.test('model:\n  provider: "auto"'));
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
