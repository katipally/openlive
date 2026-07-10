"use client";

import { motion } from "motion/react";

// The OpenLive mark. A live-voice waveform that breathes, drawn in code (no stock
// icon) so it reads as ours and feels alive on the home screen. The five bars form
// a symmetric wave and pulse on a staggered loop.
const BARS = [0.42, 0.68, 1, 0.68, 0.42];

export function OpenLiveMark({ size = 72 }: { size?: number }) {
  return (
    <div
      className="relative grid place-items-center rounded-[26%] shadow-xl ring-1 ring-white/10"
      style={{
        width: size,
        height: size,
        background: "radial-gradient(130% 120% at 50% 8%, var(--accent-soft), color-mix(in oklab, var(--accent) 8%, #0a0d14))",
      }}
    >
      {/* soft glow behind the bars */}
      <div className="absolute inset-0 rounded-[26%] opacity-60 blur-md"
        style={{ background: "radial-gradient(50% 50% at 50% 55%, var(--accent-soft), transparent)" }} />
      <div className="relative flex items-center" style={{ height: size * 0.44, gap: size * 0.055 }}>
        {BARS.map((h, i) => (
          <motion.span
            key={i}
            className="rounded-full bg-accent"
            style={{ width: size * 0.058, height: `${h * 100}%` }}
            animate={{ scaleY: [1, 0.5, 1.18, 1], opacity: [0.9, 1, 0.7, 0.9] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: i * 0.11 }}
          />
        ))}
      </div>
    </div>
  );
}
