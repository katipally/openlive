import { create } from "zustand";

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `chat-${Date.now()}`);

// App-wide UI state: the settings modal, whether the live UI is open, the active
// conversation id (so the top bar can start a new one / resume a past one without
// prop-drilling), and whether we're in minimized (overlay) mode.
interface UiState {
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  liveOpen: boolean;
  setLiveOpen: (v: boolean) => void;
  activeChatId: string;
  resumeChat: (id: string) => void;   // switch to a saved conversation
  newConversation: () => void;        // fresh id
  minimized: boolean;
  setMinimized: (v: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  liveOpen: false,
  setLiveOpen: (v) => set({ liveOpen: v }),
  activeChatId: newId(),
  resumeChat: (id) => set({ activeChatId: id }),
  newConversation: () => set({ activeChatId: newId() }),
  minimized: false,
  setMinimized: (v) => set({ minimized: v }),
}));
