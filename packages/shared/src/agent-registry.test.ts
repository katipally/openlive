// Guards the agent registry — the single source of agent identity everything
// (driver, API routes, UI) reads. The claude pin test is load-bearing: OpenLive
// relies on claude-agent-acp@0.81.2's `_meta.claudeCode.options` passthrough, and
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

test("the npx adapter PINS are intact (byte-identical)", () => {
  assert.equal(adapterCommand("claude-code"), "npx -y @agentclientprotocol/claude-agent-acp@0.81.2");
  assert.equal(adapterCommand("codex"), "npx -y @agentclientprotocol/codex-acp@1.13.1");
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
    const readOnly = a.sessionParser.endsWith("sqlite") || a.sessionParser === "none";
    assert.equal(a.externalDeletable, !readOnly, `${a.id}: never delete inside a live sqlite db or a store OpenLive does not parse`);
  }
});

test("gemini, copilot, kiro and pi start through their documented ACP entry points", () => {
  assert.equal(adapterCommand("gemini"), "gemini --acp");
  assert.equal(adapterCommand("copilot"), "copilot --acp");
  assert.equal(adapterCommand("kiro"), "kiro-cli acp");
  // pi has no ACP of its own: the pinned pi-acp adapter bridges `pi --mode rpc`, so
  // the installed-check is for pi itself.
  assert.equal(adapterCommand("pi"), "npx -y pi-acp@0.0.34");
  assert.deepEqual(AGENT_REGISTRY.pi.bins, ["pi"]);
  assert.deepEqual(AGENT_REGISTRY.gemini.bins, ["gemini"]);
  assert.deepEqual(AGENT_REGISTRY.copilot.bins, ["copilot"]);
  assert.deepEqual(AGENT_REGISTRY.kiro.bins, ["kiro-cli"]);
});

test("npm-installed new agents use their real packages; kiro uses its official installer", () => {
  assert.equal(AGENT_REGISTRY.gemini.install?.npm, "@google/gemini-cli");
  assert.equal(AGENT_REGISTRY.copilot.install?.npm, "@github/copilot");
  assert.equal(AGENT_REGISTRY.pi.install?.npm, "@earendil-works/pi-coding-agent");
  for (const shell of [AGENT_REGISTRY.kiro.install?.posixShell, AGENT_REGISTRY.kiro.install?.winShell]) {
    assert.match(String(shell), /cli\.kiro\.dev\/install/);
  }
  assert.equal(AGENT_REGISTRY.kiro.uninstall, undefined, "no documented headless uninstaller");
});

test("copilot reads .mcp.json itself, and pi's adapter takes no client terminal", () => {
  assert.equal(AGENT_REGISTRY.copilot.acp.mcp, "native");
  assert.equal(AGENT_REGISTRY.pi.acp.terminal, false);
});

test("copilot, gemini and kiro cred patterns match real stores and reject signed-out ones", () => {
  const re = (a: "copilot" | "gemini" | "kiro", i: number) => {
    const probe = AGENT_REGISTRY[a].credProbe;
    const one = probe.kind === "anyOf" ? probe.probes[i]! : probe;
    assert.ok(one.kind === "fileMatch");
    return new RegExp(one.pattern, "m");
  };
  assert.ok(re("copilot", 0).test('{\n  "lastLoggedInUser": {\n    "host": "https://github.com"'));
  assert.ok(!re("copilot", 0).test('{\n  "askedSetupTerminals": true\n}'));
  assert.ok(re("gemini", 1).test('{ "security": { "auth": { "selectedType": "oauth-personal" } } }'));
  assert.ok(!re("gemini", 1).test('{ "security": { "auth": {} } }'));
  assert.ok(re("gemini", 2).test("export GEMINI_API_KEY=abc"));
  assert.ok(!re("gemini", 2).test("# GEMINI_API_KEY=abc\nGEMINI_API_KEY="));
  assert.ok(re("kiro", 0).test("\0kirocli:odic:token\0{...}"));
  assert.ok(!re("kiro", 0).test("\0kirocli:odic:device-registration\0"));
});

test("helpers: isAgentId / agentLabel", () => {
  assert.ok(isAgentId("codex"));
  assert.ok(!isAgentId("emacs"));
  assert.equal(agentLabel("claude-code"), "Claude Code");
  assert.equal(agentLabel(null), "API mode");
  assert.equal(agentLabel("nope"), "API mode");
});
