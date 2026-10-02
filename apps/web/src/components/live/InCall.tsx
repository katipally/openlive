"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Mic, MicOff, Video, VideoOff, ScreenShare, ScreenShareOff, ChevronUp, PanelRightOpen, Pointer } from "lucide-react";
import { animate } from "motion/react";
import { EXIT, GENTLE, useMotionTokens } from "@/lib/motion";
import { useLiveStore, type LivePhase, type DeviceOpt } from "@/lib/live/liveStore";
import { captionWindow } from "@/lib/live/voiceText";
import { captionWords, wordsHeard } from "@openlive/shared/speech/timing";
import { useUi } from "@/lib/uiStore";
import { featureUsed } from "@/lib/featureUse";
import { Orb } from "./Orb";
import { CameraPiP } from "./CameraPiP";
import { ScreenTile } from "./ScreenTile";
import { EndCallButton } from "./EndCallButton";
import { HoldToSend } from "./HoldToSend";
import { HintChips } from "./HintChips";
import { TranscriptPanel } from "./TranscriptPanel";
import { TopBar } from "./TopBar";
import { setPttEnabled } from "@/lib/live/usePtt";
import { isTextTarget } from "@/lib/live/keyTargets";
import { SpotlightTour } from "@/components/SpotlightTour";
import { cn } from "@/lib/cn";
import { menuItem, menuLabel, menuPanel, MenuCheck, useMenu, Button, Swap, Tooltip, notice } from "@/components/ui";

// The orb, its caption and the dock need about this much beside the Activity
// panel; a narrower window floats the panel over the stage instead.
const STAGE_MIN = 408;

const PHASE_LABEL: Record<LivePhase, string> = {
  off: "", connecting: "Connecting…", loading: "Preparing…", reconnecting: "Reconnecting…",
  idle: "Listening", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking",
};

export interface InCallProps {
  chatId: string; phase: LivePhase; muted: boolean;
  cameraOn: boolean; screenOn: boolean; cameraStream: MediaStream | null; screenStream: MediaStream | null; error?: string;
  toggleMute: () => void;
  toggleCamera: () => void | Promise<void>; toggleScreen: () => void | Promise<void>;
  setMic: (id: string) => void; setCam: (id: string) => void;
  getLevels: () => { mic: number; agent: number };
  getBands: () => { mic: number[]; agent: number[] };
  onEnd: () => void;
  sendNow: () => void;
  sendAside: (id: string) => void;
  notForYou: (id: string) => void;
  pttUp: () => void;
}

export function InCall(props: InCallProps) {
  const { chatId, phase, muted, cameraOn, screenOn, cameraStream, screenStream, error,
    toggleMute, toggleCamera, toggleScreen, setMic, setCam, getLevels, getBands, onEnd, sendNow, sendAside, notForYou, pttUp } = props;
  // Narrow selector: the captions and the status line change many times a turn,
  // so only <Caption> subscribes to them; this re-renders for the dock's state.
  const { pttActive, pttEnabled, mics, cams, micId, camId } = useLiveStore(useShallow((s) => ({
    pttActive: s.pttActive, pttEnabled: s.pttEnabled, mics: s.mics, cams: s.cams, micId: s.micId, camId: s.camId,
  })));
  // Arm/disarm push-to-talk. Disarming while Space is held first ends the hold
  // cleanly (the engine owns the held audio), then drops the armed flag.
  const togglePtt = () => { if (pttEnabled && pttActive) pttUp(); setPttEnabled(!pttEnabled); };
  const root = useRef<HTMLDivElement>(null);
  const sharing = cameraOn || screenOn; // orb shrinks into the bar while a visual source is on

  const t = useMotionTokens();

  // Entrance: a gentle rise and settle when the call becomes active (skipped
  // under Reduce Motion, which leaves everything at its final state).
  useLayoutEffect(() => {
    const el = root.current;
    if (t.reduce || !el?.children.length) return;
    // The contents rise, never the page: a see-through page showed the home screen
    // under the call. A settled spring leaves `transform: none`, and a leftover
    // transform would re-anchor fixed menus inside them.
    const run = animate([...el.children], { opacity: [0, 1], y: [8, 0], scale: [0.985, 1] }, GENTLE);
    return () => run.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the entrance plays on mount only
  }, []);

  // Exit: a quick settle-down before teardown so ending never feels like a cut.
  const handleEnd = async () => {
    const el = root.current;
    // Under glass the home comes back first, so this fade-out shows it.
    el?.removeAttribute("data-covering");
    if (el && !t.reduce) await animate(el, { opacity: 0, y: 6, scale: 0.99 }, EXIT);
    onEnd();
  };

  // Transcript sidebar: resizable width + open/closed, both remembered.
  const [panelOpen, setPanelOpen] = useState(() => (typeof window === "undefined" ? true : localStorage.getItem("ol-transcript-open") !== "0"));
  const [panelW, setPanelW] = useState(() => {
    if (typeof window === "undefined") return 360;
    const v = Number(localStorage.getItem("ol-transcript-w"));
    return v >= 280 && v <= 640 ? v : 360;
  });
  useEffect(() => { localStorage.setItem("ol-transcript-open", panelOpen ? "1" : "0"); }, [panelOpen]);
  useEffect(() => { localStorage.setItem("ol-transcript-w", String(panelW)); }, [panelW]);
  // The call's width, live through a resize, so the panel can float over a
  // stage that no longer has room beside it.
  const body = useRef<HTMLDivElement>(null);
  const [bodyW, setBodyW] = useState(Infinity);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBodyW(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const overlay = bodyW - panelW < STAGE_MIN;

  // In-call keyboard shortcuts (Space/Enter already belong to push-to-talk/hold-commit).
  // Skipped while Settings, a prompt or any modal is up, when typing or choosing
  // in a field, and when a modifier is involved, except ⌘E (end).
  const toggleHistory = useUi((s) => s.toggleHistory);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const { permission, elicitation } = useLiveStore.getState();
      if (useUi.getState().settingsOpen || permission || elicitation || document.querySelector('[aria-modal="true"]') || isTextTarget(t)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") { e.preventDefault(); featureUsed("n_call_shortcut"); handleEnd(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      switch (e.key) {
        case "m": case "M": toggleMute(); break;
        case "c": case "C": void toggleCamera(); break;
        case "s": case "S": void toggleScreen(); break;
        case "t": case "T": setPanelOpen((v) => !v); break;
        case "h": case "H": toggleHistory(); break;
        default: return;
      }
      featureUsed("n_call_shortcut");
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggleMute, toggleCamera, toggleScreen, toggleHistory]);

  return (
    <div ref={root} data-covering="stage" className="fixed inset-0 z-stage flex flex-col bg-background">
      <TopBar />

      <div ref={body} className="relative flex min-h-0 flex-1">
        {/* stage — orb hero, floating tiles, control bar */}
        <main className="relative min-w-0 flex-1 overflow-hidden">
          {!sharing && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <Orb phase={phase} getLevels={getLevels} getBands={getBands} size={220} />
              <Caption phase={phase} />
              <div className="mt-3 min-h-[30px]"><HoldToSend sendNow={sendNow} /></div>
            </div>
          )}

          {cameraOn && <CameraPiP stream={cameraStream} />}
          {screenOn && <ScreenTile stream={screenStream} />}

          {error && <p role="alert" className={cn(notice("danger"), "absolute inset-x-0 top-3 mx-auto w-fit max-w-[min(28rem,calc(100%-3rem))]")}>{error}</p>}

          {!panelOpen && (
            <Tooltip label="Show activity" keys="T" className="animate-fade-in absolute right-3 top-3 z-20">
              <Button variant="secondary" icon size="md" onClick={() => setPanelOpen(true)} aria-label="Show activity">
                <PanelRightOpen />
              </Button>
            </Tooltip>
          )}

          {/* Status pill (orb + caption) while sharing — floats ABOVE the control bar
              so toggling a screen/camera share never resizes the bar itself. */}
          {sharing && (
            <div className="absolute bottom-[96px] left-1/2 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-hairline px-3 py-1.5 shadow-pop surface-float">
              <Orb phase={phase} getLevels={getLevels} getBands={getBands} size={26} />
              <Caption phase={phase} pill />
              <HoldToSend sendNow={sendNow} compact />
            </div>
          )}

          {/* contextual hints — above the control bar, quiet, at most two chips */}
          <HintChips className={cn("absolute inset-x-0", sharing ? "bottom-[140px]" : "bottom-[96px]")} />

          {/* The dock: one capsule of equal controls, glass under the glass look and
              solid in flat. A stable width regardless of sharing. */}
          <div data-tour="controls" role="toolbar" aria-label="Call controls"
            className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline p-1.5 shadow-pop surface-float">
            <IconBtn on={pttEnabled} label={pttEnabled ? "Push-to-talk on: Space drives talking" : "Enable push-to-talk (Space)"} onClick={togglePtt} icon={Pointer} />
            <ControlWithMenu on={!muted} icon={muted ? MicOff : Mic} danger={muted} label={muted ? "Unmute" : "Mute"} keys="M" onClick={toggleMute}
              devices={mics} activeId={micId} onPick={setMic} kind="Microphone" />
            <ControlWithMenu on={cameraOn} icon={cameraOn ? Video : VideoOff} label={cameraOn ? "Turn camera off" : "Turn camera on"} keys="C" onClick={() => void toggleCamera()}
              devices={cams} activeId={camId} onPick={setCam} kind="Camera" />
            <IconBtn on={screenOn} label={screenOn ? "Stop sharing screen" : "Share screen"} keys="S" onClick={() => void toggleScreen()} icon={screenOn ? ScreenShareOff : ScreenShare} />
            <span aria-hidden className="mx-1 h-6 w-px bg-border-heavy" />
            <EndCallButton onEnd={handleEnd} />
          </div>
        </main>

        {/* transcript sidebar — resizable + collapsible */}
        <TranscriptPanel open={panelOpen} chatId={chatId} width={Math.min(panelW, bodyW)} overlay={overlay} onResize={setPanelW} onClose={() => setPanelOpen(false)} onSendAside={sendAside} onNotForYou={notForYou} />
      </div>

      <SpotlightTour id="call" steps={[
        { target: "controls", title: "Your call controls", body: "Mute, camera, screen share, and hang up. The pointer button on the left arms push-to-talk. Once on, Space drives talking. Press ? anytime for all shortcuts." },
      ]} />
    </div>
  );
}

/** The live words (yours while you speak, the agent's as it says them) and the
 *  status line: on the stage under the orb, or as one line in the sharing pill. */
function Caption({ phase, pill }: { phase: LivePhase; pill?: boolean }) {
  const { userCaption, userPartial, agentCaption, agentCaptionAt, agentCaptionStart, toolStatus, warming, pttActive } = useLiveStore(useShallow((s) => ({
    userCaption: s.userCaption, userPartial: s.userPartial, agentCaption: s.agentCaption, agentCaptionAt: s.agentCaptionAt, agentCaptionStart: s.agentCaptionStart,
    toolStatus: s.toolStatus, warming: s.warming, pttActive: s.pttActive,
  })));
  const [agentWindow, setAgentWindow] = useState("");
  // Revealed word by word even when it all fits: "$1,200.50 on 2026-09-25" is
  // three words to read and four seconds to say. Before paint, so a new caption
  // never shows whole for a frame.
  useLayoutEffect(() => {
    const units = captionWords(agentCaption);
    let raf = 0;
    const tick = () => {
      const heard = wordsHeard(agentCaptionAt, performance.now() - agentCaptionStart);
      setAgentWindow(captionWindow(agentCaption, units, heard));
      if (heard < units.length) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [agentCaption, agentCaptionAt, agentCaptionStart]);

  // While a permission/elicitation modal is open, the user's speech is that modal's
  // answer — it's shown INSIDE the modal (ModalVoiceInput), so don't also echo the
  // interim caption here behind it ("taking my answer in the back").
  const modalOpen = useLiveStore((s) => !!s.permission || !!s.elicitation);

  // Just the WORDS — what you're saying (interim) or what the agent is saying. The
  // live state is shown ONCE, by the status label below (no duplicate "Listening").
  // Keyed per phrase, so each new one fades up in its place while its words fill in.
  const words = userPartial && userCaption
    ? (modalOpen ? null : <span key="you" className="animate-fade-in italic text-muted-foreground">{userCaption}</span>)
    : agentCaption
      ? <span key={agentCaptionStart} className="animate-fade-up inline-block font-medium text-foreground">{agentWindow || agentCaption}</span>
      : null;

  // Status line: a live tool cue while a tool runs, "Warming up…" right after
  // connecting (both blue shimmer), push-to-talk while held, otherwise the phase label.
  const statusLabel = pttActive ? "Push-to-talk: release to send" : toolStatus ? `${toolStatus}…` : warming ? "Warming up…" : PHASE_LABEL[phase];
  const statusBusy = !!toolStatus || warming;

  if (pill) return (
    <span className="min-w-0 max-w-[260px] truncate text-label" aria-live="polite">
      {words ?? <span className={cn(statusBusy ? "arc-shimmer font-medium" : "text-muted-foreground")}>{statusLabel}</span>}
    </span>
  );
  return (
    <>
      <p className="mt-8 min-h-[28px] max-w-xl px-6 text-center text-title-lg leading-snug tracking-tight">{words}</p>
      <p className={cn("mt-1 text-label uppercase tracking-wide", statusBusy ? "arc-shimmer font-medium" : "text-faint")}>{statusLabel}</p>
    </>
  );
}

function IconBtn({ on, label, keys, onClick, icon: Icon, danger }: { on: boolean; label: string; keys?: string; onClick: () => void; icon: typeof Mic; danger?: boolean }) {
  return (
    <Tooltip label={label} keys={keys}>
      <Button variant="ghost" icon size="lg" onClick={onClick} aria-label={label} aria-pressed={on}
        className={cn(danger ? "bg-destructive/10 text-danger enabled:hover:text-danger" : on && "bg-foreground/10 text-foreground")}>
        <Swap id={Icon.displayName ?? String(on)}><Icon /></Swap>
      </Button>
    </Tooltip>
  );
}

function ControlWithMenu({ on, icon, label, keys, onClick, danger, devices, activeId, onPick, kind }: {
  on: boolean; icon: typeof Mic; label: string; keys: string; onClick: () => void; danger?: boolean;
  devices: DeviceOpt[]; activeId?: string; onPick: (id: string) => void; kind: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { open, mounted, requestClose, toggle } = useMenu(ref, menuRef);
  return (
    <div ref={ref} className="relative flex items-center">
      <IconBtn on={on} label={label} keys={keys} onClick={onClick} icon={icon} danger={danger} />
      {devices.length > 0 && (
        // A full 44px target that also takes the dock's gap after it, so the
        // glyph sits as far from this control as from the next.
        <Tooltip label={`${kind} options`} className="-mr-1.5">
          <button type="button" onClick={toggle} aria-label={`${kind} options`} aria-haspopup="menu" aria-expanded={open}
            className="grid size-control-lg place-items-center rounded-full text-muted-foreground transition hover:text-foreground">
            <ChevronUp className={cn("size-3.5 transition-transform duration-spring ease-spring", open && "rotate-180")} />
          </button>
        </Tooltip>
      )}
      {mounted && (
        <div ref={menuRef} role="menu" aria-label={kind} className={cn("absolute bottom-full left-0 z-overlay mb-3 w-60 max-w-[calc(100vw-2rem)] overflow-hidden", menuPanel)}>
          <div aria-hidden className={menuLabel}>{kind}</div>
          {devices.map((d) => (
            <button key={d.id} role="menuitemradio" aria-checked={d.id === activeId} onClick={() => { onPick(d.id); requestClose(); }}
              className={cn(menuItem, "text-label", d.id === activeId ? "text-foreground" : "text-muted-foreground")}>
              <span className="min-w-0 flex-1 truncate">{d.label}</span>
              {d.id === activeId && <MenuCheck />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
