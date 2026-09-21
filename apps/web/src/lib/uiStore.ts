import { create } from "zustand";

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `chat-${Date.now()}`);

// App-wide UI state: the settings modal, whether the live UI is open, the active
// conversation id (so the top bar can start a new one / resume a past one without
// prop-drilling), and whether we're in minimized (overlay) mode.
interface UiState {
  settingsOpen: boolean;
  settingsTab: string | null;             // deep-link a tab when opening (consumed by the modal)
  openSettings: () => void;
  openSettingsTab: (tab: string) => void; // open Settings straight to a tab
  closeSettings: () => void;
  liveOpen: boolean;
  setLiveOpen: (v: boolean) => void;
  historyOpen: boolean;               // the left History sidebar (agent → workspace → session)
  toggleHistory: () => void;
  setHistoryOpen: (v: boolean) => void;
  activeChatId: string;
  resumeChat: (id: string) => void;   // switch to a saved conversation
  newConversation: () => void;        // fresh id
  minimized: boolean;
  setMinimized: (v: boolean) => void;
  /** Which half of the app the window is showing. Flow's hotkey is armed in both. */
  mode: AppMode;
  setMode: (m: AppMode) => void;
}

export type AppMode = "chat" | "flow";

const MODE_KEY = "openlive-mode";

/** The saved mode, or "chat". Read on mount rather than at module load: this
 *  store is evaluated during SSR too, and seeding it from localStorage there is
 *  a hydration mismatch waiting to happen. */
export function restoreMode(): void {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "flow" || saved === "chat") useUi.setState({ mode: saved });
  } catch { /* private mode */ }
}

export const useUi = create<UiState>((set) => ({
  settingsOpen: false,
  settingsTab: null,
  openSettings: () => set({ settingsOpen: true }),
  openSettingsTab: (tab) => set({ settingsOpen: true, settingsTab: tab }),
  closeSettings: () => set({ settingsOpen: false }),
  liveOpen: false,
  setLiveOpen: (v) => set({ liveOpen: v }),
  historyOpen: false,
  toggleHistory: () => set((s) => ({ historyOpen: !s.historyOpen })),
  setHistoryOpen: (v) => set({ historyOpen: v }),
  activeChatId: newId(),
  resumeChat: (id) => set({ activeChatId: id }),
  newConversation: () => set({ activeChatId: newId() }),
  minimized: false,
  setMinimized: (v) => set({ minimized: v }),
  mode: "chat",
  setMode: (mode) => {
    set({ mode });
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode */ }
  },
}));
