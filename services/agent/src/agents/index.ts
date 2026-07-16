import { realpathSync } from "node:fs";
import { getSetting, setSetting, setChatAgentSession } from "@openlive/db";
import { AcpAgent } from "./acp-agent.js";
import { AgentSupervisor } from "./supervisor.js";
import type { Agent, AgentId, AgentMeta, AskPermission, ReplayMessage } from "./types.js";

export type { Agent, AgentId, AgentMeta, AskPermission, ReplayMessage } from "./types.js";
export { PERMISSION_CANCELLED } from "./types.js";

/** Callbacks a live session wires into a bound agent (streamed meta, recovered
 *  transcript on resume, non-fatal notices, agent-side title). */
export interface BoundHooks {
  onMeta?: (meta: AgentMeta) => void;
  onReplay?: (messages: ReplayMessage[]) => void;
}

export const AGENTS: { id: AgentId; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "opencode", label: "OpenCode" },
  { id: "hermes", label: "Hermes" },
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

/** The project folder a conversation's agent runs in: per-chat → global default.
 *  No $HOME fallback — an unset folder means "not ready to start" (the agent needs a
 *  real project so its session lands where `claude --resume` etc. can reopen it).
 *  Canonicalized (symlinks resolved, e.g. macOS /tmp→/private/tmp) so the path we
 *  store + group History by MATCHES the realpath agents record on disk — otherwise
 *  the same project splits into two workspace nodes. */
export function agentCwd(chatId: string): string {
  const raw = getSetting(`agentCwd:${chatId}`)?.trim() || getSetting("agentCwd")?.trim() || "";
  if (!raw) return "";
  try { return realpathSync.native(raw); } catch { return raw; }
}

/** Build the bound agent wrapped in the reliability supervisor, or null when the
 *  conversation runs on the built-in provider brain. Reads cwd/session fresh per
 *  factory call so a supervisor restart (or a folder switch) picks up the latest.
 *  `startMs` is generous: a first `npx` run may download the adapter. */
export function createBoundAgent(chatId: string, askPermission: AskPermission, hooks: BoundHooks = {}): Agent | null {
  const id = boundAgent(chatId);
  if (!id) return null;
  return new AgentSupervisor(() => new AcpAgent(id, askPermission, {
    // Persist the agent's OWN session id BOTH as the resume key and ON the chat row,
    // so History can dedup this chat against its on-disk agent session (and the id is
    // exactly what `claude --resume` reopens).
    onSession: (sid) => { setSetting(`acpSession:${chatId}`, sid); setChatAgentSession(chatId, sid); },
    resumeSessionId: getSetting(`acpSession:${chatId}`)?.trim() || undefined,
    cwd: agentCwd(chatId),
    onMeta: hooks.onMeta,
    onReplay: hooks.onReplay,
  }), { startMs: 60_000 });
}
