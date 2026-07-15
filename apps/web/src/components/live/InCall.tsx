"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, ScreenShare, ScreenShareOff, ChevronUp, Minimize2, PanelRightOpen } from "lucide-react";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { useLiveStore, type LivePhase, type DeviceOpt } from "@/lib/live/liveStore";
import { toolMeta } from "@/lib/live/toolMeta";
import { useUi } from "@/lib/uiStore";
import { Orb } from "./Orb";
import { CameraPiP } from "./CameraPiP";
import { ScreenTile } from "./ScreenTile";
import { EndCallButton } from "./EndCallButton";
import { TranscriptPanel } from "./TranscriptPanel";
import { TopBar } from "./TopBar";
import { usePopIn } from "@/lib/usePopIn";
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
}

export function InCall(props: InCallProps) {
  const { chatId, phase, muted, cameraOn, screenOn, cameraStream, screenStream, error,
    toggleMute, toggleCamera, toggleScreen, setMic, setCam, getLevels, getBands, onEnd } = props;
  const { userCaption, userPartial, agentCaption, agentCaptionMs, toolStatus, warming, mics, cams, micId, camId } = useLiveStore();
  const setMinimized = useUi((s) => s.setMinimized);
  const root = useRef<HTMLDivElement>(null);
  const sharing = cameraOn || screenOn; // orb shrinks into the bar while a visual source is on

  // Entrance — a gentle rise + settle when the call becomes active (skipped for
  // reduced-motion, which leaves the element at its final state).
  useGSAP(() => {
    if (prefersReduced()) return;
    gsap.fromTo(root.current, { autoAlpha: 0, y: 8, scale: 0.985 }, { autoAlpha: 1, y: 0, scale: 1, duration: DUR.enter, ease: EASE.snappy });
  }, { scope: root });

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
  // connecting (both blue shimmer), otherwise the plain phase label.
  const statusLabel = toolStatus ? `${toolMeta(toolStatus).active}…` : warming ? "Warming up…" : PHASE_LABEL[phase];
  const statusBusy = !!toolStatus || warming;

  return (
    <div ref={root} className="fixed inset-0 z-40 flex flex-col bg-background">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        {/* stage — orb hero, floating tiles, control bar */}
        <main className="relative min-w-0 flex-1 overflow-hidden">
          {!sharing && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <Orb phase={phase} getLevels={getLevels} getBands={getBands} size={220} />
              <p className="mt-8 min-h-[28px] max-w-xl px-6 text-center text-[20px] leading-snug tracking-tight">{words}</p>
              <p className={cn("mt-1 text-[12px] uppercase tracking-wide", statusBusy ? "arc-shimmer font-medium" : "text-faint")}>{statusLabel}</p>
            </div>
          )}

          {cameraOn && <CameraPiP stream={cameraStream} />}
          {screenOn && <ScreenTile stream={screenStream} />}

          {error && <p className="absolute inset-x-0 top-3 mx-auto max-w-md px-6 text-center text-[12.5px] text-danger">{error}</p>}

          {!panelOpen && (
            <button onClick={() => setPanelOpen(true)} title="Show transcript" aria-label="Show transcript"
              className="absolute right-3 top-3 z-20 grid size-9 place-items-center rounded-lg border border-border bg-surface text-muted-foreground transition hover:text-foreground">
              <PanelRightOpen className="size-4" />
            </button>
          )}

          {/* Status pill (orb + caption) while sharing — floats ABOVE the control bar
              so toggling a screen/camera share never resizes the bar itself. */}
          {sharing && (
            <div className="absolute bottom-[88px] left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 shadow-[0_10px_34px_-10px_rgba(0,0,0,0.4)]">
              <Orb phase={phase} getLevels={getLevels} getBands={getBands} size={26} />
              <span className="max-w-[260px] truncate text-[12.5px]" aria-live="polite">
                {words ?? <span className={cn(statusBusy ? "arc-shimmer font-medium" : "text-muted-foreground")}>{statusLabel}</span>}
              </span>
            </div>
          )}

          {/* control bar — a stable width regardless of sharing */}
          <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface px-2.5 py-2 shadow-[0_10px_34px_-10px_rgba(0,0,0,0.4)]">
            <ControlWithMenu on={!muted} icon={muted ? MicOff : Mic} danger={muted} title={muted ? "Unmute" : "Mute"} onClick={toggleMute}
              devices={mics} activeId={micId} onPick={setMic} label="Microphone" />
            <ControlWithMenu on={cameraOn} icon={cameraOn ? Video : VideoOff} title={cameraOn ? "Turn camera off" : "Turn camera on"} onClick={() => void toggleCamera()}
              devices={cams} activeId={camId} onPick={setCam} label="Camera" />
            <IconBtn on={screenOn} title={screenOn ? "Stop sharing screen" : "Share screen"} onClick={() => void toggleScreen()} icon={screenOn ? ScreenShareOff : ScreenShare} />
            <span className="mx-0.5 h-5 w-px bg-border" />
            <IconBtn on={false} title="Minimize to floating bar" onClick={() => setMinimized(true)} icon={Minimize2} />
            <EndCallButton onEnd={onEnd} />
          </div>
        </main>

        {/* transcript sidebar — resizable + collapsible */}
        {panelOpen && <TranscriptPanel chatId={chatId} width={panelW} onResize={setPanelW} onClose={() => setPanelOpen(false)} />}
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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  usePopIn(menuRef, open);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} className="relative flex items-center">
      <IconBtn on={on} title={title} onClick={onClick} icon={icon} danger={danger} />
      {devices.length > 0 && (
        <button onClick={() => setOpen((o) => !o)} aria-label={`Choose ${label}`}
          className="-ml-1 grid size-5 place-items-center rounded-full text-faint transition hover:text-foreground">
          <ChevronUp className={cn("size-3.5 transition", open && "rotate-180")} />
        </button>
      )}
      {open && (
        <div ref={menuRef} className="absolute bottom-11 left-0 z-50 w-60 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-xl">
          <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">{label}</div>
          {devices.map((d) => (
            <button key={d.id} onClick={() => { onPick(d.id); setOpen(false); }}
              className={cn("block w-full truncate px-3 py-1.5 text-left text-[12.5px] transition hover:bg-foreground/[0.06]",
                d.id === activeId ? "text-foreground" : "text-muted-foreground")}>
              {d.id === activeId ? "✓ " : "   "}{d.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
