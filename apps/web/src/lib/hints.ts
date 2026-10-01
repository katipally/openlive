"use client";

import type { AgentMetaWire, ErrorClass } from "@openlive/shared";
import { useUi } from "@/lib/uiStore";

// One small hints engine: a PURE selector from live-session state to at most
// one contextual chip — ERROR RECOVERY with a one-tap fix. Nothing else:
// permission asks and mid-thought holds have dedicated surfaces, keyboard
// coaching died with the push-to-talk opt-in toggle, and the agent's slash
// commands proved noise in practice (skill ids nobody would "say").
export interface Hint {
  id: string;
  text: string;
  action?: { label: string; run: () => void };
  dismissable?: boolean;
}

export interface HintInputs {
  phase: string;               // idle | listening | thinking | speaking | connecting…
  active: boolean;
  boundAgent: string | null;
  agentMeta: AgentMetaWire | null;
  error?: string;
  /** Why it failed, when the brain said: it decides the hint, and `error` only when there is none. */
  errorCode?: ErrorClass;
}

// A coding agent that could not start or stayed down: its own settings are the fix.
const AGENT_DOWN: ReadonlySet<ErrorClass> = new Set(["agent_start_failed", "agent_start_timeout", "agent_no_output", "agent_stalled", "agent_crashed"]);

// The `code` on an error says which fix applies; the words are the fallback for a brain that sent none.
function errorHint(error: string, code: ErrorClass | undefined, agent: boolean): Hint | null {
  const openAgents = () => useUi.getState().openSettingsTab("agents");
  const agentDown = code ? AGENT_DOWN.has(code) || (code === "auth" && agent)
    : /installed|signed in|sign in|exited before connecting|isn't running|not running/i.test(error);
  if (agentDown) return { id: "err-agent", text: error, action: { label: "Open Agents settings", run: openAgents } };
  if (code ? code === "agent_no_folder" : /pick a project folder/i.test(error)) {
    return { id: "err-folder", text: error }; // the lobby's folder field is right there
  }
  return { id: "err", text: error };
}

/** At most ONE hint (error recovery only). Pure — callers pass store state in. */
export function selectHints(s: HintInputs): Hint[] {
  const out: Hint[] = [];

  if (s.error) {
    const e = errorHint(s.error, s.errorCode, !!s.boundAgent);
    if (e) out.push(e);
  }

  return out.slice(0, 1);
}
