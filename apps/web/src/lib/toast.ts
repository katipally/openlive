"use client";

import { create } from "zustand";

// Minimal toast store for user-actionable failures (delete failed, download
// failed, device lost…). Callable from anywhere — components, hooks, or plain
// modules (zustand works outside React). Rendered by components/Toasts.tsx.
//
// A toast can carry an undo: its `commit` runs when it leaves any way but Undo
// (timeout, close, swipe, pushed out by a newer toast), so the undoable work
// happens exactly once or not at all.
export interface Toast { id: number; text: string; kind: "error" | "info"; undoable?: boolean }
export interface Undo { undo: () => void; commit: () => void }

let nextId = 1;
const undos = new Map<number, Undo>();
export const UNDO_MS = 5000;

interface ToastState {
  toasts: Toast[];
  push: (text: string, kind?: Toast["kind"], undo?: Undo) => number;
  dismiss: (id: number) => void;
  undo: (id: number) => void;
}

export const useToasts = create<ToastState>((set, get) => {
  const drop = (id: number, run: "commit" | "undo") => {
    const u = undos.get(id);
    undos.delete(id);
    u?.[run]();
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  };
  return {
    toasts: [],
    push: (text, kind = "error", undo) => {
      const id = nextId++;
      if (undo) undos.set(id, undo);
      const kept = [...get().toasts.filter((t) => t.text !== text), { id, text, kind, undoable: !!undo }].slice(-3);
      for (const t of get().toasts) if (!kept.includes(t)) drop(t.id, "commit");
      set({ toasts: kept });
      // Errors stay long enough to read twice; an alert that vanishes mid-read is lost.
      setTimeout(() => drop(id, "commit"), undo ? UNDO_MS : kind === "error" ? 8000 : 6000);
      return id;
    },
    dismiss: (id) => drop(id, "commit"),
    undo: (id) => drop(id, "undo"),
  };
});

/** Imperative helper for non-React callers. */
export const toast = (text: string, kind: Toast["kind"] = "error", undo?: Undo) => useToasts.getState().push(text, kind, undo);

// A window that closes mid-toast still does what the person left it to do.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { for (const id of [...undos.keys()]) useToasts.getState().dismiss(id); });
}
