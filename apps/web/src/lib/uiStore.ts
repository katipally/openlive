import { useLiveStore } from "@/lib/live/liveStore";
import { featureUsed } from "@/lib/featureUse";
import { persisted, savedGroup, type Fields } from "@/lib/persist";
import { capabilityTab, resolveSettingsTab, type CapabilityTab } from "@/lib/settingsSearch";

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `chat-${Date.now()}`);

// App-wide UI state: the settings modal, whether the live UI is open, the active
// conversation id (so the top bar can start a new one / resume a past one without
// prop-drilling), and which half of the app the window shows. What the main
// window shows is remembered in ui.json (lib/persist.ts) and comes back on the
// next launch: the mode, the open chat, the open Settings tab.
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
  /** The Settings tab on screen, kept by SettingsPage so a relaunch reopens it. */
  settingsShown: string | null;
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
  /** History's filter: every session, or only those started in OpenLive. */
  sessionsFilter: "all" | "openlive";
  /** The call's transcript panel, open or not, and its width in px. */
  transcriptOpen: boolean;
  transcriptWidth: number;
}

export type AppMode = "chat" | "flow" | "dictate";
export const APP_MODES: readonly AppMode[] = ["chat", "flow", "dictate"];
export const MODE_LABEL: Record<AppMode, string> = { chat: "Chat", flow: "Flow", dictate: "Dictate" };
export interface SettingsJump { anchor: string; reveal?: string }

export const TRANSCRIPT_WIDTH = { min: 280, max: 640, initial: 360 } as const;

// Only the main window says what is on screen: Flow's hidden windows hold this
// store too, and saving their idle copy would close the chat the person left open.
const mainWindow = () => typeof location !== "undefined" && location.pathname === "/";

/** Saved fields into state. The layout has already dropped a chat that is gone. */
function restore(f: Fields): Partial<UiState> {
  const out: Partial<UiState> = {};
  const mode = APP_MODES.find((m) => m === f.mode);
  if (mode) out.mode = mode;
  const sub = capabilityTab(typeof f.capabilitiesTab === "string" ? f.capabilitiesTab : null);
  if (sub) out.capabilitiesTab = sub;
  if (typeof f.openChat === "string" && f.openChat && f.openChat.length <= 200) Object.assign(out, { activeChatId: f.openChat, liveOpen: true });
  const tab = resolveSettingsTab(typeof f.settings === "string" ? f.settings : null);
  if (tab) Object.assign(out, { settingsOpen: true, settingsTab: tab, settingsShown: tab, settingsOrigin: out.liveOpen ? "OpenLive" : MODE_LABEL[out.mode ?? "chat"] });
  if (f.sessionsFilter === "all" || f.sessionsFilter === "openlive") out.sessionsFilter = f.sessionsFilter;
  if (typeof f.transcriptOpen === "boolean") out.transcriptOpen = f.transcriptOpen;
  const w = f.transcriptWidth;
  if (typeof w === "number" && w >= TRANSCRIPT_WIDTH.min && w <= TRANSCRIPT_WIDTH.max) out.transcriptWidth = w;
  return out;
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

export const useUi = persisted<UiState>("ui", (set, get) => ({
  settingsOpen: false,
  settingsShown: null,
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
  setCapabilitiesTab: (t) => set({ capabilitiesTab: t }),
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
  setMode: (mode) => set({ mode }),
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
  sessionsFilter: "all",
  transcriptOpen: true,
  transcriptWidth: TRANSCRIPT_WIDTH.initial,
}), {
  partialize: (s) => (mainWindow() ? {
    mode: s.mode,
    capabilitiesTab: s.capabilitiesTab,
    openChat: s.liveOpen ? s.activeChatId : null,
    settings: s.settingsOpen ? s.settingsShown : null,
    sessionsFilter: s.sessionsFilter,
    transcriptOpen: s.transcriptOpen,
    transcriptWidth: s.transcriptWidth,
  } : savedGroup("ui")),
  clean: restore,
  live: false,
});
