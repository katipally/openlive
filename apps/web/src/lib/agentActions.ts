"use client";

import { create } from "zustand";
import { isAgentId, telemetrySchema, type TelemetryEventProps } from "@openlive/shared";
import { telemetry } from "./telemetry";

// Install / uninstall / login run as a BACKGROUND process tracked here, not in a
// component: the streamed output keeps accumulating even if you close the Settings
// panel, and any open AgentRow re-subscribes to the live log. One run per agent.
export type ActionKind = "install" | "uninstall" | "login" | "logout" | "update";
export type ActionResult = TelemetryEventProps<"agent_action_result">["result"];
/** `result` is what the run streamed back; the panel and the report use it, never the log's prose. */
interface Run { action: ActionKind; log: string; running: boolean; startedAt: number; result?: ActionResult }

// What the server can know. The rest (`signed_in`, `wait_timeout`) is seen only by a row that watches the sign-in.
const STREAMED = new Set<string>(telemetrySchema.events.agent_action_result.props.result.values.filter((r) => r !== "signed_in" && r !== "wait_timeout"));
const MARKER = /\n?\[result ([a-z_]+)\]\n?$/;

/** Splits the stream's closing `[result <code>]` line off the log the panel shows. Unknown codes stay in the log. */
export function splitResult(log: string): { log: string; result?: ActionResult } {
  const m = MARKER.exec(log);
  return m && STREAMED.has(m[1]!) ? { log: log.slice(0, m.index), result: m[1] as ActionResult } : { log };
}

/** One agent action's outcome, as closed codes and a duration. Never the log, the command or a path. */
export function trackAgentAction(id: string, action: ActionKind, result: ActionResult, startedAt: number): void {
  if (isAgentId(id)) telemetry.track("agent_action_result", { agent_id: id, action, result, duration_s: Math.round((Date.now() - startedAt) / 1000) });
}

interface State {
  runs: Record<string, Run>;                          // by agent id
  run: (id: string, action: ActionKind) => Promise<void>;
  clear: (id: string) => void;
}

export const useAgentActions = create<State>((set, get) => ({
  runs: {},
  clear: (id) => set((s) => { const runs = { ...s.runs }; delete runs[id]; return { runs }; }),
  run: async (id, action) => {
    if (get().runs[id]?.running) return; // already running for this agent
    const startedAt = Date.now();
    set((s) => ({ runs: { ...s.runs, [id]: { action, log: "", running: true, startedAt } } }));
    let streamed = "";
    const append = (chunk: string) => {
      streamed += chunk;
      set((s) => {
        const cur = s.runs[id];
        return cur ? { runs: { ...s.runs, [id]: { ...cur, log: cur.log + chunk } } } : {};
      });
    };
    try {
      const res = await fetch("/api/agents/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, action }) });
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break; append(dec.decode(value, { stream: true })); }
    } catch (e) {
      append(`\n[error] ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      const done = splitResult(streamed);
      const result = done.result ?? "error"; // no marker: the request never got an answer
      set((s) => { const cur = s.runs[id]; return cur ? { runs: { ...s.runs, [id]: { ...cur, log: done.log, result, running: false } } } : {}; });
      trackAgentAction(id, action, result, startedAt);
      if (action === "install" && result === "ok") telemetry.track("onboarding_step", { step: "first_agent_install_ok" });
    }
  },
}));
