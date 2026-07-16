import { homedir } from "node:os";
import { getSetting, setSetting } from "@openlive/db";
import { AcpAgent } from "./acp-agent.js";
import { AgentSupervisor } from "./supervisor.js";
import type { Agent, AgentId, AgentMeta, AskPermission } from "./types.js";

export type { Agent, AgentId, AgentMeta, AskPermission } from "./types.js";

export const AGENTS: { id: AgentId; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
];

const isAgentId = (x: string | undefined): x is AgentId => AGENTS.some((a) => a.id === x);

/** Which agent a conversation is bound to (null = the built-in provider brain). */
export function boundAgent(chatId: string): AgentId | null {
  const v = getSetting(`bind:${chatId}`);
  return isAgentId(v) ? v : null;
}
export function setBoundAgent(chatId: string, id: AgentId | null): void {
  setSetting(`bind:${chatId}`, id ?? "");
}

/** The project folder a conversation's agent runs in: per-chat → global default → home. */
export function agentCwd(chatId: string): string {
  return getSetting(`agentCwd:${chatId}`)?.trim() || getSetting("agentCwd")?.trim() || homedir();
}

/** Build the bound agent wrapped in the reliability supervisor, or null when the
 *  conversation runs on the built-in provider brain. Reads cwd/session fresh per
 *  factory call so a supervisor restart (or a folder switch) picks up the latest.
 *  `startMs` is generous: a first `npx` run may download the adapter. */
export function createBoundAgent(chatId: string, askPermission: AskPermission, onMeta?: (meta: AgentMeta) => void): Agent | null {
  const id = boundAgent(chatId);
  if (!id) return null;
  return new AgentSupervisor(() => new AcpAgent(id, askPermission, {
    onSession: (sid) => setSetting(`acpSession:${chatId}`, sid),
    resumeSessionId: getSetting(`acpSession:${chatId}`)?.trim() || undefined,
    cwd: agentCwd(chatId),
    onMeta,
  }), { startMs: 60_000 });
}
