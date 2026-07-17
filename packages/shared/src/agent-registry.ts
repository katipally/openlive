// THE single source of truth for every coding agent OpenLive can drive.
// Everything that used to be scattered per-file (labels in six places, adapter
// commands in two, install recipes, session dirs, brand marks) lives here; the
// server driver, the API routes, and every UI surface read this one table — so
// adding an agent is one entry, and History/selectors/settings pick it up free.
// Pure serializable data: NO node imports (the browser bundles this). Node-only
// helpers (credential probing, PATH widening, terminal launch) live in ./node.

export const AGENT_IDS = ["claude-code", "codex", "cursor", "opencode", "hermes"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** How to tell — read-only, without spawning the agent — whether it's signed in. */
export type CredProbe =
  | { kind: "file"; path: string }                      // "~"-relative; exists → signed in
  | { kind: "json"; path: string; rule: "nonEmptyObject" | { hasKey: string } | { anyNonEmptyArrayUnder: string } }
  | { kind: "keychain"; service: string }               // macOS login keychain (exit code only — never reads the secret)
  | { kind: "anyOf"; probes: CredProbe[] };

/** Shell recipes per action. `npm` means global npm install/uninstall of that
 *  package; `terminal` opens the user's terminal running an INTERACTIVE flow
 *  (e.g. hermes' setup wizard) instead of streaming a headless command. */
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
  /** Which on-disk format its sessions use (drives History discovery). */
  sessionParser: "claude-jsonl" | "codex-rollout" | "cursor-meta" | "opencode-sqlite" | "hermes-sqlite";
  /** External sessions are plain files we may delete; sqlite-backed stores are
   *  the agent's live database — never written from OpenLive. */
  externalDeletable: boolean;
  credProbe: CredProbe;
  /** Extra "is it actually installed" probe ANDed with the PATH check — for
   *  agents whose runner binary alone proves nothing (hermes runs via uvx, so
   *  uv's presence ≠ hermes configured; its setup wizard creates ~/.hermes). */
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
    /** Extra env for the adapter process (e.g. Claude's entrypoint marker that
     *  files sessions where `claude --resume` finds them — verified 2026-07-15
     *  against claude 2.1.198 / adapter 0.59.0). */
    env?: Record<string, string>;
  };
}

// Facts verified 2026-07-16 against each tool's CLI on this machine (auth
// subcommands, credential store locations) and each ACP adapter's distribution.
// claude-agent-acp is PINNED: OpenLive relies on its `_meta.claudeCode.options`
// passthrough (native session persistence + system-prompt append, verified
// against 0.59.0) — an unpinned `npx -y` silently floats to whatever ships next.
// hermes is pinned for the same float-protection reason.
export const AGENT_REGISTRY: Record<AgentId, AgentDef> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    brand: { color: "#D97757" },
    logoSrc: "/agents/claude.svg",
    adapter: { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.59.0"] },
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
    adapter: { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] },
    bins: ["codex"],
    install: { npm: "@openai/codex" },
    uninstall: { npm: "@openai/codex" },
    login: "codex login",
    logout: "codex logout",
    sessionsDir: "~/.codex/sessions",
    sessionParser: "codex-rollout",
    externalDeletable: true,
    credProbe: { kind: "file", path: "~/.codex/auth.json" },
    acp: { resumeAcrossRestart: true, preamble: "firstMessage", mcp: "passthrough", terminal: true },
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
    acp: { resumeAcrossRestart: true, preamble: "firstMessage", mcp: "passthrough", terminal: true },
    startHint: "Make sure OpenCode is installed (opencode.ai) and signed in — run `opencode` in a terminal once.",
  },
  "hermes": {
    id: "hermes",
    label: "Hermes",
    brand: {},
    logoSrc: "/agents/hermes.svg",
    // Hermes runs via uvx (no persistent binary). uv on PATH alone proves
    // NOTHING about hermes — "installed" additionally requires ~/.hermes (the
    // setup wizard creates it). Install therefore IS the interactive setup:
    // it installs uv if missing, then walks provider selection, in a terminal.
    adapter: { command: "uvx", args: ["hermes-agent[acp]==0.18.2", "hermes-acp"] },
    bins: ["uvx"],
    installedProbe: { kind: "file", path: "~/.hermes" },
    install: {
      terminal: "command -v uvx >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh; uvx 'hermes-agent[acp]==0.18.2' hermes setup",
      // Windows/PowerShell: install uv via its .ps1 script, then run the setup wizard.
      winTerminal: "if (-not (Get-Command uvx -ErrorAction SilentlyContinue)) { irm https://astral.sh/uv/install.ps1 | iex }; uvx 'hermes-agent[acp]==0.18.2' hermes setup",
    },
    // Uninstall = remove its footprint. Everything hermes owns (credentials,
    // sessions, memories) lives under ~/.hermes; uvx caches the package itself,
    // so there is nothing else to remove. Destructive — the UI double-confirms.
    uninstall: {
      posixShell: "rm -rf ~/.hermes",
      winShell: 'if (Test-Path "$HOME\\.hermes") { Remove-Item -Recurse -Force "$HOME\\.hermes" }',
    },
    login: "uvx 'hermes-agent[acp]==0.18.2' hermes setup",
    winLogin: "uvx 'hermes-agent[acp]==0.18.2' hermes setup",
    // No logout — its setup wizard manages credentials in ~/.hermes.
    wizard: true,
    sessionsDir: "~/.hermes",
    sessionParser: "hermes-sqlite",
    externalDeletable: false,
    // A credential in the pool is NOT enough — hermes refuses to start until an
    // ACTIVE provider is selected (auth.json `providers` non-empty). Verified
    // against a machine with a pooled copilot credential but providers:{} —
    // hermes-acp prints "No LLM provider configured" and exits 0.
    credProbe: { kind: "json", path: "~/.hermes/auth.json", rule: { hasKey: "providers" } },
    acp: { resumeAcrossRestart: true, preamble: "firstMessage", mcp: "passthrough", terminal: true },
    startHint: "Hermes has no model provider selected. Run `uvx 'hermes-agent[acp]==0.18.2' hermes setup` (the Finish setup button in Settings → Agents) and pick a provider.",
  },
};

/** Canonical display/discovery order (History, selectors, settings). */
export const AGENT_LIST: AgentDef[] = AGENT_IDS.map((id) => AGENT_REGISTRY[id]);

export const isAgentId = (x: unknown): x is AgentId => typeof x === "string" && (AGENT_IDS as readonly string[]).includes(x);

/** Label for an agent id; null/unknown = the built-in OpenLive assistant. */
export const agentLabel = (id: string | null | undefined): string =>
  (id && isAgentId(id) && AGENT_REGISTRY[id].label) || "OpenLive";

/** The adapter command as one display string (settings placeholder, docs). */
export const adapterCommand = (id: AgentId): string => {
  const a = AGENT_REGISTRY[id].adapter;
  return [a.command, ...a.args].join(" ");
};
