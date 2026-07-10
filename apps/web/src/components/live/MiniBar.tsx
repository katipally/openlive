"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, ScreenShare, ScreenShareOff, Maximize2, PhoneOff } from "lucide-react";
import { useLiveStore, type LivePhase } from "@/lib/live/liveStore";
import { toolMeta } from "@/lib/live/toolMeta";
import { useUi } from "@/lib/uiStore";
import { Orb } from "./Orb";
import { cn } from "@/lib/cn";

const noDrag = "[-webkit-app-region:no-drag]";
type Bridge = { mini?: () => void; unmini?: () => void; miniSize?: (h: number) => void };
const ol = (): Bridge | undefined => (typeof window !== "undefined" ? (window as unknown as { openlive?: Bridge }).openlive : undefined);

// A live preview tile inside the pill window. Because mini mode is the SAME renderer
// that owns the MediaStream, we just point a <video> at it — no separate window, no
// WebRTC loopback. `h-auto` keeps the video's true aspect ratio (no crop, no black
// bars); the pill window grows to fit it.
function Tile({ stream, kind }: { stream: MediaStream | null; kind: "camera" | "screen" }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  return (
    <div className="overflow-hidden rounded-xl bg-black">
      <video ref={ref} autoPlay muted playsInline aria-label={kind} className="block h-auto w-full" />
    </div>
  );
}

function MiniBtn({ on, title, onClick, icon: Icon, danger }: { on: boolean; title: string; onClick: () => void; icon: typeof Mic; danger?: boolean }) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className={cn("grid size-8 place-items-center rounded-full transition hover:bg-foreground/10", noDrag,
        danger ? "text-danger" : on ? "text-foreground" : "text-muted-foreground")}>
      <Icon className="size-4" />
    </button>
  );
}

// Minimized mode: the main window shrinks to this floating pill (it keeps running the
// voice pipeline). Camera/screen previews render INLINE, stacked above the pill, in
// the SAME window — which grows upward to fit. The surface fills the whole window
// (so there's never a dark gap), no border, and macOS rounds the frameless window.
export function MiniBar({ phase, muted, cameraOn, screenOn, cameraStream, screenStream,
  toggleMute, toggleCamera, toggleScreen, getLevels, getBands, onEnd }: {
  phase: LivePhase; muted: boolean; cameraOn: boolean; screenOn: boolean;
  cameraStream: MediaStream | null; screenStream: MediaStream | null;
  toggleMute: () => void; toggleCamera: () => void | Promise<void>; toggleScreen: () => void | Promise<void>;
  getLevels: () => { mic: number; agent: number }; getBands: () => { mic: number[]; agent: number[] }; onEnd: () => void;
}) {
  const setMinimized = useUi((s) => s.setMinimized);
  const { userCaption, userPartial, agentCaption, toolStatus, warming } = useLiveStore();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ol()?.mini?.();
    return () => ol()?.unmini?.();
  }, []);

  // Fit the pill window to its content: measure the content column and ask the main
  // process to resize (it grows upward, keeping the bottom edge fixed). The outer
  // div fills the whole window, so any leftover space is surface, never a dark strip.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const report = () => ol()?.miniSize?.(el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // While a tool runs or the model warms (and nothing's being spoken yet), surface
  // that as the caption with a shimmer.
  const cue = toolStatus ? `${toolMeta(toolStatus).active}…` : warming ? "Warming up…" : "";
  const caption = userPartial && userCaption ? userCaption : agentCaption || cue || (phase === "thinking" ? "Thinking…" : "Listening…");
  const cueOnly = !!cue && !(userPartial && userCaption) && !agentCaption;

  return (
    <div className="fixed inset-0 flex flex-col justify-end bg-surface [-webkit-app-region:drag]">
      <div ref={contentRef} className="flex flex-col gap-2 p-2">
        {screenOn && screenStream && <Tile stream={screenStream} kind="screen" />}
        {cameraOn && cameraStream && <Tile stream={cameraStream} kind="camera" />}
        <div className="flex items-center gap-2.5 px-1">
          <Orb phase={phase} getLevels={getLevels} getBands={getBands} size={30} />
          {confirmEnd ? (
            <>
              <span className="min-w-0 flex-1 truncate text-[12.5px]">End call?</span>
              <button onClick={() => setConfirmEnd(false)}
                className={cn(noDrag, "rounded-full px-3 py-1.5 text-[12.5px] text-muted-foreground transition hover:bg-foreground/10")}>Cancel</button>
              <button onClick={onEnd}
                className={cn(noDrag, "rounded-full bg-danger px-3 py-1.5 text-[12.5px] font-medium text-white transition hover:opacity-90")}>End</button>
            </>
          ) : (
            <>
              <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", cueOnly && "arc-shimmer font-medium")} aria-live="polite">{caption}</span>
              <MiniBtn on={!muted} title={muted ? "Unmute" : "Mute"} onClick={toggleMute} icon={muted ? MicOff : Mic} danger={muted} />
              <MiniBtn on={cameraOn} title={cameraOn ? "Camera off" : "Camera on"} onClick={() => void toggleCamera()} icon={cameraOn ? Video : VideoOff} />
              <MiniBtn on={screenOn} title={screenOn ? "Stop sharing" : "Share screen"} onClick={() => void toggleScreen()} icon={screenOn ? ScreenShareOff : ScreenShare} />
              <MiniBtn on={false} title="Expand" onClick={() => setMinimized(false)} icon={Maximize2} />
              <button onClick={() => setConfirmEnd(true)} title="End call" aria-label="End call"
                className={cn(noDrag, "grid size-8 place-items-center rounded-full bg-danger text-white transition hover:opacity-90 active:scale-95")}>
                <PhoneOff className="size-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
