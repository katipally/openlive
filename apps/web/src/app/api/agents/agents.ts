import { homedir } from "node:os";

// One registry for the Agents panel + its actions. Each agent runs on THIS machine
// with the user's own login; OpenLive just reports status and can install/remove the
// CLI or open its sign-in flow. Facts verified 2026-07-15 against each tool's docs.
export const AGENTS = [
  { id: "claude-code", label: "Claude Code", bins: ["claude"], sessions: "~/.claude", npm: "@anthropic-ai/claude-code", login: "claude auth login" },
  { id: "codex", label: "Codex", bins: ["codex"], sessions: "~/.codex/sessions", npm: "@openai/codex", login: "codex login" },
  // Cursor renamed its binary `cursor-agent` → `agent`; both land on PATH. No npm — a curl installer.
  { id: "cursor", label: "Cursor", bins: ["agent", "cursor-agent"], sessions: "~/.cursor", login: "agent login" },
] as const;

export type AgentDef = (typeof AGENTS)[number];
export type Action = "install" | "uninstall" | "login";

export const agentById = (id: string): AgentDef | undefined => AGENTS.find((a) => a.id === id);

// GUI-launched apps get a skeletal PATH on macOS; widen it like the agent driver does
// so an installed CLI in homebrew/npm/local still resolves.
export function widenedPath(): string {
  const extra = ["/usr/local/bin", "/opt/homebrew/bin", `${homedir()}/.local/bin`, `${homedir()}/bin`, `${homedir()}/.npm-global/bin`];
  const cur = (process.env.PATH ?? "").split(":");
  return [...cur, ...extra.filter((p) => !cur.includes(p))].join(":");
}

// The command to run for an action. install/uninstall are non-interactive (streamed
// inline). login is a browser OAuth flow that needs a real TTY, so on macOS we open
// Terminal.app running it; elsewhere we run it directly (best-effort).
// ponytail: cursor install/uninstall = curl script / rm symlinks — Cursor ships no
// npm package or uninstaller. Upgrade if they publish official ones.
export function actionCommand(a: AgentDef, action: Action): { cmd: string; args: string[] } | null {
  if (action === "login") {
    if (process.platform === "darwin")
      return { cmd: "osascript", args: ["-e", 'tell application "Terminal" to activate', "-e", `tell application "Terminal" to do script "${a.login}"`] };
    return { cmd: "bash", args: ["-lc", a.login] };
  }
  if (a.id === "cursor") {
    return action === "install"
      ? { cmd: "bash", args: ["-lc", "curl https://cursor.com/install -fsS | bash"] }
      : { cmd: "bash", args: ["-lc", "rm -f ~/.local/bin/agent ~/.local/bin/cursor-agent && echo 'Removed cursor-agent from ~/.local/bin.'"] };
  }
  if (!a.npm) return null;
  return { cmd: "npm", args: [action === "install" ? "install" : "uninstall", "-g", a.npm] };
}
