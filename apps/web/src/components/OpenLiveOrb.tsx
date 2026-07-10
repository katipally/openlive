"use client";

import { useEffect, useId, useRef } from "react";
import type { LivePhase } from "@/lib/live/liveStore";

// The OpenLive mark: a lit orb with a five-bar waveform CARVED into it. Each bar is
// a clean recessed well (deep fill + a hairline rim), no glossy catch-light, no
// extra shading blobs on the orb — the disc's own radial gradient gives it volume.
// ONE component for every place the mark appears: the animated in-call orb, the home
// hero + top-bar logo (idle pulse), and a static favicon.
//
// Live states (animated by getLevels):
//   idle       → flatline (bars collapse to a still line)
//   listening  → rises from the flatline with YOUR mic level
//   thinking/… → a traveling "working" ripple (not audio-driven)
//   speaking   → rises with the AGENT's voice level
// Every bar eases toward its target each frame, so states cross-fade smoothly.
const BARS = [0.5, 0.78, 1, 0.78, 0.5];
const BAR_W = 6.4, GAP = 5.6, MAX_H = 62, FLAT = 6, CY = 50;
const SPAN = MAX_H - FLAT;
const START_X = (100 - (BARS.length * BAR_W + (BARS.length - 1) * GAP)) / 2;
const restH = (i: number) => FLAT + BARS[i]! * SPAN * 0.62;
const BUSY = new Set(["thinking", "connecting", "loading", "reconnecting"]);

type Palette = { hi: string; mid: string; lo: string; ring: string; glow: string };
// Per-phase so the mark itself signals state: green hearing you, blue speaking,
// amber working, calm neutral idle.
function paletteFor(phase: LivePhase): Palette {
  switch (phase) {
    case "listening": return { hi: "#d8f9e6", mid: "#43c286", lo: "#1f6f47", ring: "#4ade80", glow: "#43c286" };
    case "speaking": return { hi: "#d9e4ff", mid: "#6f8ce6", lo: "#3a4fb0", ring: "#8ba3f5", glow: "#6f8ce6" };
    case "thinking": case "connecting": case "loading": case "reconnecting":
      return { hi: "#ffe7c4", mid: "#f0a24a", lo: "#b5651c", ring: "#f2a24a", glow: "#f0a24a" };
    default: return { hi: "#cfe0ff", mid: "#8098c8", lo: "#5a6ea0", ring: "#8ca0e6", glow: "#7f93c8" };
  }
}

export function OpenLiveOrb({ phase = "idle", getLevels, size = 240, pulse = false }: {
  phase?: LivePhase;
  getLevels?: () => { mic: number; agent: number };
  size?: number;
  pulse?: boolean; // idle breathing for the static marks (no getLevels)
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const rects = useRef<(SVGRectElement | null)[]>([]);
  const heights = useRef<number[]>(BARS.map((_, i) => restH(i)));
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const p = paletteFor(phase);

  useEffect(() => {
    if (!getLevels) return;
    const reduce = matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const hs = heights.current;
    let raf = 0, t0 = 0;
    const loop = (ms: number) => {
      if (!t0) t0 = ms;
      const time = (ms - t0) / 1000;
      const ph = phaseRef.current;
      const { mic, agent } = getLevels();
      const isBusy = BUSY.has(ph);
      for (let i = 0; i < rects.current.length; i++) {
        let target: number;
        if (ph === "listening") {
          target = FLAT + BARS[i]! * SPAN * Math.min(1, mic * 4);          // rise from flatline with your voice
        } else if (ph === "speaking") {
          const lv = Math.min(1, agent * 5);
          const life = 0.14 + 0.86 * lv;                                   // keep a little motion between words
          const shim = 0.85 + 0.15 * Math.sin(time * 9 + i * 0.9);
          target = FLAT + BARS[i]! * SPAN * life * shim;
        } else if (isBusy) {
          const w = 0.5 + 0.5 * Math.sin(time * 4.5 - i * 1.05);           // traveling "working" ripple
          target = FLAT + 3 + BARS[i]! * SPAN * 0.5 * w;
        } else {
          target = FLAT;                                                    // idle → flatline
        }
        if (reduce) target = isBusy ? FLAT + BARS[i]! * SPAN * 0.3 : FLAT;
        const h = hs[i]! + (target - hs[i]!) * 0.2;                         // ease → smooth state transitions
        hs[i] = h;
        const el = rects.current[i];
        if (el) { el.setAttribute("height", String(h)); el.setAttribute("y", String(CY - h / 2)); }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [getLevels]);

  const barCls = pulse ? `olw-${uid}` : undefined;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden
      style={{ filter: `drop-shadow(0 0 ${Math.round(size * 0.045)}px ${p.glow})`, display: "block" }}>
      <defs>
        <radialGradient id={`disc-${uid}`} cx="38%" cy="30%" r="80%">
          <stop offset="0%" stopColor={p.hi} />
          <stop offset="52%" stopColor={p.mid} />
          <stop offset="100%" stopColor={p.lo} />
        </radialGradient>
        {/* deep, quiet well — a touch of light at the top rim, dark body. No glossy
            bottom highlight (that read as a reflection). objectBoundingBox spans each
            bar so the shading tracks it as it grows. */}
        <linearGradient id={`well-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#111f38" stopOpacity="0.97" />
          <stop offset="100%" stopColor="#04060c" stopOpacity="0.97" />
        </linearGradient>
      </defs>
      {pulse && (
        <style>{`@keyframes olwk-${uid}{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.5)}}` +
          `.olw-${uid}{transform-box:fill-box;transform-origin:center;animation:olwk-${uid} 1.6s ease-in-out infinite}`}</style>
      )}
      <circle cx="50" cy="50" r="47" fill={`url(#disc-${uid})`} />
      <circle cx="50" cy="50" r="47" fill="none" stroke={p.ring} strokeOpacity="0.5" strokeWidth="1.3" />
      {BARS.map((_, i) => {
        const h = heights.current[i]!;
        return (
          <rect key={i} ref={(el) => { rects.current[i] = el; }} className={barCls}
            x={START_X + i * (BAR_W + GAP)} y={CY - h / 2} width={BAR_W} height={h}
            rx={BAR_W / 2} fill={`url(#well-${uid})`} stroke="#ffffff" strokeOpacity="0.12" strokeWidth="0.5"
            style={pulse ? { animationDelay: `${i * 0.12}s` } : undefined} />
        );
      })}
    </svg>
  );
}
