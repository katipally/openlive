"use client";

import { useEffect, useRef } from "react";
import { createWaveOrb, micGate, voiceBands, WAVE_ORB_RADIUS, type WaveOrb, type WaveOrbState } from "@/lib/waveOrb";

// The OpenLive mark: a glass orb with a spectral wave inside (lib/waveOrb). ONE
// component everywhere: the live in-call and Flow orbs, the breathing home mark
// (`pulse`), and small static marks, which draw one frame and then cost nothing.
// Without a phase it is the logo (the `mark` state).
//
// Each state reads by colour and motion: listening rides YOUR mic, speaking
// rides the AGENT's voice, and only those two read audio at all.
export function OpenLiveOrb({ phase = "mark", getLevels, getBands, size = 240, pulse = false }: {
  phase?: WaveOrbState;
  getLevels?: () => { mic: number; agent: number };
  getBands?: () => { mic: number[]; agent: number[] }; // per-octave-band energy → real spectrum
  size?: number;
  pulse?: boolean; // idle breathing for the static marks (no getLevels)
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const orb = useRef<WaveOrb | null>(null);
  const audio = useRef({ getLevels, getBands });
  audio.current = { getLevels, getBands };
  const animated = !!getLevels || pulse;
  const voice = phase === "listening" || phase === "speaking";

  useEffect(() => {
    const o = createWaveOrb(canvas.current!, { state: phase, still: !animated });
    orb.current = o;
    return () => { o.destroy(); orb.current = null; };
    // The live phase is applied by the effect below; recreating on it would restart the wave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animated]);

  useEffect(() => { orb.current?.setState(phase); }, [phase]);

  useEffect(() => {
    if (!voice || !animated) return;
    const listening = phase === "listening";
    const gate = micGate();
    let raf = 0, last = 0;
    const read = (now: number) => {
      const { getLevels: levels, getBands: bands } = audio.current;
      const l = levels?.();
      // Level meters sit far below 1 even for a loud voice; these bring speech to full scale.
      const level = l ? (listening ? l.mic * 5 : l.agent * 6) : 0;
      const b = bands?.();
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      // The mic's raw level carries the room, which the gate takes out of its
      // bands, so with bands to read it would undo the gate.
      orb.current?.setBands(voiceBands(b && (listening ? gate(b.mic, dt) : b.agent), listening && b ? 0 : level));
      raf = requestAnimationFrame(read);
    };
    raf = requestAnimationFrame(read);
    return () => { cancelAnimationFrame(raf); orb.current?.setBands({}); };
  }, [voice, animated, phase]);

  // The canvas is wider than the ball to leave room for its glow; the negative
  // margin keeps the layout footprint at exactly `size`.
  const box = size / WAVE_ORB_RADIUS;
  return (
    <canvas ref={canvas} aria-hidden
      style={{ display: "block", width: box, height: box, margin: (size - box) / 2, pointerEvents: "none", flexShrink: 0 }} />
  );
}
