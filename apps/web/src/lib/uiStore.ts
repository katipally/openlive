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
}));
