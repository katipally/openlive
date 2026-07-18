"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/cn";

// Compact seekable player — the one way Clone Voice plays anything back
// (recorded take, synthesized preview, original profile recording).
// Play/pause · draggable seek · elapsed/total time. Native <audio> under the
// hood so seeking, duration and keyboard arrows on the range come for free.

/** Only one bar plays at a time — starting one pauses whichever was playing. */
let nowPlaying: HTMLAudioElement | null = null;

const fmt = (s: number) => {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s - m * 60)).padStart(2, "0")}`;
};

export function AudioBar({ src, autoPlay, className }: { src: string; autoPlay?: boolean; className?: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);

  useEffect(() => {
    const a = new Audio(src);
    audio.current = a;
    setPlaying(false); setTime(0); setDur(0);
    const onMeta = () => setDur(a.duration);
    const onTime = () => setTime(a.currentTime);
    const onPlay = () => {
      if (nowPlaying && nowPlaying !== a) nowPlaying.pause();
      nowPlaying = a;
      setPlaying(true);
    };
    const onPause = () => setPlaying(false);
    const onEnd = () => { a.currentTime = 0; setTime(0); };
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnd);
    if (autoPlay) void a.play().catch(() => {});
    return () => {
      a.pause();
      if (nowPlaying === a) nowPlaying = null;
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnd);
      a.src = "";
    };
  }, [src, autoPlay]);

  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (playing) a.pause(); else void a.play().catch(() => {});
  };
  const seek = (v: number) => {
    const a = audio.current;
    if (!a || !isFinite(dur) || dur <= 0) return;
    a.currentTime = v;
    setTime(v);
  };

  return (
    <div className={cn("flex h-9 items-center gap-2.5 rounded-lg bg-surface px-2.5", className)}>
      <button onClick={toggle} title={playing ? "Pause" : "Play"} aria-label={playing ? "Pause" : "Play"}
        className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground text-background transition hover:opacity-90">
        {playing ? <Pause className="size-3 fill-current" /> : <Play className="size-3 translate-x-px fill-current" />}
      </button>
      <input type="range" aria-label="Seek" min={0} max={dur || 0} step={0.01} value={Math.min(time, dur || 0)}
        onChange={(e) => seek(Number(e.target.value))}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-border accent-foreground" />
      <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground">{fmt(time)} / {fmt(dur)}</span>
    </div>
  );
}
