"use client";

import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Mic, MicOff, Video, VideoOff, ScreenShare, ScreenShareOff, ChevronUp, Minimize2, PanelRightOpen, Pointer } from "lucide-react";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { useLiveStore, type LivePhase, type DeviceOpt } from "@/lib/live/liveStore";
import { toolMeta } from "@/lib/live/toolMeta";
import { useUi } from "@/lib/uiStore";
import { Orb } from "./Orb";
import { CameraPiP } from "./CameraPiP";
import { ScreenTile } from "./ScreenTile";
import { EndCallButton } from "./EndCallButton";
import { HoldToSend } from "./HoldToSend";
import { HintChips } from "./HintChips";
import { TranscriptPanel } from "./TranscriptPanel";
import { TopBar } from "./TopBar";
import { setPttEnabled } from "@/lib/live/usePtt";
import { SpotlightTour } from "@/components/SpotlightTour";
import { useMenuPresence, usePresence } from "@/lib/usePopIn";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { cn } from "@/lib/cn";

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
  pttUp: () => void;
}

export function InCall(props: InCallProps) {
  const { chatId, phase, muted, cameraOn, screenOn, cameraStream, screenStream, error,
    toggleMute, toggleCamera, toggleScreen, setMic, setCam, getLevels, getBands, onEnd, sendNow, pttUp } = props;
  // Narrow selector: captions re-render this component by design (it displays
  // them), but download/todos/usage/terminals/permission changes should not.
  const { userCaption, userPartial, agentCaption, agentCaptionMs, toolStatus, warming, pttActive, pttEnabled, mics, cams, micId, camId } = useLiveStore(useShallow((s) => ({
    userCaption: s.userCaption, userPartial: s.userPartial, agentCaption: s.agentCaption, agentCaptionMs: s.agentCaptionMs,
    toolStatus: s.toolStatus, warming: s.warming, pttActive: s.pttActive, pttEnabled: s.pttEnabled,
    mics: s.mics, cams: s.cams, micId: s.micId, camId: s.camId,
  })));
  // Arm/disarm push-to-talk. Disarming while Space is held first ends the hold
  // cleanly (the engine owns the held audio), then drops the armed flag.
  const togglePtt = () => { if (pttEnabled && pttActive) pttUp(); setPttEnabled(!pttEnabled); };
  const setMinimized = useUi((s) => s.setMinimized);
  const root = useRef<HTMLDivElement>(null);
  const sharing = cameraOn || screenOn; // orb shrinks into the bar while a visual source is on

  // Entrance — a gentle rise + settle when the call becomes active (skipped for
  // reduced-motion, which leaves the element at its final state).
  const { contextSafe } = useGSAP(() => {
    if (prefersReduced()) return;
    gsap.fromTo(root.current, { autoAlpha: 0, y: 8, scale: 0.985 }, { autoAlpha: 1, y: 0, scale: 1, duration: DUR.enter, ease: EASE.out });
  }, { scope: root });

  // Exit — a quick settle-down before teardown so ending never feels like a cut.
  const handleEnd = contextSafe(() => {
    if (!root.current || prefersReduced()) { onEnd(); return; }
    gsap.to(root.current, { autoAlpha: 0, y: 6, scale: 0.99, duration: DUR.fast, ease: EASE.soft, onComplete: onEnd });
  });

  // Transcript sidebar: resizable width + open/closed, both remembered.
  const [panelOpen, setPanelOpen] = useState(() => (typeof window === "undefined" ? true : localStorage.getItem("ol-transcript-open") !== "0"));
  const [panelW, setPanelW] = useState(() => {
    if (typeof window === "undefined") return 360;
    const v = Number(localStorage.getItem("ol-transcript-w"));
    return v >= 280 && v <= 640 ? v : 360;
  });
  useEffect(() => { localStorage.setItem("ol-transcript-open", panelOpen ? "1" : "0"); }, [panelOpen]);
  useEffect(() => { localStorage.setItem("ol-transcript-w", String(panelW)); }, [panelW]);

  const [agentWindow, setAgentWindow] = useState("");
  useEffect(() => {
    const words = agentCaption.split(/\s+/).filter(Boolean);
    if (words.length <= 5) { setAgentWindow(words.join(" ")); return; }
    const dur = agentCaptionMs > 0 ? agentCaptionMs : words.length * 320;
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const frac = Math.min(1, (performance.now() - start) / dur);
      const idx = Math.max(1, Math.min(words.length, Math.ceil(frac * words.length)));
      setAgentWindow(words.slice(Math.max(0, idx - 5), idx).join(" "));
      if (frac < 1) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [agentCaption, agentCaptionMs]);

  // Just the WORDS — what you're saying (interim) or what the agent is saying. The
  // live state is shown ONCE, by the status label below (no duplicate "Listening").
  const words = userPartial && userCaption
    ? <span className="italic text-muted-foreground">{userCaption}</span>
    : agentCaption
      ? <span className="font-medium text-foreground">{agentWindow || agentCaption}</span>
      : null;

  // Status line: a live tool cue while a tool runs, "Warming up…" right after
  // connecting (both blue shimmer), push-to-talk while held, otherwise the phase label.
  const statusLabel = pttActive ? "Push-to-talk — release to send" : toolStatus ? `${toolMeta(toolStatus).active}…` : warming ? "Warming up…" : PHASE_LABEL[phase];
  const statusBusy = !!toolStatus || warming;

  // In-call keyboard shortcuts. Single letters are safe here — there's no text
  // input during a call (Space/Enter already belong to push-to-talk/hold-commit).
  // Skipped when a menu input or modifier is involved, except ⌘E (end).
  const [sheetOpen, setSheetOpen] = useState(false);
  const toggleHistory = useUi((s) => s.toggleHistory);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") { e.preventDefault(); handleEnd(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      switch (e.key) {
        case "m": case "M": toggleMute(); break;
        case "c": case "C": void toggleCamera(); break;
        case "s": case "S": void toggleScreen(); break;
        case "t": case "T": setPanelOpen((v) => !v); break;
        case "h": case "H": toggleHistory(); break;
        case "?": setSheetOpen((v) => !v); break;
        case "Escape": setSheetOpen(false); return; // don't preventDefault other Esc handlers
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggleMute, toggleCamera, toggleScreen, toggleHistory]);

  return (
    <div ref={root} className="fixed inset-0 z-40 flex flex-col bg-background">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        {/* stage — orb hero, floating tiles, control bar */}
        <main className="relative min-w-0 flex-1 overflow-hidden">
          {!sharing && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <Orb phase={phase} getLevels={getLevels} getBands={getBands} size={220} />
              <p className="mt-8 min-h-[28px] max-w-xl px-6 text-center text-title-lg leading-snug tracking-tight">{words}</p>
              <p className={cn("mt-1 text-label uppercase tracking-wide", statusBusy ? "arc-shimmer font-medium" : "text-faint")}>{statusLabel}</p>
              <div className="mt-3 min-h-[30px]"><HoldToSend sendNow={sendNow} /></div>
            </div>
          )}

          {cameraOn && <CameraPiP stream={cameraStream} />}
          {screenOn && <ScreenTile stream={screenStream} />}

          {error && <p className="absolute inset-x-0 top-3 mx-auto max-w-md px-6 text-center text-label text-danger">{error}</p>}

          {!panelOpen && (
            <button onClick={() => setPanelOpen(true)} title="Show activity" aria-label="Show activity"
              className="absolute right-3 top-3 z-20 grid size-9 place-items-center rounded-lg border border-border bg-surface text-muted-foreground transition hover:text-foreground">
              <PanelRightOpen className="size-4" />
            </button>
          )}

          {/* Status pill (orb + caption) while sharing — floats ABOVE the control bar
              so toggling a screen/camera share never resizes the bar itself. */}
          {sharing && (
            <div className="absolute bottom-[88px] left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 shadow-[var(--shadow-pop)]">
              <Orb phase={phase} getLevels={getLevels} getBands={getBands} size={26} />
              <span className="max-w-[260px] truncate text-label" aria-live="polite">
                {words ?? <span className={cn(statusBusy ? "arc-shimmer font-medium" : "text-muted-foreground")}>{statusLabel}</span>}
              </span>
              <HoldToSend sendNow={sendNow} compact />
            </div>
          )}

          {/* contextual hints — above the control bar, quiet, at most two chips */}
          <HintChips className={cn("absolute inset-x-0", sharing ? "bottom-[132px]" : "bottom-[88px]")} />

          {/* control bar — a stable width regardless of sharing */}
          <div data-tour="controls" className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface px-2.5 py-2 shadow-[var(--shadow-pop)]">
            <IconBtn on={pttEnabled} title={pttEnabled ? "Push-to-talk on — Space drives talking" : "Enable push-to-talk (Space)"} onClick={togglePtt} icon={Pointer} />
            <ControlWithMenu on={!muted} icon={muted ? MicOff : Mic} danger={muted} title={muted ? "Unmute" : "Mute"} onClick={toggleMute}
              devices={mics} activeId={micId} onPick={setMic} label="Microphone" />
            <ControlWithMenu on={cameraOn} icon={cameraOn ? Video : VideoOff} title={cameraOn ? "Turn camera off" : "Turn camera on"} onClick={() => void toggleCamera()}
              devices={cams} activeId={camId} onPick={setCam} label="Camera" />
            <IconBtn on={screenOn} title={screenOn ? "Stop sharing screen" : "Share screen"} onClick={() => void toggleScreen()} icon={screenOn ? ScreenShareOff : ScreenShare} />
            <span className="mx-0.5 h-5 w-px bg-border" />
            <IconBtn on={false} title="Minimize to floating bar" onClick={() => setMinimized(true)} icon={Minimize2} />
            <EndCallButton onEnd={handleEnd} />
          </div>
        </main>

        {/* transcript sidebar — resizable + collapsible */}
        <TranscriptPanel open={panelOpen} chatId={chatId} width={panelW} onResize={setPanelW} onClose={() => setPanelOpen(false)} />
      </div>

      <SpotlightTour id="call" steps={[
        { target: "controls", title: "Your call controls", body: "Mute, camera, screen share, minimize to the floating pill, and hang up. The pointer button on the left arms push-to-talk — once on, Space drives talking. Press ? anytime for all shortcuts." },
      ]} />

      <ShortcutSheet open={sheetOpen} pttEnabled={pttEnabled} onClose={() => setSheetOpen(false)} />
    </div>
  );
}

// The "?" cheat sheet — every in-call binding in one quiet card.
function ShortcutSheet({ open, pttEnabled, onClose }: { open: boolean; pttEnabled: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const mounted = usePresence(ref, open);
  useFocusTrap(ref, mounted, onClose);
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const mod = mac ? "⌘" : "Ctrl";
  const rows: [string, string][] = [
    ["M", "Mute / unmute"],
    ["C", "Camera on / off"],
    ["S", "Share screen"],
    ["T", "Show / hide activity panel"],
    ["H", "History sidebar"],
    [`${mod} E`, "End call"],
    [`${mod} ,`, "Settings"],
    ...(pttEnabled ? [["Space", "Push-to-talk (hold or tap)"], ["Enter", "Send a held thought now"]] as [string, string][] : []),
    ["?", "This cheat sheet"],
  ];
  if (!mounted) return null;
  return (
    <div ref={ref} className="fixed inset-0 z-[var(--z-modal)] grid place-items-center bg-black/30" onClick={onClose} role="dialog" aria-label="Keyboard shortcuts">
      <div className="animate-modal-in w-72 rounded-2xl bg-popover p-4 shadow-[var(--shadow-pop)]" onClick={(e) => e.stopPropagation()}>
        <p className="mb-2.5 text-body font-semibold">Keyboard shortcuts</p>
        <div className="flex flex-col gap-1.5">
          {rows.map(([key, what]) => (
            <div key={key} className="flex items-center justify-between text-label">
              <span className="text-muted-foreground">{what}</span>
              <kbd className="rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-caption text-foreground">{key}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function IconBtn({ on, title, onClick, icon: Icon, danger }: { on: boolean; title: string; onClick: () => void; icon: typeof Mic; danger?: boolean }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} aria-pressed={on}
      className={cn("grid size-9 place-items-center rounded-full transition hover:bg-foreground/10",
        danger ? "text-danger" : on ? "text-foreground" : "text-muted-foreground")}>
      <Icon className="size-4" />
    </button>
  );
}

function ControlWithMenu({ on, icon, title, onClick, danger, devices, activeId, onPick, label }: {
  on: boolean; icon: typeof Mic; title: string; onClick: () => void; danger?: boolean;
  devices: DeviceOpt[]; activeId?: string; onPick: (id: string) => void; label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { open, mounted, requestClose, toggle } = useMenuPresence(menuRef);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) requestClose(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <div ref={ref} className="relative flex items-center">
      <IconBtn on={on} title={title} onClick={onClick} icon={icon} danger={danger} />
      {devices.length > 0 && (
        <button onClick={toggle} aria-label={`Choose ${label}`}
          className="-ml-1 grid size-5 place-items-center rounded-full text-faint transition hover:text-foreground">
          <ChevronUp className={cn("size-3.5 transition", open && "rotate-180")} />
        </button>
      )}
      {mounted && (
        <div ref={menuRef} className="absolute bottom-11 left-0 z-50 w-60 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-xl">
          <div className="px-3 py-1.5 text-caption font-medium uppercase tracking-wide text-faint">{label}</div>
          {devices.map((d) => (
            <button key={d.id} onClick={() => { onPick(d.id); requestClose(); }}
              className={cn("block w-full truncate px-3 py-1.5 text-left text-label transition hover:bg-foreground/[0.06]",
                d.id === activeId ? "text-foreground" : "text-muted-foreground")}>
              {d.id === activeId ? "✓ " : "   "}{d.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
