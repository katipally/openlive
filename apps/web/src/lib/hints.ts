"use client";

import type { AgentMetaWire } from "@openlive/shared";
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
}

// ponytail: error → fix mapping matches the few known error strings; upgrade to
// structured error codes on the wire if these ever drift.
function errorHint(error: string): Hint | null {
  const openAgents = () => useUi.getState().openSettingsTab("agents");
  if (/installed|signed in|sign in|exited before connecting|isn't running|not running/i.test(error)) {
    return { id: "err-agent", text: error, action: { label: "Open Agents settings", run: openAgents } };
  }
  if (/pick a project folder/i.test(error)) {
    return { id: "err-folder", text: error }; // the lobby's folder field is right there
  }
  return { id: "err", text: error };
}

/** At most 2 hints, most useful first. Pure — callers pass store state in. */
export function selectHints(s: HintInputs): Hint[] {
  const out: Hint[] = [];

  if (s.error) {
    const e = errorHint(s.error);
    if (e) out.push(e);
  }

  return out.slice(0, 1);
}
