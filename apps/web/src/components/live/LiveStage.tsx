"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Video, VideoOff } from "lucide-react";
import type { DeviceOpt } from "@/lib/live/liveStore";
import type { ModelProgress } from "@/lib/live/models";
import { cn } from "@/lib/cn";

// Reusable pre-call building blocks: device pickers, a self-preview + mic meter,
// and the on-device model download. Composed by the full-page Lobby.

const mb = (bytes: number) => (bytes / 1_048_576).toFixed(bytes >= 100 * 1_048_576 ? 0 : 1);
const MODEL_ROLE: Record<string, string> = { stt: "hears you", tts: "speaks back", turn: "knows when you're done" };

// Shared, transparent progress: overall bar + real MB, and a per-model checklist.
export function DownloadProgress({ pct, loaded, total, models }: { pct: number; loaded: number; total: number; models: ModelProgress[] }) {
  return (
    <div className="flex w-72 max-w-[82vw] flex-col gap-2.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
        <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>
      <p className="text-center text-[11px] text-muted-foreground">
        {Math.round(pct * 100)}%{total ? ` · ${mb(loaded)} / ${mb(total)} MB` : ""} · one-time, then instant
      </p>
      {models.length > 0 && (
        <ul className="space-y-1">
          {models.map((m) => {
            const done = m.total > 0 && m.loaded >= m.total;
            return (
              <li key={m.key} className="flex items-center gap-2 text-[11px]">
                <span className={cn("grid size-3.5 shrink-0 place-items-center rounded-full text-[8px]", done ? "bg-accent text-accent-foreground" : "border border-border text-transparent")}>✓</span>
                <span className="text-foreground">{m.name}</span>
                <span className="text-faint">· {MODEL_ROLE[m.key]}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">{m.total ? `${mb(m.loaded)}/${mb(m.total)}` : "…"}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function DeviceSelect({ icon: Icon, opts, value, onChange }: { icon: typeof Mic; opts: DeviceOpt[]; value?: string; onChange: (id: string) => void }) {
  if (!opts.length) return <p className="text-[12px] text-faint">No device found</p>;
  return (
    <label className="flex items-center gap-2 text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      <select value={value ?? opts[0]?.id ?? ""} onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface px-2 py-1.5 text-[12px] text-foreground">
        {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  );
}

// Live camera preview on the pre-call screen. Opens its OWN stream (separate from
// the call) and releases it on unmount.
export function CameraPreview({ camId, onGranted }: { camId?: string; onGranted: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"loading" | "on" | "denied">("loading");
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    setState("loading");
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: camId ? { deviceId: { exact: camId } } : true });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (ref.current) ref.current.srcObject = stream;
        setState("on"); onGranted();
      } catch { if (!stopped) setState("denied"); }
    })();
    return () => { stopped = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [camId, onGranted]);
  return (
    <div className="relative aspect-[4/3] max-h-[42vh] w-full max-w-[22rem] overflow-hidden rounded-2xl border border-border/60 bg-black shadow-lg">
      <video ref={ref} autoPlay muted playsInline className={cn("h-full w-full object-cover transition-opacity", state === "on" ? "opacity-100" : "opacity-0")} />
      {state !== "on" && (
        <div className="absolute inset-0 grid place-items-center gap-1 text-center">
          <VideoOff className="size-6 text-muted-foreground" />
          <p className="text-[11px] text-muted-foreground">{state === "denied" ? "Camera off or blocked" : "Starting camera…"}</p>
        </div>
      )}
    </div>
  );
}

// Live mic level on the pre-call screen (own stream, released on unmount).
export function MicMeter({ micId, onGranted }: { micId?: string; onGranted: () => void }) {
  const [level, setLevel] = useState(0);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    let stream: MediaStream | null = null, ctx: AudioContext | null = null, raf = 0, stopped = false;
    setDenied(false);
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: micId ? { deviceId: { exact: micId } } : true });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        onGranted();
        ctx = new AudioContext();
        void ctx.resume().catch(() => {});
        if (ctx.state === "suspended") {
          const c = ctx;
          window.addEventListener("pointerdown", () => void c.resume().catch(() => {}), { once: true });
        }
        const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const loop = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
          setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3.5));
          raf = requestAnimationFrame(loop);
        };
        loop();
      } catch { if (!stopped) setDenied(true); }
    })();
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); ctx?.close().catch(() => {}); };
  }, [micId, onGranted]);
  return (
    <div className="flex w-full max-w-[18rem] items-center gap-2">
      <Mic className={cn("size-3.5 shrink-0", denied ? "text-danger" : "text-muted-foreground")} />
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
        <div className="h-full rounded-full bg-success transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
      </div>
      {denied && <span className="text-[10px] text-danger">mic blocked</span>}
    </div>
  );
}
