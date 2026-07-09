"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

// BYOK settings, persisted to localStorage. There is no server key store — the
// key is sent per-request to our own /api/turn and /api/models routes (which call
// the provider server-side, so every provider works). The key never goes to any
// third party except the provider you chose.
interface SettingsState {
  keys: Record<string, string>;      // providerId -> API key
  liveProviderId: string;
  liveModel: string;
  liveEffort: string;                // "auto" | "low" | "medium" | ...
  setKey: (providerId: string, key: string) => void;
  removeKey: (providerId: string) => void;
  setProvider: (providerId: string) => void;
  setModel: (model: string) => void;
  setEffort: (effort: string) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      keys: {},
      liveProviderId: "anthropic",
      liveModel: "",
      liveEffort: "auto",
      setKey: (providerId, key) => set((s) => ({ keys: { ...s.keys, [providerId]: key.trim() } })),
      removeKey: (providerId) => set((s) => { const k = { ...s.keys }; delete k[providerId]; return { keys: k }; }),
      // Switching provider clears the model (it belonged to the old provider).
      setProvider: (providerId) => set({ liveProviderId: providerId, liveModel: "" }),
      setModel: (model) => set({ liveModel: model }),
      setEffort: (effort) => set({ liveEffort: effort }),
    }),
    { name: "openlive-settings" },
  ),
);

/** The current provider/model/key/effort for a turn (read outside React). */
export function currentTurnConfig() {
  const s = useSettings.getState();
  return {
    providerId: s.liveProviderId,
    model: s.liveModel,
    apiKey: s.keys[s.liveProviderId] ?? "",
    effort: s.liveEffort,
  };
}
