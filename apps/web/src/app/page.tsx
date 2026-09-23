"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Settings2, MessageSquare, Plus } from "lucide-react";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { restoreMode, useUi } from "@/lib/uiStore";
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
import { ModeSwitch } from "@/components/flow/ModeSwitch";
import { flowBridge } from "@/lib/flow/bridge";
import { FlowShell, SwitchHole } from "@/components/flow/FlowShell";
import { CommandPalette } from "@/components/CommandPalette";
import { ShortcutsSheet } from "@/components/ShortcutsSheet";
import { ConnectionBanner } from "@/components/ConnectionBanner";

// One home for the mode switch: top centre of the window, clear of the traffic
// lights on the left and the window controls on the right, in every mode.
const MODE_SWITCH_AT = "fixed left-1/2 top-2 z-[var(--z-nav)] -translate-x-1/2";

// Views slide the way the switch reads: Flow sits right of Chat. `custom` is the
// direction (1 toward Flow, -1 toward Chat, 0 to only cross-fade).
type Bezier = [number, number, number, number];
const VIEW = {
  variants: {
    enter: (d: number) => ({ x: `${d * 6}%`, opacity: 0 }),
    // The leaving view clears out before the arriving one is half in: at equal
    // speeds both heroes sat on screen at half strength, a double-exposed orb.
    shown: { x: "0%", opacity: 1, transition: { duration: DUR.base, delay: 0.08, ease: [0.23, 1, 0.32, 1] as Bezier } },
    exit: (d: number) => ({ x: `${d * -6}%`, opacity: 0, transition: { duration: 0.12, ease: [0, 0, 0.2, 1] as Bezier } }),
  },
  initial: "enter", animate: "shown", exit: "exit",
  transition: { duration: DUR.base, ease: [0.23, 1, 0.32, 1] },
} as const;

export default function Home() {
  const appVersion = useAppVersion();
  const liveOpen = useUi((s) => s.liveOpen);
  const setLiveOpen = useUi((s) => s.setLiveOpen);
  const openSettings = useUi((s) => s.openSettings);
  const setHistoryOpen = useUi((s) => s.setHistoryOpen);
  const activeChatId = useUi((s) => s.activeChatId);
  const newConversation = useUi((s) => s.newConversation);
  const mode = useUi((s) => s.mode);
  const reduce = useReducedMotion();

  // The saved mode, applied after mount: this store is evaluated during SSR too,
  // so seeding it from localStorage there would be a hydration mismatch.
  useEffect(restoreMode, []);

  // Warm the on-device voice models in the background as soon as the app loads, so
  // opening Live doesn't stall on "Preparing…". Only when the weights are already
  // cached — a fresh install still downloads via the explicit pre-call button (we
  // don't silently pull hundreds of MB on first launch).
  useEffect(() => {
    if (modelsCached() && !modelsReady()) void loadModels(() => {}).catch(() => {});
  }, []);

  // Desktop: route the orb's call controls (mute / end) to the live call.
  useEffect(() => {
    wirePanelCmdRouter();
    // Flow's orb asked for the whole window. It opens on Flow, because that is
    // what the person was already in, and on its settings when the fix is there.
    flowBridge()?.onShow?.((to) => {
      useUi.getState().setMode("flow");
      if (to === "flow-settings") useUi.getState().openSettingsTab("flow");
    });
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

  // Flow swaps the whole window rather than sharing the lobby's centred layout.
  // Its gesture is armed by the owner renderer either way, so this only changes
  // what is on screen. A call in progress keeps Chat up: you cannot switch
  // mid-call. The switch and Settings sit outside the sliding views, so changing
  // mode never moves or remounts them.
  const flow = mode === "flow" && !liveOpen;
  const dir = reduce ? 0 : flow ? 1 : -1;

  return (
    // The one stacking context the views used to own: at rest the views add none,
    // so Settings, tours and the switch layer exactly as before. x-clip stops the
    // slide from flashing a horizontal scrollbar.
    <div className="relative z-10 overflow-x-clip">
      {!liveOpen && <ModeSwitch className={MODE_SWITCH_AT} />}
      <AnimatePresence initial={false} mode="popLayout" custom={dir}>
        {flow ? (
          <motion.main key="flow" custom={dir} {...VIEW} className="relative flex min-h-dvh flex-col text-left">
            <FlowShell />
          </motion.main>
        ) : (
          <motion.main key="chat" custom={dir} {...VIEW} className="relative flex min-h-dvh flex-col items-center justify-center px-6 text-center">
            {/* Frameless-window drag handle: a top strip clear of the window controls
                (top-left). Desktop only (.desktop). Settings lives in the hero CTA row
                below — no duplicate corner gear. The hole is the mode switch's; see
                SwitchHole for why the strip has to cut it rather than the switch. */}
            <div className="app-drag fixed left-[90px] right-16 top-0 z-0 h-10"><SwitchHole /></div>


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
                  className="flex items-center gap-2 rounded-full bg-accent px-7 py-3 text-title-sm font-medium text-accent-foreground shadow-lg transition hover:scale-[1.03] hover:opacity-90 active:scale-[0.98]">
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

            {liveOpen && <LiveDock key={activeChatId} chatId={activeChatId} onExit={() => setLiveOpen(false)} />}
            <HistorySidebar />
            <SpotlightTour id="home" active={!liveOpen} steps={[
              { target: "talk-to", title: "Pick who you talk to", body: "OpenLive voice-drives the coding agent you already use, locally, under your own login. Pick one here, or keep API mode on your own keys." },
              { target: "new", title: "Start a conversation", body: "New opens the call setup — pick a project folder, check your mic, then just talk. Interrupt any time." },
              { target: "resume", title: "Everything is saved", body: "Resume lists every conversation by project folder — including sessions from the agent's own CLI." },
              { target: "settings", title: "Make it yours", body: "Voice, agent install & sign-in, appearance, and shortcuts all live in Settings." },
            ]} />
          </motion.main>
        )}
      </AnimatePresence>
      <SettingsPage />
      <CommandPalette onNewChat={startNew} />
      <ShortcutsSheet />
      <ConnectionBanner />
    </div>
  );
}
