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
}

/** History grouped agent → workspace → session, for the left History sidebar.
 *  `source` distinguishes sessions started in OpenLive from an agent's own
 *  external sessions discovered on disk (which resume via ACP loadSession). */
export interface HistorySession {
  id: string;               // OpenLive chatId, or the agent's ACP sessionId (external)
  title: string;
  updatedAt: string;
  source: "openlive" | "external";
  resumeSessionId?: string; // agent ACP sessionId to loadSession (external), if any
}
export interface HistoryWorkspace {
  cwd: string;              // "" = no folder (legacy/none)
  sessions: HistorySession[];
}
export interface HistoryAgent {
  agentId: string | null;  // null = built-in OpenLive assistant
  label: string;
  workspaces: HistoryWorkspace[];
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

export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id?: string; tool: string; summary?: string; detail?: string; status: "running" | "done" };
