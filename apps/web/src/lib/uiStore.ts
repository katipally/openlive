import { create } from "zustand";
import { useLiveStore } from "@/lib/live/liveStore";
import { featureUsed } from "@/lib/featureUse";
import { capabilityTab, type CapabilityTab } from "@/lib/settingsSearch";

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `chat-${Date.now()}`);

// App-wide UI state: the settings modal, whether the live UI is open, the active
// conversation id (so the top bar can start a new one / resume a past one without
// prop-drilling), and which half of the app the window shows.
interface UiState {
  settingsOpen: boolean;
  settingsTab: string | null;             // deep-link a tab when opening (consumed by the modal)
  settingsOrigin: string;                 // where Settings was opened from, for its "Back to …"
  openSettings: () => void;
  /** Open Settings straight to a tab, and optionally to one row on it (a search result's anchor and reveal). */
  openSettingsTab: (tab: string, at?: SettingsJump) => void;
  /** The row a deep link asked for, consumed with `settingsTab`. */
  settingsJump: SettingsJump | null;
  closeSettings: () => void;
  /** The Capabilities subtab: the one a deep link or this viewer last chose. */
  capabilitiesTab: CapabilityTab;
  setCapabilitiesTab: (t: CapabilityTab) => void;
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

export type AppMode = "chat" | "flow" | "dictate";
export const APP_MODES: readonly AppMode[] = ["chat", "flow", "dictate"];
export const MODE_LABEL: Record<AppMode, string> = { chat: "Chat", flow: "Flow", dictate: "Dictate" };
export interface SettingsJump { anchor: string; reveal?: string }

const MODE_KEY = "openlive-mode";
const CAPABILITIES_KEY = "openlive-capabilities-tab";

/** The saved mode, or "chat", and the last Capabilities subtab. Read on mount rather than at module load: this
 *  store is evaluated during SSR too, and seeding it from localStorage there is
 *  a hydration mismatch waiting to happen. */
export function restoreMode(): void {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    const mode = APP_MODES.find((m) => m === saved);
    if (mode) useUi.setState({ mode });
    const tab = capabilityTab(localStorage.getItem(CAPABILITIES_KEY));
    if (tab) useUi.setState({ capabilitiesTab: tab });
  } catch { /* private mode */ }
}

/** What Settings goes back to, named as the person sees it: the call, the
 *  pre-call lobby, or the mode the window is in (ModeSwitch's labels). Read at
 *  open time so every entry point, native menu included, gets it right. */
function settingsOrigin(s: UiState): string {
  if (s.settingsOpen) return s.settingsOrigin;
  if (useLiveStore.getState().active) return "call";
  if (s.liveOpen) return "OpenLive";
  return MODE_LABEL[s.mode];
}

export const useUi = create<UiState>((set, get) => ({
  settingsOpen: false,
  settingsTab: null,
  settingsJump: null,
  settingsOrigin: "Chat",
  // A fresh open starts at General; opening again while open keeps the tab.
  openSettings: () => {
    if (!get().settingsOpen) featureUsed("n_settings_open");
    set((s) => ({ settingsOpen: true, settingsOrigin: settingsOrigin(s), ...(s.settingsOpen ? {} : { settingsTab: "general" }) }));
  },
  openSettingsTab: (tab, at) => {
    if (!get().settingsOpen) featureUsed("n_settings_open");
    set((s) => ({ settingsOpen: true, settingsOrigin: settingsOrigin(s), settingsTab: tab, settingsJump: at ?? null }));
  },
  closeSettings: () => set({ settingsOpen: false }),
  capabilitiesTab: "tools",
  setCapabilitiesTab: (t) => {
    try { localStorage.setItem(CAPABILITIES_KEY, t); } catch { /* private mode: kept for this run only */ }
    set({ capabilitiesTab: t });
  },
  liveOpen: false,
  setLiveOpen: (v) => {
    if (v && !get().liveOpen) featureUsed("n_lobby_open");
    set({ liveOpen: v });
  },
  historyOpen: false,
  toggleHistory: () => {
    if (!get().historyOpen) featureUsed("n_history_open");
    set((s) => ({ historyOpen: !s.historyOpen }));
  },
  setHistoryOpen: (v) => {
    if (v && !get().historyOpen) featureUsed("n_history_open");
    set({ historyOpen: v });
  },
  activeChatId: newId(),
  resumeChat: (id) => set({ activeChatId: id }),
  newConversation: () => set({ activeChatId: newId() }),
  mode: "chat",
  setMode: (mode) => {
    set({ mode });
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode */ }
  },
  paletteOpen: false,
  setPaletteOpen: (v) => {
    if (v && !get().paletteOpen) featureUsed("n_palette_open");
    set(v ? { paletteOpen: true, shortcutsOpen: false } : { paletteOpen: false });
  },
  shortcutsOpen: false,
  setShortcutsOpen: (v) => {
    if (v && !get().shortcutsOpen) featureUsed("n_shortcuts_sheet");
    set(v ? { shortcutsOpen: true, paletteOpen: false } : { shortcutsOpen: false });
  },
}));
