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

/** Shell recipes per action. `npm` means global npm install/uninstall of that package. */
export interface InstallRecipe { npm?: string; posixShell?: string; winShell?: string }

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
  /** Actionable one-liner when the agent dies before the ACP handshake. */
  startHint: string;
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
    // ponytail: xdg path assumed on Windows too; if opencode files elsewhere there,
    // make sessionsDir/credProbe per-platform maps (discovery degrades to "none").
    sessionsDir: "~/.local/share/opencode",
    sessionParser: "opencode-sqlite",
    externalDeletable: false,
    credProbe: { kind: "json", path: "~/.local/share/opencode/auth.json", rule: "nonEmptyObject" },
    startHint: "Make sure OpenCode is installed (opencode.ai) and signed in — run `opencode` in a terminal once.",
  },
  "hermes": {
    id: "hermes",
    label: "Hermes",
    brand: {},
    logoSrc: "/agents/hermes.svg",
    // Hermes runs via uvx (no persistent install) — "installed" means uv is present.
    adapter: { command: "uvx", args: ["hermes-agent[acp]==0.18.2", "hermes-acp"] },
    bins: ["uvx"],
    install: {
      posixShell: "curl -LsSf https://astral.sh/uv/install.sh | sh",
      winShell: "irm https://astral.sh/uv/install.ps1 | iex",
    },
    login: "uvx 'hermes-agent[acp]==0.18.2' hermes setup",
    // No logout — its setup wizard manages credentials in ~/.hermes.
    sessionsDir: "~/.hermes",
    sessionParser: "hermes-sqlite",
    externalDeletable: false,
    credProbe: {
      kind: "anyOf",
      probes: [
        { kind: "json", path: "~/.hermes/auth.json", rule: { anyNonEmptyArrayUnder: "credential_pool" } },
        { kind: "json", path: "~/.hermes/auth.json", rule: { hasKey: "providers" } },
      ],
    },
    startHint: "OpenLive runs Hermes via uvx. Install uv (astral.sh/uv), then run `uvx 'hermes-agent[acp]==0.18.2' hermes setup` once to pick a model provider.",
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
