import { create } from "zustand";
import { useLiveStore } from "@/lib/live/liveStore";

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `chat-${Date.now()}`);

// App-wide UI state: the settings modal, whether the live UI is open, the active
// conversation id (so the top bar can start a new one / resume a past one without
// prop-drilling), and which half of the app the window shows.
interface UiState {
  settingsOpen: boolean;
  settingsTab: string | null;             // deep-link a tab when opening (consumed by the modal)
  settingsOrigin: string;                 // where Settings was opened from, for its "Back to …"
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
  /** Which half of the app the window is showing. Flow's hotkey is armed in both. */
  mode: AppMode;
  setMode: (m: AppMode) => void;
  /** The ⌘K command palette and the "?" shortcuts sheet. Opening one closes the other. */
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
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

/** What Settings goes back to, named as the person sees it: the call, the
 *  pre-call lobby, or the mode the window is in (ModeSwitch's labels). Read at
 *  open time so every entry point, native menu included, gets it right. */
function settingsOrigin(s: UiState): string {
  if (s.settingsOpen) return s.settingsOrigin;
  if (useLiveStore.getState().active) return "call";
  if (s.liveOpen) return "OpenLive";
  return s.mode === "flow" ? "Flow" : "Chat";
}

export const useUi = create<UiState>((set) => ({
  settingsOpen: false,
  settingsTab: null,
  settingsOrigin: "Chat",
  // A fresh open starts at General; opening again while open keeps the tab.
  openSettings: () => set((s) => ({ settingsOpen: true, settingsOrigin: settingsOrigin(s), ...(s.settingsOpen ? {} : { settingsTab: "general" }) })),
  openSettingsTab: (tab) => set((s) => ({ settingsOpen: true, settingsOrigin: settingsOrigin(s), settingsTab: tab })),
  closeSettings: () => set({ settingsOpen: false }),
  liveOpen: false,
  setLiveOpen: (v) => set({ liveOpen: v }),
  historyOpen: false,
  toggleHistory: () => set((s) => ({ historyOpen: !s.historyOpen })),
  setHistoryOpen: (v) => set({ historyOpen: v }),
  activeChatId: newId(),
  resumeChat: (id) => set({ activeChatId: id }),
  newConversation: () => set({ activeChatId: newId() }),
  mode: "chat",
  setMode: (mode) => {
    set({ mode });
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode */ }
  },
  paletteOpen: false,
  setPaletteOpen: (v) => set(v ? { paletteOpen: true, shortcutsOpen: false } : { paletteOpen: false }),
  shortcutsOpen: false,
  setShortcutsOpen: (v) => set(v ? { shortcutsOpen: true, paletteOpen: false } : { shortcutsOpen: false }),
}));
