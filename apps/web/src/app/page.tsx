"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, stagger, useReducedMotion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { Settings2, MessageSquare, Plus } from "lucide-react";
import { animateAll, EXIT, FADE, GENTLE, SHEET, SMOOTH } from "@/lib/motion";
import { APP_MODES, useUi } from "@/lib/uiStore";
import { LiveDock } from "@/components/live/LiveDock";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { HistorySidebar } from "@/components/HistorySidebar";
import { SpotlightTour } from "@/components/SpotlightTour";
import { AgentSelect } from "@/components/live/AgentControls";
import { OpenLiveMark } from "@/components/OpenLiveMark";
import { Button, Tooltip } from "@/components/ui";
import { useAppVersion } from "@/lib/useAppVersion";
import { useHydrated } from "@/lib/useHydrated";
import { SETTINGS_KEYS } from "@/lib/platform";
import { setConversationBind } from "@/lib/live/useLiveSession";
import { useLiveStore } from "@/lib/live/liveStore";
import { useDefaultAgent } from "@/components/settings/WhoAnswers";
import { loadModels, modelsCached, modelsReady } from "@/lib/live/models";
import { wirePanelCmdRouter } from "@/lib/live/panelBridge";
import { MODES, ModeStart, ModeSwitch, modeCopy, SwitchHole } from "@/components/flow/ModeSwitch";
import { flowBridge } from "@/lib/flow/bridge";
import { FlowShell } from "@/components/flow/FlowShell";
import { CommandPalette } from "@/components/CommandPalette";
import { ShortcutsSheet } from "@/components/ShortcutsSheet";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { PrivacyNotice } from "@/components/PrivacyNotice";
import { FeedbackPrompt } from "@/components/FeedbackPrompt";
import { DictateHome } from "@/components/dictate/DictateHome";
import { Welcome } from "@/components/Welcome";

// One home for the mode switch: top centre of the window, clear of the traffic
// lights on the left and the window controls on the right, in every mode.
const MODE_SWITCH_AT = "fixed left-1/2 top-2 z-nav -translate-x-1/2";

// Views slide the way the switch reads: Chat, Flow, Dictate, left to right.
// `custom` is the direction (1 rightward, -1 leftward, 0 to only cross-fade).
const VIEW = {
  variants: {
    enter: (d: number) => ({ x: `${d * 6}%`, opacity: 0 }),
    // The leaving view clears out before the arriving one is half in: at equal
    // speeds both heroes sat on screen at half strength, a double-exposed orb.
    shown: { x: "0%", opacity: 1, transition: { ...SHEET, delay: 0.08 } },
    exit: (d: number) => ({ x: `${d * -6}%`, opacity: 0, transition: EXIT }),
  },
  initial: "enter", animate: "shown", exit: "exit",
  transition: SHEET,
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
  const settingsOpen = useUi((s) => s.settingsOpen);
  const reduce = useReducedMotion();
  const hydrated = useHydrated();
  // The first-run notice goes first: two overlays would contend for the same first look.
  const [noticePending, setNoticePending] = useState(false);
  const [welcomePending, setWelcomePending] = useState(false);
  // Welcome already showed the modes and the agent picker, so the home tour right after it skips those.
  const [welcomedNow, setWelcomedNow] = useState(false);
  useEffect(() => { if (welcomePending) setWelcomedNow(true); }, [welcomePending]);
  // The hero's "Talk to" is what the next new chat talks to: the default each
  // time the hero comes back, and whenever the default changes.
  const defaultAgent = useDefaultAgent();
  useEffect(() => { if (!liveOpen && defaultAgent !== undefined) useLiveStore.getState().set({ boundAgent: defaultAgent }); }, [liveOpen, defaultAgent]);

  // Warm the on-device voice models in the background as soon as the app loads, so
  // opening Live doesn't stall on "Preparing…". Only when the weights are already
  // cached — a fresh install still downloads via the explicit pre-call button (we
  // don't silently pull hundreds of MB on first launch).
  useEffect(() => {
    if (modelsCached() && !modelsReady()) void loadModels(() => {}, "launch_warm").catch(() => {});
  }, []);

  // Desktop: route the orb's call controls (mute / end) to the live call.
  useEffect(() => {
    wirePanelCmdRouter();
    // Flow's orb asked for the whole window. It opens on Flow, because that is
    // what the person was already in, and on the settings page the fix is on.
    flowBridge()?.onShow?.((to) => {
      useUi.getState().setMode("flow");
      const tab = /^([a-z]+)-settings$/.exec(to)?.[1];
      if (tab) useUi.getState().openSettingsTab(tab);
    });
  }, []);

  // The tray turns Dictate on and off with this window out of the loop; main says so here.
  const qc = useQueryClient();
  useEffect(() => flowBridge()?.onSettingsChanged?.(() => void qc.invalidateQueries({ queryKey: ["flow-config"] })), [qc]);

  const heroRef = useRef<HTMLDivElement>(null);

  // Launch reveal, the one orchestrated hero moment: the mark settles in, headline
  // and tagline rise, the CTAs stagger up, the talk-to line fades last. Runs once
  // per mount of the hero (not during calls; LiveDock covers it).
  useLayoutEffect(() => {
    const el = heroRef.current;
    if (!el || reduce) return;
    const runs = [
      animateAll(el, ".ol-hero-mark", { opacity: [0, 1], scale: [0.86, 1], y: [6, 0] }, GENTLE),
      animateAll(el, ".ol-hero-title", { opacity: [0, 1], y: [14, 0] }, { ...GENTLE, delay: 0.2 }),
      animateAll(el, ".ol-hero-tag", { opacity: [0, 1], y: [10, 0] }, { ...GENTLE, delay: 0.34 }),
      animateAll(el, ".ol-hero-cta > *", { opacity: [0, 1], y: [12, 0] }, { ...SMOOTH, delay: stagger(0.06, { startDelay: 0.5 }) }),
      animateAll(el, ".ol-hero-sub", { opacity: [0, 1] }, { ...FADE, delay: 0.78 }),
    ];
    return () => runs.forEach((r) => r?.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the reveal plays on mount only
  }, []);

  const startNew = () => {
    newConversation();
    // Carry the hero's "Talk to" pick onto the freshly created conversation,
    // the API key too, so a later change of default never moves it.
    setConversationBind(useUi.getState().activeChatId, useLiveStore.getState().boundAgent);
    setLiveOpen(true);
  };

  // Flow and Dictate swap the whole window rather than sharing the lobby's
  // centred layout. Their keys are armed by the owner renderer either way, so
  // this only changes what is on screen. A call in progress keeps Chat up: you
  // cannot switch mid-call. The switch and Settings sit outside the sliding
  // views, so changing mode never moves or remounts them.
  const view = liveOpen ? "chat" : mode;
  // The direction is fixed on the render the view changes in; a re-render keeps it.
  const shown = useRef({ view, dir: 0 });
  if (shown.current.view !== view) shown.current = { view, dir: Math.sign(APP_MODES.indexOf(view) - APP_MODES.indexOf(shown.current.view)) };
  const dir = reduce ? 0 : shown.current.dir;

  return (
    // The one stacking context the views used to own: at rest the views add none,
    // so Settings, tours and the switch layer exactly as before. x-clip stops the
    // slide from flashing a horizontal scrollbar.
    <div className="relative z-10 overflow-x-clip">
      {/* Layers (globals.css "Layers under glass"): under the glass look the window
          is see-through, so a full-window surface hides the layers it covers. */}
      <div data-layer="view" className="relative">
      {!liveOpen && <ModeSwitch className={MODE_SWITCH_AT} />}
      <AnimatePresence initial={false} mode="popLayout" custom={dir}>
        {view === "flow" ? (
          <motion.main key="flow" custom={dir} {...VIEW} className="relative flex min-h-dvh flex-col text-left">
            {hydrated && <FlowShell />}
          </motion.main>
        ) : view === "dictate" ? (
          <motion.main key="dictate" custom={dir} {...VIEW} className="relative flex min-h-dvh flex-col text-left">
            {hydrated && <DictateHome />}
          </motion.main>
        ) : (
          <motion.main key="chat" custom={dir} {...VIEW} className="relative flex min-h-dvh flex-col items-center justify-center px-6 text-center">
            {/* Frameless-window drag handle: a title-bar-high strip clear of the macOS
                traffic lights and the Windows/Linux caption buttons, both (the
                server cannot tell which this window has). Desktop only (.desktop). Settings lives in the hero CTA row
                below — no duplicate corner gear. The hole is the mode switch's; see
                SwitchHole for why the strip has to cut it rather than the switch. */}
            <div className="app-drag fixed left-traffic-lights right-window-controls top-0 z-0 h-14"><SwitchHole /></div>


            <div ref={heroRef} className="flex max-w-full flex-col items-center gap-7">
              <div className="ol-hero-mark"><OpenLiveMark paused={liveOpen || settingsOpen} /></div>
              <div className="space-y-2">
                <h1 className="ol-hero-title text-display font-semibold tracking-tight">OpenLive</h1>
                <p className="ol-hero-tag max-w-sm text-callout leading-relaxed text-muted-foreground">
                  Ears, eyes, and a voice for your AI.
                </p>
                <p className="ol-hero-tag max-w-sm text-label leading-relaxed text-faint">
                  {modeCopy("chat").tagline} <ModeStart mode="chat" />
                </p>
              </div>
              <div className="ol-hero-cta flex flex-wrap items-center justify-center gap-3">
                <Button variant="primary" size="lg" onClick={startNew} data-tour="new"><Plus /> New</Button>
                <Tooltip label="Browse & resume past conversations">
                  <Button size="lg" onClick={() => setHistoryOpen(true)} data-tour="resume">
                    <MessageSquare /> Resume
                  </Button>
                </Tooltip>
                <Tooltip label="Settings" keys={SETTINGS_KEYS}>
                  <Button size="lg" icon onClick={openSettings} aria-label="Settings" data-tour="settings"><Settings2 /></Button>
                </Tooltip>
              </div>
              {/* Choose what a new conversation talks to — the built-in assistant or a
                  coding agent (Claude Code / Codex / Cursor). Carried into "New". */}
              <div className="ol-hero-sub flex max-w-full items-center gap-2 text-label text-faint" data-tour="talk-to">
                Talk to <AgentSelect up />
              </div>
            </div>

            <footer className="absolute inset-x-0 bottom-4 flex items-center justify-center text-caption text-faint">
              <a href="https://github.com/katipally/openlive/releases" target="_blank" rel="noreferrer" className="transition hover:text-muted-foreground">
                {appVersion ? `v${appVersion}` : "dev"}
              </a>
            </footer>

            <SpotlightTour id="home" active={!liveOpen && !noticePending && !welcomePending} steps={[
              ...welcomedNow ? [] : [{ target: "mode", title: "Three ways to talk", body: `${MODES.map((m) => `${m.label}: ${m.tagline}`).join(" ")} Switch here any time.` },
              { target: "talk-to", title: "Pick who you talk to", body: "OpenLive voice-drives the coding agent you already use, locally, under your own login. Pick one here, or keep your API key. New chats start with the default from Settings." }],
              { target: "new", title: "Start a conversation", body: "New opens the call setup: pick a project folder, check your mic, then talk. Interrupt any time." },
              { target: "resume", title: "Everything is saved", body: "Resume lists every conversation by project folder, including sessions from the agent's own CLI." },
              { target: "settings", title: "Make it yours", body: "Voice, agent install & sign-in, appearance, and shortcuts all live in Settings." },
            ]} />
          </motion.main>
        )}
      </AnimatePresence>
      </div>
      {liveOpen && <div data-layer="stage"><LiveDock key={activeChatId} chatId={activeChatId} onExit={() => setLiveOpen(false)} /></div>}
      {view === "chat" && <div data-layer="drawer"><HistorySidebar /></div>}
      <SettingsPage />
      <CommandPalette onNewChat={startNew} />
      <ShortcutsSheet />
      <ConnectionBanner />
      <Welcome onPending={setWelcomePending} />
      <PrivacyNotice onPending={setNoticePending} />
      <FeedbackPrompt hold={noticePending || welcomePending || liveOpen} />
    </div>
  );
}
