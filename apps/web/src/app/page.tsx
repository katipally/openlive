"use client";

import { useEffect, useRef } from "react";
import { Settings2, MessageSquare, Plus } from "lucide-react";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { useUi } from "@/lib/uiStore";
import { LiveDock } from "@/components/live/LiveDock";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { HistorySidebar } from "@/components/HistorySidebar";
import { SpotlightTour } from "@/components/SpotlightTour";
import { AgentSelect } from "@/components/live/AgentControls";
import { OpenLiveMark } from "@/components/OpenLiveMark";
import { useAppVersion } from "@/lib/useAppVersion";
import { setConversationBind } from "@/lib/live/useLiveSession";
import { useLiveStore } from "@/lib/live/liveStore";
import { loadModels, modelsCached, modelsReady } from "@/lib/live/models";
import { wirePanelCmdRouter } from "@/lib/live/panelBridge";

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

  // Desktop: follow mini-mode changes made from OUTSIDE the renderer (tray menu).
  // Without this the tray's "Mini mode" hid the window while the renderer still
  // thought it was expanded — the pill's bridge never mounted and every button
  // (end, expand, camera, screen) was dead. Also arm the panel-cmd fallback so
  // expand/end restore the window even when no call is running.
  useEffect(() => {
    const api = (window as unknown as { openlive?: { onMinimized?: (cb: (v: boolean) => void) => void } }).openlive;
    api?.onMinimized?.((v) => useUi.getState().setMinimized(v));
    wirePanelCmdRouter(() => useUi.getState().setMinimized(false));
  }, []);

  const heroRef = useRef<HTMLDivElement>(null);

  // Launch reveal — the one orchestrated hero moment: mark settles in, headline
  // and tagline rise, CTAs stagger up, the talk-to line and footer fade last.
  // Runs once per mount of the hero (not during calls; LiveDock covers it).
  useGSAP(() => {
    if (!heroRef.current || prefersReduced()) return;
    gsap.timeline()
      .fromTo(".ol-hero-mark", { autoAlpha: 0, scale: 0.86, y: 6 }, { autoAlpha: 1, scale: 1, y: 0, duration: DUR.enter, ease: EASE.emphasized })
      .fromTo(".ol-hero-title", { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: DUR.slow, ease: EASE.emphasized }, "-=0.28")
      .fromTo(".ol-hero-tag", { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: DUR.slow, ease: EASE.out }, "-=0.24")
      .fromTo(".ol-hero-cta > *", { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: DUR.base, ease: EASE.out, stagger: 0.06 }, "-=0.2")
      .fromTo(".ol-hero-sub", { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.base, ease: EASE.soft }, "-=0.1");
  }, { scope: heroRef });

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

          <div ref={heroRef} className="flex flex-col items-center gap-6">
            <div className="ol-hero-mark"><OpenLiveMark /></div>
            <div className="space-y-2">
              <h1 className="ol-hero-title text-display font-semibold tracking-tight">OpenLive</h1>
              <p className="ol-hero-tag max-w-sm text-callout leading-relaxed text-muted-foreground">
                Ears, eyes, and a voice for your AI.
              </p>
            </div>
            <div className="ol-hero-cta flex items-center gap-3">
              <button onClick={startNew} data-tour="new"
                className="flex items-center gap-2 rounded-full bg-accent px-7 py-3 text-title-sm font-medium text-accent-foreground shadow-lg transition duration-150 hover:scale-[1.03] hover:opacity-90 active:scale-95">
                <Plus className="size-5" /> New
              </button>
              <button onClick={() => setHistoryOpen(true)} title="Browse & resume past conversations" data-tour="resume"
                className="flex items-center gap-2 rounded-full border border-border px-5 py-3 text-callout text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
                <MessageSquare className="size-4" /> Resume
              </button>
              <button onClick={openSettings} title="Settings" aria-label="Settings" data-tour="settings"
                className="grid size-[46px] place-items-center rounded-full border border-border text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
                <Settings2 className="size-[18px]" />
              </button>
            </div>
            {/* Choose what a new conversation talks to — the built-in assistant or a
                coding agent (Claude Code / Codex / Cursor). Carried into "New". */}
            <div className="ol-hero-sub flex items-center gap-1.5 text-label text-faint" data-tour="talk-to">
              Talk to <AgentSelect />
            </div>
          </div>

          <footer className="absolute inset-x-0 bottom-4 flex items-center justify-center text-caption text-faint">
            <a href="https://github.com/katipally/openlive/releases" target="_blank" rel="noreferrer" className="transition hover:text-muted-foreground">
              {appVersion ? `v${appVersion}` : "dev"}
            </a>
          </footer>
        </>
      )}

      {liveOpen && <LiveDock key={activeChatId} chatId={activeChatId} onExit={() => setLiveOpen(false)} />}
      {!minimized && <SettingsPage />}
      {!minimized && <HistorySidebar />}
      {!minimized && (
        <SpotlightTour id="home" active={!liveOpen} steps={[
          { target: "talk-to", title: "Pick who you talk to", body: "OpenLive voice-drives the coding agent you already use — locally, under your own login. Pick one here, or keep the built-in assistant." },
          { target: "new", title: "Start a conversation", body: "New opens the call setup — pick a project folder, check your mic, then just talk. Interrupt any time." },
          { target: "resume", title: "Everything is saved", body: "Resume lists every conversation by project folder — including sessions from the agent's own CLI." },
          { target: "settings", title: "Make it yours", body: "Voice pipeline, agent install & sign-in, appearance, and shortcuts all live in Settings." },
        ]} />
      )}
    </main>
  );
}
