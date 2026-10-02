"use client";

import { persisted } from "./persist";

// Remembers which collapsible sections (native <details>) the user has opened,
// app-wide, across restarts: one flat map of key to open, ui.json's disclosure
// group, one field per section so two windows' folds never undo each other.

interface DiscState {
  open: Record<string, boolean>;
  set: (key: string, v: boolean) => void;
}
const useStore = persisted<DiscState>("disclosure", (set) => ({
  open: {},
  set: (key, v) => set((s) => ({ open: { ...s.open, [key]: v } })),
}), {
  partialize: (s) => s.open,
  // The sessions drawer's removed folder tree left one "hist:ws:<cwd>" per folder; they go here.
  clean: (f) => ({ open: Object.fromEntries(Object.entries(f).filter(([k, v]) => typeof v === "boolean" && !k.startsWith("hist:ws:"))) as Record<string, boolean> }),
});

/** Persisted open/closed state for a <details>: `open={open} onToggle={e => setOpen(e.currentTarget.open)}`. */
export function usePersistedOpen(key: string, dflt = false): readonly [boolean, (v: boolean) => void] {
  const open = useStore((s) => s.open[key]);
  const set = useStore((s) => s.set);
  return [open ?? dflt, (v: boolean) => set(key, v)] as const;
}
