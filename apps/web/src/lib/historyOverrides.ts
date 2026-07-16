"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

// A coding agent's OWN sessions get their titles from their file content, so we
// can't rewrite them. Renaming an external session stores an OpenLive-side title
// override instead — persisted so it survives restarts. (OpenLive's own chats are
// renamed for real in the DB.)
interface State {
  titles: Record<string, string>;                 // external sessionId → custom title
  setTitle: (id: string, title: string) => void;
}

export const useHistoryOverrides = create<State>()(
  persist(
    (set) => ({
      titles: {},
      setTitle: (id, title) => set((s) => ({ titles: { ...s.titles, [id]: title } })),
    }),
    { name: "openlive:history-overrides" },
  ),
);
