"use client";

import { create } from "zustand";

// Install / uninstall / login run as a BACKGROUND process tracked here, not in a
// component: the streamed output keeps accumulating even if you close the Settings
// panel, and any open AgentRow re-subscribes to the live log. One run per agent.
export type ActionKind = "install" | "uninstall" | "login" | "logout";
interface Run { action: ActionKind; log: string; running: boolean }

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
    set((s) => ({ runs: { ...s.runs, [id]: { action, log: "", running: true } } }));
    const append = (chunk: string) => set((s) => {
      const cur = s.runs[id];
      return cur ? { runs: { ...s.runs, [id]: { ...cur, log: cur.log + chunk } } } : {};
    });
    try {
      const res = await fetch("/api/agents/action", { method: "POST", body: JSON.stringify({ id, action }) });
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break; append(dec.decode(value, { stream: true })); }
    } catch (e) {
      append(`\n[error] ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      set((s) => { const cur = s.runs[id]; return cur ? { runs: { ...s.runs, [id]: { ...cur, running: false } } } : {}; });
    }
  },
}));
