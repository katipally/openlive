"use client";

import { create } from "zustand";

// Minimal toast store for user-actionable failures (delete failed, download
// failed, device lost…). Callable from anywhere — components, hooks, or plain
// modules (zustand works outside React). Rendered by components/Toasts.tsx.
export interface Toast { id: number; text: string; kind: "error" | "info" }

let nextId = 1;
interface ToastState {
  toasts: Toast[];
  push: (text: string, kind?: Toast["kind"]) => void;
  dismiss: (id: number) => void;
}

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (text, kind = "error") => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text), { id, text, kind }].slice(-3) }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 6000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative helper for non-React callers. */
export const toast = (text: string, kind: Toast["kind"] = "error") => useToasts.getState().push(text, kind);
