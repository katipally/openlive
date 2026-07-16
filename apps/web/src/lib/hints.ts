"use client";

import type { AgentMetaWire } from "@openlive/shared";
import { useUi } from "@/lib/uiStore";

// One small hints engine: a PURE ranked selector from live-session state to at
// most two contextual chips (what you can say/do right now). Rendered by
// components/live/HintChips.tsx. Sources: first-calls PTT coaching, the agent's
// own slash commands (ACP available_commands_update), and error recovery with a
// one-tap fix. Permission asks and mid-thought holds have dedicated surfaces
// (PermissionPrompt, HoldPill) — no duplicate chips here.
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

// PTT coaching shows on the first few calls only, or until dismissed.
const COACH_KEY = "openlive-hint-ptt";
const coachCount = (): number => { try { return Number(localStorage.getItem(COACH_KEY) ?? 0); } catch { return 99; } };
export const bumpCoach = (): void => { try { localStorage.setItem(COACH_KEY, String(coachCount() + 1)); } catch { /* */ } };
export const dismissCoach = (): void => { try { localStorage.setItem(COACH_KEY, "99"); } catch { /* */ } };

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

  // First-calls coaching: how to drive the call by keyboard.
  if (s.active && coachCount() < 3 && (s.phase === "idle" || s.phase === "listening")) {
    out.push({ id: "coach-ptt", text: "Hold Space to talk · Enter sends a held thought now", dismissable: true });
  }

  // The agent's own slash commands, while it's idle enough to read them.
  const cmds = s.agentMeta?.commands ?? [];
  if (s.active && s.boundAgent && cmds.length > 0 && (s.phase === "idle" || s.phase === "listening")) {
    const top = cmds.slice(0, 3).map((c) => `/${c.name.replace(/^\//, "")}`).join("  ");
    out.push({ id: "cmds", text: `Try saying: ${top}`, dismissable: true });
  }

  return out.slice(0, 2);
}
