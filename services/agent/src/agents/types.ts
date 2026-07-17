import type { Message } from "@openlive/harness";
import type { MessageBlock } from "@openlive/shared";
import type { Emit } from "../tools.js";

// An "agent" is an external coding agent (Claude Code / Codex / Cursor / …) driven
// as the brain of a live conversation, in place of the built-in provider LLM loop.
// Everything it says flows through the existing Emit stream (text/tool chips render
// for free) and cancel is the same AbortSignal barge-in already uses, so LiveSession
// treats an agent turn exactly like a provider turn.
// Agent identity (ids, labels, adapters, install/auth) lives in the shared registry.
import type { AgentId } from "@openlive/shared";
export type { AgentId };

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
  /** Switch the agent's model / mode / config option mid-session. */
  setModel?(modelId: string): Promise<void>;
  setMode?(modeId: string): Promise<void>;
  setOption?(optionId: string, valueId: string): Promise<void>;
}

/** Ask the user to approve something the agent wants to do (spoken + chips in the
 *  call UI). Resolves the chosen option id; times out / cancels to "deny". */
export type AskPermission = (question: string, options: { id: string; label: string }[]) => Promise<string>;

/** Sentinel a pending permission ask resolves to when the turn is cancelled
 *  (barge-in / interrupt). ACP requires the client to answer any in-flight
 *  request_permission with the `cancelled` outcome — this maps to that. */
export const PERMISSION_CANCELLED = "__acp_cancelled__";

/** A generic selectable agent config option (thought/reasoning level, model config,
 *  …) beyond the dedicated model + mode pickers. */
export interface AgentOption {
  id: string;                 // ACP configId to set
  label: string;
  category: string;           // "thought_level" | "model_config" | …
  values: { id: string; name: string }[];
  currentId: string | null;
}

/** The agent's selectable models + modes + config options, surfaced once
 *  connected. */
export interface AgentMeta {
  models: { id: string; name: string }[];
  currentModelId: string | null;
  modes: { id: string; name: string }[];
  currentModeId: string | null;
  options: AgentOption[];
  /** Whether resuming this session in the agent's own CLI works across process
   *  restarts. Claude: yes. Cursor: no (upstream limitation). Codex: best-effort. */
  resumeAcrossRestart: boolean;
}

/** A prior turn recovered from `session/load` replay, ready to persist + render. */
export interface ReplayMessage { role: "user" | "assistant"; content: MessageBlock[] }
