"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, ScreenShare, ScreenShareOff, Maximize2, PhoneOff } from "lucide-react";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { toolMeta } from "@/lib/live/toolMeta";
import { openliveBridge, type PanelCmd, type PanelPacket, type PanelStateSnapshot } from "@/lib/live/panelBridge";
import { Orb } from "./Orb";
import { HoldPill } from "./HoldToSend";
import { cn } from "@/lib/cn";

// The desktop mini PANEL window's UI (loaded at /mini in its own BrowserWindow).
// Everything it shows arrives over IPC from the hidden main renderer (which keeps
// running the whole voice pipeline); every button sends a command back. Previews
// are ~10 fps JPEG snapshots — a MediaStream can't cross windows.

const NO_BANDS = [0, 0, 0, 0, 0];
const IDLE: PanelStateSnapshot = {
  phase: "idle", muted: false, cameraOn: false, screenOn: false,
  userCaption: "", userPartial: false, agentCaption: "", toolStatus: "", warming: false,
  pttActive: false, holdUntil: null, holdMs: 4000, permission: null,
};

function MiniBtn({ on, title, onClick, icon: Icon, danger }: { on: boolean; title: string; onClick: () => void; icon: typeof Mic; danger?: boolean }) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className={cn("grid size-8 place-items-center rounded-full transition hover:bg-foreground/10 [-webkit-app-region:no-drag]",
        danger ? "text-danger" : on ? "text-foreground" : "text-muted-foreground")}>
      <Icon className="size-4" />
    </button>
  );
}

const MINI_HINT_KEY = "openlive-tour-mini";

export function PanelMiniBar() {
  const [s, setS] = useState<PanelStateSnapshot>(IDLE);
  const [hint, setHint] = useState(false);
  useEffect(() => { try { setHint(!localStorage.getItem(MINI_HINT_KEY)); } catch { /* */ } }, []);
  const dismissHint = () => { setHint(false); try { localStorage.setItem(MINI_HINT_KEY, "1"); } catch { /* */ } };
  const [frames, setFrames] = useState<{ cam?: string; screen?: string }>({});
  const [confirmEnd, setConfirmEnd] = useState(false);
  const bands = useRef<{ mic: number[]; agent: number[] }>({ mic: NO_BANDS, agent: NO_BANDS });
  const contentRef = useRef<HTMLDivElement>(null);
  const cmd = (c: PanelCmd) => openliveBridge()?.panelCmd?.(c);

  // Gentle rise as the panel window appears.
  useGSAP(() => {
    if (prefersReduced()) return;
    gsap.fromTo(contentRef.current, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: DUR.base, ease: EASE.out });
  }, { scope: contentRef });

  useEffect(() => {
    openliveBridge()?.onPanelState?.((p: PanelPacket) => {
      if (p.k === "s") setS(p.s);
      else if (p.k === "b") bands.current = { mic: p.mic, agent: p.agent };
      else setFrames({ cam: p.cam, screen: p.screen });
    });
  }, []);

  // Fit the panel window to its content (previews stack above the pill; the window
  // grows upward — same contract as the old in-window pill).
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    let last = 0;
    const report = () => {
      const h = el.offsetHeight;
      if (Math.abs(h - last) <= 2) return; // pixel jitter never drives window bounds
      last = h;
      openliveBridge()?.miniSize?.(h);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cue = s.pttActive ? "Release to send…" : s.toolStatus ? `${toolMeta(s.toolStatus).active}…` : s.warming ? "Warming up…" : "";
  const caption = s.userPartial && s.userCaption ? s.userCaption : s.agentCaption || cue || (s.phase === "thinking" ? "Thinking…" : "Listening…");
  const cueOnly = !!cue && !(s.userPartial && s.userCaption) && !s.agentCaption;
  const getLevels = () => ({ mic: 0, agent: 0 });
  const getBands = () => bands.current;

  return (
    <div className="fixed inset-0 flex flex-col justify-end bg-surface [-webkit-app-region:drag]">
      <div ref={contentRef} className="flex flex-col gap-2 p-2">
        {hint && (
          <div className="flex items-center gap-2 rounded-xl bg-card px-2.5 py-2 shadow-[var(--shadow-card)] animate-fade-up">
            <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-muted-foreground">The call keeps running here — your global shortcut toggles talking from any app.</span>
            <button onClick={dismissHint} aria-label="Dismiss"
              className="grid size-6 shrink-0 place-items-center rounded-full text-faint transition hover:bg-foreground/10 hover:text-foreground [-webkit-app-region:no-drag]">×</button>
          </div>
        )}
        {s.screenOn && frames.screen && (
          <div className="aspect-video w-full overflow-hidden rounded-xl bg-black">
            <img src={frames.screen} alt="screen preview" className="size-full object-contain" />
          </div>
        )}
        {s.cameraOn && frames.cam && (
          <div className="aspect-video w-full overflow-hidden rounded-xl bg-black">
            <img src={frames.cam} alt="camera preview" className="size-full object-cover" />
          </div>
        )}

        {s.permission && (
          <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-card px-2.5 py-2">
            <span className="text-[12px] leading-snug">{s.permission.question}</span>
            <span className="flex flex-wrap gap-1.5">
              {s.permission.options.map((o) => (
                <button key={o.id} onClick={() => cmd({ t: "permission", optionId: o.id })}
                  className="rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted-foreground transition hover:text-foreground [-webkit-app-region:no-drag]">
                  {o.label}
                </button>
              ))}
            </span>
          </div>
        )}

        <div className="flex items-center gap-2.5 px-1">
          <Orb phase={s.phase} getLevels={getLevels} getBands={getBands} size={30} />
          {confirmEnd ? (
            <>
              <span className="min-w-0 flex-1 truncate text-[12.5px]">End call?</span>
              <button onClick={() => setConfirmEnd(false)}
                className="rounded-full px-3 py-1.5 text-[12.5px] text-muted-foreground transition hover:bg-foreground/10 [-webkit-app-region:no-drag]">Cancel</button>
              <button onClick={() => cmd({ t: "end" })}
                className="rounded-full bg-danger px-3 py-1.5 text-[12.5px] font-medium text-white transition hover:opacity-90 [-webkit-app-region:no-drag]">End</button>
            </>
          ) : (
            <>
              <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", cueOnly && "arc-shimmer font-medium")} aria-live="polite">{caption}</span>
              {s.holdUntil && (
                <span className="[-webkit-app-region:no-drag]">
                  <HoldPill until={s.holdUntil} holdMs={s.holdMs} onSend={() => cmd({ t: "sendNow" })} compact />
                </span>
              )}
              <MiniBtn on={!s.muted} title={s.muted ? "Unmute" : "Mute"} onClick={() => cmd({ t: "mute" })} icon={s.muted ? MicOff : Mic} danger={s.muted} />
              <MiniBtn on={s.cameraOn} title={s.cameraOn ? "Camera off" : "Camera on"} onClick={() => cmd({ t: "camera" })} icon={s.cameraOn ? Video : VideoOff} />
              <MiniBtn on={s.screenOn} title={s.screenOn ? "Stop sharing" : "Share screen"} onClick={() => cmd({ t: "screen" })} icon={s.screenOn ? ScreenShareOff : ScreenShare} />
              <MiniBtn on={false} title="Expand" onClick={() => cmd({ t: "expand" })} icon={Maximize2} />
              <button onClick={() => setConfirmEnd(true)} title="End call" aria-label="End call"
                className="grid size-8 place-items-center rounded-full bg-danger text-white transition hover:opacity-90 active:scale-95 [-webkit-app-region:no-drag]">
                <PhoneOff className="size-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
