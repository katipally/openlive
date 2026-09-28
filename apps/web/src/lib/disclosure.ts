"use client";

import { create } from "zustand";

// Remembers which collapsible sections (native <details>) the user has opened,
// app-wide, across restarts. One flat map of key→open, persisted to localStorage.
// Match the codebase's manual-localStorage idiom (see pipelineConfig) rather than
// persist middleware — these only render client-side, so no SSR hydration risk.
const KEY = "openlive:disclosure";
const load = (): Record<string, boolean> => {
  if (typeof window === "undefined") return {};
  try {
    const open: Record<string, boolean> = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    // The sessions drawer's removed folder tree left one "hist:ws:<cwd>" per folder.
    // Dropped here, where the map is read, so the store never writes them back.
    const stale = Object.keys(open).filter((k) => k.startsWith("hist:ws:"));
    if (stale.length) {
      for (const k of stale) delete open[k];
      localStorage.setItem(KEY, JSON.stringify(open));
    }
    return open;
  } catch { return {}; }
};

interface DiscState {
  open: Record<string, boolean>;
  set: (key: string, v: boolean) => void;
}
const useStore = create<DiscState>((set) => ({
  open: load(),
  set: (key, v) => set((s) => {
    const open = { ...s.open, [key]: v };
    if (typeof window !== "undefined") localStorage.setItem(KEY, JSON.stringify(open));
    return { open };
  }),
}));

/** Persisted open/closed state for a <details>: `open={open} onToggle={e => setOpen(e.currentTarget.open)}`. */
export function usePersistedOpen(key: string, dflt = false): readonly [boolean, (v: boolean) => void] {
  const open = useStore((s) => s.open[key]);
  const set = useStore((s) => s.set);
  return [open ?? dflt, (v: boolean) => set(key, v)] as const;
}
