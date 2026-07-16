"use client";

import { useEffect } from "react";
import { Settings2, MessageSquare, Plus } from "lucide-react";
import { useUi } from "@/lib/uiStore";
import { LiveDock } from "@/components/live/LiveDock";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { HistorySidebar } from "@/components/HistorySidebar";
import { Onboarding } from "@/components/Onboarding";
import { AgentSelect } from "@/components/live/AgentControls";
import { OpenLiveMark } from "@/components/OpenLiveMark";
import { useAppVersion } from "@/lib/useAppVersion";
import { setConversationBind } from "@/lib/live/useLiveSession";
import { useLiveStore } from "@/lib/live/liveStore";
import { loadModels, modelsCached, modelsReady } from "@/lib/live/models";

export default function Home() {
  const appVersion = useAppVersion();
  const liveOpen = useUi((s) => s.liveOpen);
  const setLiveOpen = useUi((s) => s.setLiveOpen);
  const openSettings = useUi((s) => s.openSettings);
  const setHistoryOpen = useUi((s) => s.setHistoryOpen);
  const activeChatId = useUi((s) => s.activeChatId);
  const newConversation = useUi((s) => s.newConversation);
  const minimized = useUi((s) => s.minimized);

  // Warm the on-device voice models in the background as soon as the app loads, so
  // opening Live doesn't stall on "Preparing…". Only when the weights are already
  // cached — a fresh install still downloads via the explicit pre-call button (we
  // don't silently pull hundreds of MB on first launch).
  useEffect(() => {
    if (modelsCached() && !modelsReady()) void loadModels(() => {}).catch(() => {});
  }, []);

  const startNew = () => {
    newConversation();
    // Carry the hero's "Talk to" pick onto the freshly created conversation.
    const pick = useLiveStore.getState().boundAgent;
    if (pick) setConversationBind(useUi.getState().activeChatId, pick);
    setLiveOpen(true);
  };

  return (
    <main className="relative z-10 flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      {!minimized && (
        <>
          {/* Frameless-window drag handle: a top strip clear of the window controls
              (top-left) and the settings button (top-right). Desktop only (.desktop). */}
          <div className="app-drag fixed left-[90px] right-16 top-0 z-0 h-10" />
          <button onClick={openSettings} aria-label="Settings"
            className="absolute right-4 top-4 grid size-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
            <Settings2 className="size-5" />
          </button>

          <div className="flex flex-col items-center gap-6">
            <OpenLiveMark />
            <div className="space-y-2">
              <h1 className="text-[32px] font-semibold tracking-tight">OpenLive</h1>
              <p className="max-w-sm text-[14px] leading-relaxed text-muted-foreground">
                Ears, eyes, and a voice for your AI.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={startNew} data-tour="new"
                className="flex items-center gap-2 rounded-full bg-accent px-7 py-3 text-[15px] font-medium text-accent-foreground shadow-lg transition duration-150 hover:scale-[1.03] hover:opacity-90 active:scale-95">
                <Plus className="size-5" /> New
              </button>
              <button onClick={() => setHistoryOpen(true)} title="Browse & resume past conversations" data-tour="resume"
                className="flex items-center gap-2 rounded-full border border-border px-5 py-3 text-[14px] text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
                <MessageSquare className="size-4" /> Resume
              </button>
              <button onClick={openSettings} title="Settings" aria-label="Settings" data-tour="settings"
                className="grid size-[46px] place-items-center rounded-full border border-border text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
                <Settings2 className="size-[18px]" />
              </button>
            </div>
            {/* Choose what a new conversation talks to — the built-in assistant or a
                coding agent (Claude Code / Codex / Cursor). Carried into "New". */}
            <div className="flex items-center gap-1.5 text-[12.5px] text-faint" data-tour="talk-to">
              Talk to <AgentSelect />
            </div>
          </div>

          <footer className="absolute inset-x-0 bottom-4 flex items-center justify-center text-[11px] text-faint">
            <a href="https://github.com/katipally/openlive/releases" target="_blank" rel="noreferrer" className="transition hover:text-muted-foreground">
              {appVersion ? `v${appVersion}` : "dev"}
            </a>
          </footer>
        </>
      )}

      {liveOpen && <LiveDock key={activeChatId} chatId={activeChatId} onExit={() => setLiveOpen(false)} />}
      {!minimized && <SettingsPage />}
      {!minimized && <HistorySidebar />}
      {!minimized && <Onboarding />}
    </main>
  );
}
