"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Square, TextCursorInput, Volume2, VolumeX } from "lucide-react";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { openliveBridge, type PanelCmd, type PanelPacket, type PanelStateSnapshot } from "@/lib/live/panelBridge";
import { flowBridge } from "@/lib/flow/bridge";
import { quietLabel } from "@/lib/flow/quiet";
import { IDLE_FLOW, type FlowSnapshot } from "@/lib/flow/types";
import type { PendingPermission } from "@/lib/live/liveStore";
import { Orb } from "@/components/live/Orb";
import { cn } from "@/lib/cn";

// Flow's pill, in its own always-on-top window next to the cursor. Everything it
// shows arrives over IPC from the owner renderer; every control sends a command
// back. It decides nothing.

const NO_BANDS = [0, 0, 0, 0, 0];

/** Flow's phases onto the orb's palette: acting and confirming are both work. */
const orbPhase = (p: FlowSnapshot["phase"]) =>
  p === "listening" ? "listening" : p === "speaking" ? "speaking" : p === "idle" || p === "error" ? "idle" : "thinking";

function heading(s: FlowSnapshot): { title: string; detail: string } {
  if (s.inserting) return { title: `Typing${s.inserting.app ? ` into ${s.inserting.app}` : ""}`, detail: s.detail };
  if (s.warming !== null) return { title: "Warming up", detail: `Getting the voice models ready, ${Math.round(s.warming * 100)}%. Keep talking, I am still recording.` };
  switch (s.phase) {
    case "listening": return { title: s.transcript || "Go ahead", detail: s.transcript ? "" : "Keep holding. Let go when you are done talking." };
    case "thinking": return { title: s.transcript ? `“${s.transcript}”` : "Thinking", detail: s.detail || "Thinking" };
    case "acting": return { title: s.transcript ? `“${s.transcript}”` : "Working", detail: s.detail || "Working" };
    case "speaking": return { title: "Speaking", detail: "Just start talking to cut me off" };
    case "confirming": return { title: "One thing first", detail: "" };
    default: return { title: "Go ahead", detail: "Keep holding. Let go when you are done talking." };
  }
}

function Chips({ permission, cmd }: { permission: PendingPermission; cmd: (c: PanelCmd) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-label font-medium leading-snug">{permission.question}</span>
      <div className="flex flex-wrap items-center gap-2">
        {permission.options.map((o) => (
          <button key={o.id} onClick={() => cmd({ t: "permission", optionId: o.id })}
            className={cn("rounded-full px-3.5 py-1.5 text-label font-medium transition [-webkit-app-region:no-drag]",
              o.kind?.startsWith("allow") ? "bg-danger text-white hover:opacity-90" : "bg-card text-foreground hover:bg-foreground/10")}>
            {o.label}
          </button>
        ))}
        <span className="min-w-0 flex-1 text-right text-caption text-muted-foreground">or say “yes” / “cancel”</span>
      </div>
    </div>
  );
}

export function FlowPill() {
  const [s, setS] = useState<FlowSnapshot>(IDLE_FLOW);
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const bands = useRef<{ mic: number[]; agent: number[] }>({ mic: NO_BANDS, agent: NO_BANDS });
  const cardRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const cmd = (c: PanelCmd) => openliveBridge()?.panelCmd?.(c);

  useEffect(() => {
    openliveBridge()?.onPanelState?.((p: PanelPacket) => {
      if (p.k === "b") { bands.current = { mic: p.mic, agent: p.agent }; return; }
      if (p.k !== "s") return;
      const next = p.s as PanelStateSnapshot;
      setPermission(next.permission);
      if (next.flow) setS(next.flow);
    });
  }, []);

  // The summon: the window already exists and is already transparent, so frame
  // one is an animation and never a resize. Transforms and opacity only.
  useGSAP(() => {
    if (!cardRef.current) return;
    if (prefersReduced()) { gsap.fromTo(cardRef.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.12, ease: "none" }); return; }
    gsap.timeline()
      .fromTo(cardRef.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.base, ease: EASE.out }, 0)
      .fromTo(cardRef.current, { scale: 0.92, y: 10 }, { scale: 1, y: 0, duration: DUR.enter, ease: EASE.snappy }, 0);
  }, { scope: scopeRef, dependencies: [s.phase !== "idle"] });

  // The pill measures itself; the main process keeps the bottom edge put, so it
  // grows upward however long the transcript gets.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    let last = 0;
    const report = () => {
      const h = el.offsetHeight + 20; // the gap the CSS shadow needs around the card
      if (Math.abs(h - last) <= 2) return;
      last = h;
      flowBridge()?.size(h);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { title, detail } = heading(s);
  const failing = !!s.failure && (s.phase === "idle" || s.phase === "error");

  return (
    <div ref={scopeRef} className="fixed inset-0 flex flex-col justify-end [-webkit-app-region:drag]">
      <div ref={cardRef} className="m-2.5 flex flex-col gap-3 rounded-[26px] border border-border bg-surface p-4 shadow-[var(--shadow-pop)]">
        {failing ? (
          <>
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" />
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-label font-medium leading-snug">{s.failure!.title}</span>
                <span className="text-caption leading-relaxed text-muted-foreground">{s.failure!.detail}</span>
              </div>
            </div>
            {s.failure!.actionLabel && (
              <button onClick={() => cmd({ t: "flowFix", code: s.failure!.code })}
                className="self-start rounded-full bg-accent px-4 py-2 text-label font-medium text-white transition hover:opacity-90 [-webkit-app-region:no-drag]">
                {s.failure!.actionLabel}
              </button>
            )}
          </>
        ) : (
          <>
            {s.failure && (
              <span className="flex items-center gap-2 text-caption text-muted-foreground">
                <AlertTriangle className="size-3.5 shrink-0 text-danger" />
                <span className="min-w-0 flex-1 truncate">{s.failure.title}</span>
              </span>
            )}

            <div className="flex items-center gap-3.5">
              <Orb phase={orbPhase(s.phase)} getLevels={() => ({ mic: 0, agent: 0 })} getBands={() => bands.current} size={44} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-label font-medium leading-snug" aria-live="polite">{title}</span>
                {detail && <span className="truncate text-caption leading-snug text-muted-foreground">{detail}</span>}
              </div>
              {s.phase === "idle" && s.binding && (
                <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-card px-2.5 py-1">
                  <span className="size-1.5 rounded-full bg-accent" />
                  <span className="font-mono text-caption text-muted-foreground">{s.binding}</span>
                </span>
              )}
              <button onClick={() => cmd({ t: "flowSpeaker" })} title={quietLabel(s.quiet) || "Speaking out loud"}
                aria-label={s.speaking ? "Stop speaking replies" : "Speak replies"}
                className={cn("grid size-8 shrink-0 place-items-center rounded-full transition hover:bg-foreground/10 [-webkit-app-region:no-drag]",
                  s.speaking ? "text-foreground" : "text-muted-foreground")}>
                {s.speaking ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
              </button>
              {(s.phase === "speaking" || s.phase === "acting" || s.phase === "thinking") && (
                <button onClick={() => cmd({ t: "flowCancel" })} title="Stop" aria-label="Stop"
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-card text-foreground transition hover:bg-foreground/10 [-webkit-app-region:no-drag]">
                  <Square className="size-3.5" />
                </button>
              )}
            </div>

            {permission && <Chips permission={permission} cmd={cmd} />}

            {s.inserting && (
              <div className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
                  <TextCursorInput className="size-3.5 shrink-0" />
                  {s.inserting.text.length} characters
                </span>
                <p className="max-h-40 overflow-hidden rounded-xl bg-card px-3 py-2.5 text-caption leading-relaxed">{s.inserting.text}</p>
              </div>
            )}

            {!s.inserting && s.reply && (s.phase === "speaking" || s.phase === "error") && (
              <p className="max-h-40 overflow-hidden text-label leading-relaxed">{s.reply}</p>
            )}

            {!s.inserting && s.transcript && s.phase === "listening" && (
              <p className={cn("max-h-24 overflow-hidden text-label leading-relaxed", s.partial && "text-muted-foreground")}>{s.transcript}</p>
            )}

            {s.quiet && s.quiet !== "off" && (
              <span className="text-caption text-muted-foreground">{quietLabel(s.quiet)}</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
