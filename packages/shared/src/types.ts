// Domain types shared across the web app and agent service.

// A provider id from the harness registry (BUILTIN_PROVIDERS): "anthropic",
// "openai", "minimax".
export type ProviderKind = string;
export type MessageRole = "user" | "assistant" | "tool";

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Masked for display — never the plaintext key. */
  keyLast4: string | null;
  hasKey: boolean;
  isDefault: boolean;
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  /** Which agent this session talks to (null = the built-in OpenLive assistant). */
  agentId?: string | null;
  /** The workspace (project folder) this session belongs to. */
  cwd?: string;
  /** Last activity (for ordering); falls back to createdAt. */
  updatedAt?: string;
  /** The agent's OWN ACP session id (e.g. `claude --resume <uuid>`), captured on
   *  connect. Links an OpenLive chat to its on-disk agent session so History can
   *  dedup the two and "continue in the CLI" is possible. */
  agentSessionId?: string;
}

/** History grouped workspace → chat for the left History sidebar. All agents'
 *  chats for the same (realpath'd) workspace live together; each chat carries its
 *  agent so the row can show the right mark. `source` distinguishes chats started
 *  in OpenLive from an agent's own external sessions discovered on disk (which
 *  resume via ACP loadSession). */
export interface HistoryChat {
  id: string;               // OpenLive chatId, or the agent's ACP sessionId (external)
  title: string;
  updatedAt: string;
  agentId: string | null;   // null = built-in OpenLive assistant
  source: "openlive" | "external";
  resumeSessionId?: string; // agent ACP sessionId to loadSession (external), if any
}
export interface HistoryWorkspace {
  cwd: string;              // "" = no folder (legacy/none) — always sorted last
  chats: HistoryChat[];
}

/** A persisted/transported message. `content` is an array of blocks (below). */
export interface ChatMessage {
  id: string;
  chatId: string;
  role: MessageRole;
  content: MessageBlock[];
  live?: boolean;
  createdAt: string;
}

import type { ToolCallState } from "./tool-call";

export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id?: string; tool: string; summary?: string; detail?: string; status: "running" | "done" }
  // Rich ACP tool call (coding agents) — the final merged state, with terminal
  // output snapshotted in at persist time so old transcripts are self-contained.
  | { type: "acp_tool"; call: ToolCallState };
