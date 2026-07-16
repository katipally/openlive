"use client";

import type { AgentMetaWire } from "@openlive/shared";
import { useUi } from "@/lib/uiStore";

// One small hints engine: a PURE ranked selector from live-session state to at
// most two contextual chips. Sources: the agent's own slash commands (ACP
// available_commands_update) and error recovery with a one-tap fix. Permission
// asks and mid-thought holds have dedicated surfaces (PermissionPrompt,
// HoldPill) — no duplicate chips here, and no keyboard coaching (push-to-talk
// is an explicit opt-in toggle now, not something to teach in passing).
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

  // The agent's own slash commands, while it's idle enough to read them.
  const cmds = s.agentMeta?.commands ?? [];
  if (s.active && s.boundAgent && cmds.length > 0 && (s.phase === "idle" || s.phase === "listening")) {
    const top = cmds.slice(0, 3).map((c) => `/${c.name.replace(/^\//, "")}`).join("  ");
    out.push({ id: "cmds", text: `Try saying: ${top}`, dismissable: true });
  }

  return out.slice(0, 2);
}
