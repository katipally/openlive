import type { Message } from "@openlive/harness";
import type { Emit } from "../tools.js";

// An "agent" is an external coding agent (Claude Code / Codex / Cursor) driven as
// the brain of a live conversation, in place of the built-in provider LLM loop.
// Everything it says flows through the existing Emit stream (text/tool chips render
// for free) and cancel is the same AbortSignal barge-in already uses, so LiveSession
// treats an agent turn exactly like a provider turn.
export type AgentId = "claude-code" | "codex" | "cursor";

export type TurnFrame = { data: string; mime: string; source?: "camera" | "screen" };
export type TurnInput = { text: string; frames: TurnFrame[] };

export interface Agent {
  readonly id: AgentId;
  /** Spawn + ACP handshake. Resolving means "ready to take turns". */
  start(signal: AbortSignal): Promise<void>;
  /** Best-effort context restore on reconnect (text-only history). */
  seed(history: Message[]): void;
  runTurn(input: TurnInput, emit: Emit, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
  /** Liveness — the child process is alive. */
  health?(): { ok: boolean; detail?: string };
  /** Switch the agent's model / mode / config option mid-session. */
  setModel?(modelId: string): Promise<void>;
  setMode?(modeId: string): Promise<void>;
  setOption?(optionId: string, valueId: string): Promise<void>;
}

/** Ask the user to approve something the agent wants to do (spoken + chips in the
 *  call UI). Resolves the chosen option id; times out / cancels to "deny". */
export type AskPermission = (question: string, options: { id: string; label: string }[]) => Promise<string>;

/** How to handle an agent's permission requests. */
export type Posture = "ask" | "auto-safe" | "auto-all";

/** A generic selectable agent config option (thought/reasoning level, model config,
 *  …) beyond the dedicated model + mode pickers. */
export interface AgentOption {
  id: string;                 // ACP configId to set
  label: string;
  category: string;           // "thought_level" | "model_config" | …
  values: { id: string; name: string }[];
  currentId: string | null;
}

/** The agent's selectable models + modes + config options, surfaced once connected. */
export interface AgentMeta {
  models: { id: string; name: string }[];
  currentModelId: string | null;
  modes: { id: string; name: string }[];
  currentModeId: string | null;
  options: AgentOption[];
}
