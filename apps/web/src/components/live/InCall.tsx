"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { Mic, MicOff, Video, VideoOff, PhoneOff, Hand, ScreenShare, ScreenShareOff, ChevronUp } from "lucide-react";
import { useLiveStore, type LivePhase, type DeviceOpt } from "@/lib/live/liveStore";
import { Orb } from "./Orb";
import { CameraPiP } from "./CameraPiP";
import { ScreenTile } from "./ScreenTile";
import { ConversationView } from "./ConversationView";
import { TopBar } from "./TopBar";
import { cn } from "@/lib/cn";

const PHASE_LABEL: Record<LivePhase, string> = {
  off: "", connecting: "Connecting…", loading: "Preparing…", reconnecting: "Reconnecting…",
  idle: "Listening", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking",
};

export interface InCallProps {
  chatId: string; phase: LivePhase; muted: boolean; pttEnabled: boolean;
  cameraOn: boolean; screenOn: boolean; cameraStream: MediaStream | null; screenStream: MediaStream | null; error?: string;
  toggleMute: () => void; setPtt: (v: boolean) => void; holdTalk: (v: boolean) => void;
  toggleCamera: () => void | Promise<void>; toggleScreen: () => void | Promise<void>;
  setMic: (id: string) => void; setCam: (id: string) => void;
  getLevels: () => { mic: number; agent: number }; onEnd: () => void;
}

export function InCall(props: InCallProps) {
  const { chatId, phase, muted, pttEnabled, cameraOn, screenOn, cameraStream, screenStream, error,
    toggleMute, setPtt, holdTalk, toggleCamera, toggleScreen, setMic, setCam, getLevels, onEnd } = props;
  const { userCaption, userPartial, agentCaption, agentCaptionMs, mics, cams, micId, camId } = useLiveStore();
  const reduce = useReducedMotion();
  const sharing = cameraOn || screenOn; // orb shrinks into the bar while a visual source is on

  // Karaoke: reveal the agent's current chunk a few words at a time.
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

  useEffect(() => {
    if (!pttEnabled) return;
    const down = (e: KeyboardEvent) => { if (e.code === "Space" && !e.repeat) { e.preventDefault(); holdTalk(true); } };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") { e.preventDefault(); holdTalk(false); } };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [pttEnabled, holdTalk]);

  const caption = userPartial && userCaption
    ? <span className="italic text-muted-foreground">{userCaption}</span>
    : agentCaption
      ? <span className="font-medium text-foreground">{agentWindow || agentCaption}</span>
      : <span className="text-muted-foreground">{PHASE_LABEL[phase] || "Listening…"}</span>;

  return (
    <div className={cn("fixed inset-0 z-40 flex flex-col bg-background", !reduce && "animate-live-in")}>
      <TopBar />

      <main className="relative min-h-0 flex-1 overflow-hidden">
        {/* the running conversation fills the stage */}
        <ConversationView chatId={chatId} />

        {/* orb — big centre until a visual source is on, then it moves into the bar */}
        {!sharing && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <Orb phase={phase} getLevels={getLevels} size={200} />
            <p className="mt-8 max-w-xl px-6 text-center text-[20px] leading-snug tracking-tight">{caption}</p>
          </div>
        )}

        {/* floating visual tiles (independently draggable) */}
        {cameraOn && <CameraPiP stream={cameraStream} />}
        {screenOn && <ScreenTile stream={screenStream} />}

        {error && <p className="absolute inset-x-0 top-3 mx-auto max-w-md px-6 text-center text-[12.5px] text-danger">{error}</p>}

        {/* control bar */}
        <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface px-2.5 py-2 shadow-[0_10px_34px_-10px_rgba(0,0,0,0.4)]">
          {sharing && (
            <div className="flex items-center gap-2 pl-1 pr-1">
              <Orb phase={phase} getLevels={getLevels} size={30} />
              <span className="max-w-[220px] truncate text-[12.5px]" aria-live="polite">{caption}</span>
              <span className="mx-1 h-6 w-px bg-border" />
            </div>
          )}

          <IconBtn on={pttEnabled} title={pttEnabled ? "Switch to hands-free" : "Push-to-talk"} onClick={() => setPtt(!pttEnabled)} icon={Hand} />
          {pttEnabled ? (
            <button onPointerDown={() => holdTalk(true)} onPointerUp={() => holdTalk(false)} onPointerLeave={() => holdTalk(false)}
              className={cn("select-none rounded-full px-4 py-2 text-[12px] font-medium transition", muted ? "bg-foreground/[0.06] text-muted-foreground" : "bg-accent text-accent-foreground")}>
              {muted ? "Hold · Space" : "Listening"}
            </button>
          ) : (
            <ControlWithMenu on={!muted} icon={muted ? MicOff : Mic} danger={muted} title={muted ? "Unmute" : "Mute"} onClick={toggleMute}
              devices={mics} activeId={micId} onPick={setMic} label="Microphone" />
          )}
          <ControlWithMenu on={cameraOn} icon={cameraOn ? Video : VideoOff} title={cameraOn ? "Turn camera off" : "Turn camera on"} onClick={() => void toggleCamera()}
            devices={cams} activeId={camId} onPick={setCam} label="Camera" />
          <IconBtn on={screenOn} title={screenOn ? "Stop sharing screen" : "Share screen"} onClick={() => void toggleScreen()} icon={screenOn ? ScreenShareOff : ScreenShare} />
          <button onClick={onEnd} title="End call" aria-label="End call"
            className="grid size-9 place-items-center rounded-full bg-danger text-white transition hover:opacity-90 active:scale-95">
            <PhoneOff className="size-4" />
          </button>
        </div>
      </main>
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

// A control button with a little caret that opens a device picker (switch mic /
// camera live). Clicking the icon toggles; clicking the caret opens the menu.
function ControlWithMenu({ on, icon, title, onClick, danger, devices, activeId, onPick, label }: {
  on: boolean; icon: typeof Mic; title: string; onClick: () => void; danger?: boolean;
  devices: DeviceOpt[]; activeId?: string; onPick: (id: string) => void; label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
        <div className="absolute bottom-11 left-0 z-50 w-60 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-xl">
          <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">{label}</div>
          {devices.map((d) => (
            <button key={d.id} onClick={() => { onPick(d.id); setOpen(false); }}
              className={cn("block w-full truncate px-3 py-1.5 text-left text-[12.5px] transition hover:bg-foreground/[0.06]",
                d.id === activeId ? "text-foreground" : "text-muted-foreground")}>
              {d.id === activeId ? "✓ " : "   "}{d.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
