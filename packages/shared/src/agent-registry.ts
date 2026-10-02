// THE single source of truth for every coding agent OpenLive can drive.
// Everything that used to be scattered per-file (labels in six places, adapter
// commands in two, install recipes, session dirs, brand marks) lives here; the
// server driver, the API routes, and every UI surface read this one table — so
// adding an agent is one entry, and History/selectors/settings pick it up free.
// Pure serializable data: NO node imports (the browser bundles this). Node-only
// helpers (credential probing, PATH widening, terminal launch) live in ./node.

export const AGENT_IDS = ["claude-code", "codex", "cursor", "opencode", "hermes", "gemini", "copilot", "kiro", "pi"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** How to tell — read-only, without spawning the agent — whether it's signed in. */
export type CredProbe =
  | { kind: "file"; path: string }                      // "~"-relative; exists → signed in
  | { kind: "json"; path: string; rule: "nonEmptyObject" | { hasKey: string } | { anyNonEmptyArrayUnder: string } }
  | { kind: "fileMatch"; path: string; pattern: string } // any line matches the regex (multiline) → signed in
  | { kind: "keychain"; service: string }               // macOS login keychain (exit code only — never reads the secret)
  | { kind: "anyOf"; probes: CredProbe[] };

/** Shell recipes per action. `npm` means global npm install/uninstall of that
 *  package; `terminal` opens the user's terminal running an INTERACTIVE flow
 *  instead of streaming a headless command. NOTE: an install recipe must always
 *  be able to actually INSTALL headlessly — an interactive-only "install" is a
 *  sign-in wearing an Install button (see hermes' entry). */
export interface InstallRecipe { npm?: string; posixShell?: string; winShell?: string; terminal?: string; winTerminal?: string }

export interface AgentDef {
  id: AgentId;
  label: string;
  /** Brand mark: official color when the mark is colored; letter badge fallback
   *  for agents without a bundled mark (honest, not a made-up logo). */
  brand: { color?: string; letter?: string };
  /** Bundled brand mark under /public/agents (when one exists). */
  logoSrc?: string;
  /** The ACP adapter OpenLive spawns to talk to this agent (JSON-RPC over stdio). */
  adapter: { command: string; args: string[] };
  /** Binaries whose PATH presence means "installed" (any one suffices). */
  bins: string[];
  install?: InstallRecipe;
  uninstall?: InstallRecipe;
  /** CLI sign-in command — needs a real TTY/browser, so it runs in a terminal. */
  login: string;
  /** Windows PowerShell variant of `login`, when the POSIX one won't parse in
   *  PowerShell (e.g. hermes' pipeline/quoting). Falls back to `login`. */
  winLogin?: string;
  /** CLI sign-out command; absent → no Sign out affordance. */
  logout?: string;
  /** Where the agent keeps its own sessions (display + discovery root). */
  sessionsDir: string;
  /** Which on-disk format its sessions use (drives History discovery). `none`: no
   *  format read from disk; History relies on the agent's own ACP session/list. */
  sessionParser: "claude-jsonl" | "codex-rollout" | "cursor-meta" | "opencode-sqlite" | "hermes-sqlite" | "none";
  /** External sessions are plain files we may delete; sqlite-backed stores are
   *  the agent's live database — never written from OpenLive. */
  externalDeletable: boolean;
  credProbe: CredProbe;
  /** Extra "is it actually installed" probe ANDed with the PATH check — for
   *  agents whose runner binary alone proves nothing (e.g. an agent launched
   *  through a shared runner like uvx, where the runner's presence proves
   *  nothing about the agent itself). Currently unused. */
  installedProbe?: CredProbe;
  /** Sign-in IS the setup wizard (not a plain login): an aborted run can leave
   *  the agent half-configured, so the UI says "Setup incomplete"/"Finish
   *  setup" instead of "Sign in needed"/"Sign in". */
  wizard?: boolean;
  /** Actionable one-liner when the agent dies before the ACP handshake. */
  startHint: string;
  /** Per-agent ACP plumbing quirks — each agent plugged per its own spec, not
   *  generically. Read by the ACP driver (acp-agent.ts); pure data. */
  acp: {
    /** Sessions survive the agent process (loadSession after a restart works).
     *  Cursor advertises loadSession but its sessions die with the process. */
    resumeAcrossRestart: boolean;
    /** Where the voice-call preamble goes: Claude's adapter takes a system-prompt
     *  append via `_meta.claudeCode.options`; everyone else gets it prepended to
     *  the first user message. */
    preamble: "systemPrompt" | "firstMessage";
    /** MCP passthrough policy for session/new + session/load. "native" = the
     *  agent reads the project's .mcp.json itself (passing it again would
     *  double-register); "passthrough" = we read .mcp.json and pass it. */
    mcp: "native" | "passthrough";
    /** Advertise client-hosted terminals to this agent. */
    terminal: boolean;
    /** The adapter drops session mcpServers, so OpenLive's own servers reach the agent
     *  another way. `piExtension`: a per-session pi extension (see pi-bridge.ts). */
    mcpBridge?: "piExtension";
    /** Extra env for the adapter process (e.g. Claude's entrypoint marker that
     *  files sessions where `claude --resume` finds them — verified 2026-07-15
     *  against claude 2.1.198 / adapter 0.59.0). */
    env?: Record<string, string>;
    /** How a session that may only answer in text (Dictate's rewrite) starts with
     *  no tools: extra adapter args and env, and for Gemini a policy passed as
     *  `--policy <file>`. An agent without one keeps its tools with every ask
     *  refused. Claude's goes through `_meta.claudeCode.options` instead. */
    toolless?: { args?: string[]; env?: Record<string, string>; policyToml?: string };
  };
}

// Codex's tools as features, each switched off; checked with `codex -c ... features
// list` against codex 0.156.1, the one codex-acp 1.13.1 bundles. Its config takes
// dotted keys, as `-c` does.
const CODEX_NO_TOOLS = {
  ...Object.fromEntries(["shell_tool", "unified_exec", "multi_agent", "apps", "plugins", "browser_use", "in_app_browser", "computer_use", "image_generation", "view_image", "goals", "skill_search", "tool_suggest", "sleep_tool"].map((f) => [`features.${f}`, false])),
  web_search: "disabled",
  include_apply_patch_tool: false,
};

// Facts verified 2026-07-16 against each tool's CLI on this machine (auth
// subcommands, credential store locations) and each ACP adapter's distribution.
// The npx adapters are PINNED: an unpinned `npx -y` silently floats to whatever
// ships next. claude-agent-acp because OpenLive relies on its
// `_meta.claudeCode.options` passthrough (native session persistence +
// system-prompt append, read against 0.81.2's source); codex-acp so a release
// can't change the call under the user. Bump both deliberately.
export const AGENT_REGISTRY: Record<AgentId, AgentDef> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    brand: { color: "#D97757" },
    logoSrc: "/agents/claude.svg",
    adapter: { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.81.2"] },
    bins: ["claude"],
    install: { npm: "@anthropic-ai/claude-code" },
    uninstall: { npm: "@anthropic-ai/claude-code" },
    login: "claude auth login",
    logout: "claude auth logout",
    sessionsDir: "~/.claude",
    sessionParser: "claude-jsonl",
    externalDeletable: true,
    credProbe: {
      kind: "anyOf",
      probes: [
        { kind: "keychain", service: "Claude Code-credentials" }, // macOS
        { kind: "file", path: "~/.claude/.credentials.json" },    // Linux/Windows
      ],
    },
    acp: {
      resumeAcrossRestart: true,
      preamble: "systemPrompt",
      mcp: "native", // claude reads the project's .mcp.json itself
      terminal: true,
      env: { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" },
    },
    startHint: "Make sure Claude Code is installed and signed in (run `claude`).",
  },
  "codex": {
    id: "codex",
    label: "Codex",
    brand: {},
    logoSrc: "/agents/codex.svg",
    adapter: { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp@1.13.1"] },
    bins: ["codex"],
    install: { npm: "@openai/codex" },
    uninstall: { npm: "@openai/codex" },
    login: "codex login",
    logout: "codex logout",
    sessionsDir: "~/.codex/sessions",
    sessionParser: "codex-rollout",
    externalDeletable: true,
    credProbe: { kind: "file", path: "~/.codex/auth.json" },
    acp: {
      resumeAcrossRestart: true, preamble: "firstMessage", mcp: "passthrough", terminal: true,
      // codex-acp merges CODEX_CONFIG into each session's config; read-only asks before any write.
      toolless: { env: { CODEX_CONFIG: JSON.stringify(CODEX_NO_TOOLS), INITIAL_AGENT_MODE: "read-only" } },
    },
    startHint: "Make sure `codex` is installed and signed in (run `codex`).",
  },
  "cursor": {
    id: "cursor",
    label: "Cursor",
    brand: {},
    logoSrc: "/agents/cursor.svg",
    adapter: { command: "agent", args: ["acp"] },
    // Cursor renamed its binary `cursor-agent` → `agent`; both land on PATH.
    bins: ["agent", "cursor-agent"],
    // No npm package or uninstaller — a curl script installs into ~/.local/bin.
    install: {
      posixShell: "curl https://cursor.com/install -fsS | bash",
      winShell: "irm https://cursor.com/install -useb | iex",
    },
    uninstall: {
      posixShell: "rm -f ~/.local/bin/agent ~/.local/bin/cursor-agent && echo 'Removed cursor-agent from ~/.local/bin.'",
      winShell: "Remove-Item -Force \"$env:USERPROFILE\\.local\\bin\\agent.exe\",\"$env:USERPROFILE\\.local\\bin\\cursor-agent.exe\" -ErrorAction SilentlyContinue; echo 'Removed cursor-agent.'",
    },
    login: "agent login",
    logout: "agent logout",
    sessionsDir: "~/.cursor",
    sessionParser: "cursor-meta",
    externalDeletable: true,
    credProbe: { kind: "json", path: "~/.cursor/cli-config.json", rule: { hasKey: "authInfo" } },
    // resumeAcrossRestart false: advertises loadSession but sessions die with
    // the process (upstream "Session not found" after restart).
    acp: { resumeAcrossRestart: false, preamble: "firstMessage", mcp: "passthrough", terminal: true },
    startHint: "Its CLI may be outdated (needs ACP support) or signed out — update Cursor, then run `agent login`.",
  },
  "opencode": {
    id: "opencode",
    label: "OpenCode",
    brand: {},
    logoSrc: "/agents/opencode.svg",
    adapter: { command: "opencode", args: ["acp"] },
    bins: ["opencode"],
    install: { npm: "opencode-ai" },
    uninstall: { npm: "opencode-ai" },
    login: "opencode auth login",
    logout: "opencode auth logout",
    // Verified 2026-07-16 against opencode's docs: %USERPROFILE%\.local\share\opencode
    // on Windows too — the same "~"-relative path everywhere. Discovery also
    // honors $XDG_DATA_HOME (see agentSessions.ts).
    sessionsDir: "~/.local/share/opencode",
    sessionParser: "opencode-sqlite",
    externalDeletable: false,
    credProbe: { kind: "json", path: "~/.local/share/opencode/auth.json", rule: "nonEmptyObject" },
    // OPENCODE_PERMISSION merges into its permission config; with every one denied
    // `opencode debug agent build` lists no tool on (1.18.33).
    acp: { resumeAcrossRestart: true, preamble: "firstMessage", mcp: "passthrough", terminal: true, toolless: { env: { OPENCODE_PERMISSION: '{"*":"deny"}' } } },
    startHint: "Make sure OpenCode is installed (opencode.ai) and signed in — run `opencode` in a terminal once.",
  },
  "hermes": {
    id: "hermes",
    label: "Hermes",
    brand: {},
    logoSrc: "/agents/hermes.svg",
    // Hermes' official installer (hermes-agent.nousresearch.com) git-clones into
    // ~/.hermes/hermes-agent, builds a venv there, and puts ONE launcher on PATH:
    // `hermes` (~/.local/bin on POSIX; %LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts
    // on Windows, via User PATH). `hermes-acp` stays inside the venv — so the
    // adapter and the installed-check both go through `hermes` (its `acp`
    // subcommand is the documented ACP entry point). `hermes-acp` is kept in
    // `bins` for uv-tool installs (`uv tool install 'hermes-agent[acp]'`), which
    // put both console scripts on PATH.
    adapter: { command: "hermes", args: ["acp"] },
    bins: ["hermes", "hermes-acp"],
    install: {
      // The official installer — the same one hermes' site documents. --skip-setup
      // keeps it headless (sign-in stays the separate `hermes setup` step, like
      // every other agent). Idempotent: rerunning it updates the git checkout, so
      // Update = rerun (same pattern as cursor's curl install).
      posixShell: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup",
      winShell:
        '$s = Join-Path $env:TEMP "hermes-install.ps1"; irm https://hermes-agent.nousresearch.com/install.ps1 -OutFile $s; & $s -SkipSetup',
    },
    // Uninstall = remove the launcher, any legacy uv-tool install, AND the
    // footprint. Everything hermes owns (code, credentials, sessions, memories)
    // lives under ~/.hermes (%LOCALAPPDATA%\hermes on Windows). Destructive —
    // the UI double-confirms.
    uninstall: {
      posixShell: '"$(command -v uv || echo "$HOME/.local/bin/uv")" tool uninstall hermes-agent 2>/dev/null; rm -f ~/.local/bin/hermes; rm -rf ~/.hermes',
      winShell:
        "$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source; if ($uv) { & $uv tool uninstall hermes-agent 2>$null }; "
        + 'foreach ($d in @("$env:LOCALAPPDATA\\hermes", "$HOME\\.hermes")) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }',
    },
    login: "hermes setup",
    winLogin: "hermes setup",
    // No logout — its setup wizard manages credentials in ~/.hermes.
    wizard: true,
    sessionsDir: "~/.hermes",
    sessionParser: "hermes-sqlite",
    externalDeletable: false,
    // Hermes has THREE places a working provider can come from, and setup writes
    // whichever fits the chosen provider (verified against hermes 0.18.2 source):
    //   • ~/.hermes/.env      — API-key providers (MINIMAX_API_KEY=…, etc.)
    //   • ~/.hermes/config.yaml — an explicitly selected provider (anything ≠ "auto",
    //     which is the pre-setup default; covers keyless ones like lmstudio)
    //   • ~/.hermes/auth.json — OAuth providers (Nous Portal, Codex)
    // Probing only auth.json (the old probe) showed "Setup incomplete" on a fully
    // configured API-key install. ponytail: a config.yaml provider without its key
    // still reads as ready — hermes itself surfaces that error at session start.
    credProbe: {
      kind: "anyOf",
      probes: [
        { kind: "fileMatch", path: "~/.hermes/.env", pattern: "^[A-Z0-9_]*API_KEY=.+" },
        { kind: "fileMatch", path: "~/.hermes/config.yaml", pattern: "^\\s*provider:\\s*[\"']?(?!auto\\b)[a-z]" },
        { kind: "json", path: "~/.hermes/auth.json", rule: { hasKey: "providers" } },
      ],
    },
    acp: { resumeAcrossRestart: true, preamble: "firstMessage", mcp: "passthrough", terminal: true },
    startHint: "Hermes has no model provider selected. Run `hermes setup` (the Finish setup button in Settings → Agents) and pick a provider.",
  },
  "gemini": {
    id: "gemini",
    label: "Gemini CLI",
    brand: {},
    logoSrc: "/agents/gemini.svg",
    // `--acp` replaced `--experimental-acp` in 0.33.0 (2026-03-11); verified 2026-10-01
    // against 0.37.1 locally (initialize: loadSession, http + sse MCP, no session/list
    // or session/resume) and 0.62.0 in the ACP registry. The model list rides the
    // legacy `models` session state, not config options.
    adapter: { command: "gemini", args: ["--acp"] },
    bins: ["gemini"],
    install: { npm: "@google/gemini-cli" },
    uninstall: { npm: "@google/gemini-cli" },
    // No login subcommand: sign-in is the TUI's first-run auth picker.
    login: "gemini",
    sessionsDir: "~/.gemini",
    sessionParser: "none",
    externalDeletable: false,
    credProbe: {
      kind: "anyOf",
      probes: [
        { kind: "file", path: "~/.gemini/oauth_creds.json" },
        { kind: "fileMatch", path: "~/.gemini/settings.json", pattern: "\"selectedType\"\\s*:\\s*\"[^\"]+\"" },
        { kind: "fileMatch", path: "~/.gemini/.env", pattern: "^(export\\s+)?(GEMINI|GOOGLE)_API_KEY=.+" },
      ],
    },
    acp: {
      resumeAcrossRestart: true, preamble: "firstMessage", mcp: "passthrough", terminal: true,
      // Its policy engine's `*` matches every tool, built-in or MCP, and a deny
      // takes the tool out of the model's view (docs/reference/policy-engine.md, 0.37.1).
      toolless: { policyToml: '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n' },
    },
    startHint: "Make sure Gemini CLI 0.33 or newer is installed and signed in (run `gemini` once and pick how to sign in).",
  },
  "copilot": {
    id: "copilot",
    label: "GitHub Copilot",
    brand: {},
    logoSrc: "/agents/copilot.svg",
    // Public preview; verified 2026-10-01 against 1.0.88 locally (initialize:
    // loadSession, session/list and close, http + sse MCP, no session/resume) and
    // 1.0.90 in the ACP registry. Reads the project's .mcp.json itself.
    adapter: { command: "copilot", args: ["--acp"] },
    bins: ["copilot"],
    install: { npm: "@github/copilot" },
    uninstall: { npm: "@github/copilot" },
    login: "copilot login",
    sessionsDir: "~/.copilot",
    sessionParser: "none",
    externalDeletable: false,
    // The token lives in the system credential store; config.json (commented JSON)
    // keeps the signed-in user. GH_TOKEN-style env auth is not visible here.
    credProbe: { kind: "fileMatch", path: "~/.copilot/config.json", pattern: "^\\s*\"lastLoggedInUser\"\\s*:\\s*\\{" },
    acp: {
      resumeAcrossRestart: true, preamble: "firstMessage", mcp: "native", terminal: true,
      // `copilot help permissions` (1.0.91): a kind with no argument denies all of it,
      // without asking. Reads and the user's own MCP servers stay, every ask refused.
      toolless: { args: ["--deny-tool=shell", "--deny-tool=write", "--deny-tool=url", "--disable-builtin-mcps"] },
    },
    startHint: "Make sure GitHub Copilot CLI is installed and signed in (run `copilot login`).",
  },
  "kiro": {
    id: "kiro",
    label: "Kiro",
    brand: {},
    logoSrc: "/agents/kiro.svg",
    // Plain `kiro-cli acp` is the V2 engine (V3 is opt-in via --agent-engine=v3 and
    // moves set_model to set_config_option); initialize reports loadSession and
    // http MCP (docs + 2.x captures, not run locally). Sign-in is `kiro-cli login`.
    adapter: { command: "kiro-cli", args: ["acp"] },
    bins: ["kiro-cli"],
    // The Windows installer is a per-machine MSI, so it needs an elevated shell.
    // No documented headless uninstaller.
    install: {
      posixShell: "curl -fsSL https://cli.kiro.dev/install | bash",
      winShell: "irm 'https://cli.kiro.dev/install.ps1' | iex",
    },
    login: "kiro-cli login",
    logout: "kiro-cli logout",
    sessionsDir: "~/.kiro/sessions/cli",
    sessionParser: "none",
    externalDeletable: false,
    // Tokens sit in the auth_kv table of kiro-cli's sqlite store, whose folder
    // differs per OS. Row keys are plain text, so a pattern on the file finds them.
    credProbe: {
      kind: "anyOf",
      probes: ["~/Library/Application Support/kiro-cli", "~/.local/share/kiro-cli", "~/AppData/Roaming/kiro-cli"].map((dir) => (
        { kind: "fileMatch", path: `${dir}/data.sqlite3`, pattern: "(kirocli|codewhisperer):(odic|social):token" } as const
      )),
    },
    acp: { resumeAcrossRestart: true, preamble: "firstMessage", mcp: "passthrough", terminal: true },
    startHint: "Make sure Kiro CLI is installed and signed in (run `kiro-cli login`).",
  },
  "pi": {
    id: "pi",
    label: "Pi",
    brand: {},
    logoSrc: "/agents/pi.svg",
    // Pi has no ACP of its own: pi-acp (svkozak, MIT, listed in the ACP registry)
    // spawns `pi --mode rpc` and bridges it, so `pi` must be on PATH too, 0.99 or newer
    // for OpenLive's tools. Pinned like the other npx adapters. The adapter drops
    // mcpServers, so OpenLive's tools reach pi through its own extension (mcpBridge).
    adapter: { command: "npx", args: ["-y", "pi-acp@0.0.34"] },
    bins: ["pi"],
    install: { npm: "@earendil-works/pi-coding-agent" },
    uninstall: { npm: "@earendil-works/pi-coding-agent" },
    // No login subcommand: pi's `/login` runs inside its TUI.
    login: "pi",
    sessionsDir: "~/.pi/agent/sessions",
    sessionParser: "none",
    externalDeletable: false,
    credProbe: {
      kind: "anyOf",
      probes: [
        { kind: "json", path: "~/.pi/agent/auth.json", rule: "nonEmptyObject" },
        { kind: "file", path: "~/.pi/agent/models.json" }, // a custom or local endpoint needs no login
      ],
    },
    // pi reads its own ~/.pi/agent/mcp.json and .pi/mcp.json, which the adapter ignores
    // in the wire, so passing .mcp.json would only be dropped.
    acp: { resumeAcrossRestart: true, preamble: "firstMessage", mcp: "native", terminal: false, mcpBridge: "piExtension" },
    startHint: "Make sure Pi 0.99 or newer is installed (npm i -g @earendil-works/pi-coding-agent) and has a provider (run `pi`, then /login).",
  },
};

/** Canonical display/discovery order (History, selectors, settings). */
export const AGENT_LIST: AgentDef[] = AGENT_IDS.map((id) => AGENT_REGISTRY[id]);

export const isAgentId = (x: unknown): x is AgentId => typeof x === "string" && (AGENT_IDS as readonly string[]).includes(x);

/** Label for an agent id; null/unknown = the built-in OpenLive assistant. */
export const agentLabel = (id: string | null | undefined): string =>
  (id && isAgentId(id) && AGENT_REGISTRY[id].label) || "API mode";

/** The adapter command as one display string (settings placeholder, docs). */
export const adapterCommand = (id: AgentId): string => {
  const a = AGENT_REGISTRY[id].adapter;
  return [a.command, ...a.args].join(" ");
};
