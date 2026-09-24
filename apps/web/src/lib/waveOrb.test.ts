import { describe, expect, it } from "vitest";
import { advancePhase, glassBody, lin, MARK_POSE, micGate, mixFrame, srgb, TARGETS, transitionTo, voiceBands, WAVE_ORB_RADIUS, WAVE_ORB_STATES } from "./waveOrb";

describe("wave orb colour", () => {
  it("round-trips sRGB through linear light", () => {
    for (let v = 0; v <= 1; v += 0.05) expect(srgb(lin(v))).toBeCloseTo(v, 9);
  });

  it("mixes in linear light, so black to white passes a bright middle, not sRGB grey", () => {
    const black = { n: [], c: [0, 0, 0] }, white = { n: [], c: [1, 1, 1] };
    expect(srgb(mixFrame(black, white, 0.5).c[0]!)).toBeCloseTo(0.7354, 3);
  });

  it("has six colours and every parameter for each state", () => {
    for (const name of Object.keys(WAVE_ORB_STATES) as (keyof typeof WAVE_ORB_STATES)[]) {
      expect(TARGETS[name].c).toHaveLength(18);
      expect(TARGETS[name].n.every(Number.isFinite)).toBe(true);
    }
  });

  it("tints the glass body deep in the state's own hue, lit toward the upper-left", () => {
    const body = (name: keyof typeof WAVE_ORB_STATES, lift = 1) => glassBody(TARGETS[name].c.map(srgb), lift);
    for (const name of Object.keys(WAVE_ORB_STATES) as (keyof typeof WAVE_ORB_STATES)[]) {
      const lit = body(name), shadow = body(name, 0);
      // Deep, so the threads keep their contrast, yet never the old near-black.
      expect(Math.max(...lit)).toBeLessThan(0.4);
      expect(Math.max(...lit)).toBeGreaterThan(0.1);
      lit.forEach((v, k) => expect(v).toBeGreaterThan(shadow[k]!));
    }
    const [r, g, b] = body("listening");
    expect(g).toBeGreaterThan(r! * 2);
    expect(b).toBeGreaterThan(r! * 2);
    const [tr, tg, tb] = body("thinking");
    expect(tb).toBeGreaterThan(tg!);
    expect(tr).toBeGreaterThan(tg!);
  });
});

describe("wave orb transitions", () => {
  it("snaps into working states and settles into the rest", () => {
    const into = transitionTo("speaking", false), out = transitionTo("idle", false);
    expect(into.dur).toBe(360);
    expect(into.ease(0.5)).toBeCloseTo(0.875);
    expect(out.dur).toBe(650);
    expect(out.ease(0.5)).toBeCloseTo(0.5);
    expect(transitionTo("speaking", true).dur).toBe(300);
  });

  it("starts an interrupted transition from what is on screen", () => {
    const shown = mixFrame(TARGETS.idle, TARGETS.thinking, 0.4);
    const next = mixFrame(shown, TARGETS.error, 0);
    expect(next).toEqual(shown);
    mixFrame(shown, TARGETS.error, 1).n.forEach((v, i) => expect(v).toBeCloseTo(TARGETS.error.n[i]!, 12));
  });
});

describe("the mark", () => {
  it("is the speaking palette held still, breathing, deaf to audio", () => {
    const { mark, speaking } = WAVE_ORB_STATES;
    expect(mark.colors).toEqual(speaking.colors);
    expect(mark.speed).toBe(0);
    expect(mark.breathe).toBeGreaterThan(0);
    expect("audio" in mark).toBe(false);
  });

  it("holds the logo's pose, since no speed means no phase advance", () => {
    const w = [...MARK_POSE];
    expect(w).toHaveLength(11);
    advancePhase(w, 0);
    expect(w).toEqual(MARK_POSE);
  });

  it("glides into any other state rather than snapping", () => {
    expect(transitionTo("idle", false).dur).toBe(650);
    const half = mixFrame(TARGETS.mark, TARGETS.idle, 0.5);
    half.n.forEach((v, i) => expect(v).toBeCloseTo((TARGETS.mark.n[i]! + TARGETS.idle.n[i]!) / 2, 12));
  });
});

describe("voiceBands", () => {
  it("folds five octave bands into low, mid, high and an overall level", () => {
    expect(voiceBands([0.2, 0.4, 0.5, 0.6, 0.8], 0)).toEqual({ low: expect.closeTo(0.3), mid: 0.5, high: expect.closeTo(0.7), all: expect.closeTo(0.5) });
  });

  it("lets a louder level meter lift the overall level", () => {
    expect(voiceBands([0.1, 0.1, 0.1, 0.1, 0.1], 0.9).all).toBe(0.9);
  });

  it("drives every band from the level when there is no spectrum", () => {
    expect(voiceBands(undefined, 0.4)).toEqual({ low: 0.4, mid: 0.4, high: 0.4, all: 0.4 });
    expect(voiceBands([], 0)).toEqual({ low: 0, mid: 0, high: 0, all: 0 });
  });

  it("treats missing bands as silence", () => {
    expect(voiceBands([1], 0)).toEqual({ low: 0.5, mid: 0, high: 0, all: 0.2 });
  });
});

describe("advancePhase", () => {
  const RATES = [0.37, 0.51, 0.73, 2.4, 1.9, 1.3, 3.2, 0.62, 0.41, 0.23];

  it("stays bounded and matches the unwrapped wave after days of running", () => {
    const w = new Array(11).fill(0);
    let phase = 0;
    const step = 1.35 / 60; // thinking speed at 60 fps
    for (let i = 0; i < 3 * 24 * 3600 * 60; i += 997) {
      advancePhase(w, step * 997);
      phase += step * 997;
    }
    RATES.forEach((r, i) => {
      expect(w[i]).toBeGreaterThanOrEqual(0);
      expect(w[i]).toBeLessThan(2 * Math.PI);
      expect(Math.sin(w[i])).toBeCloseTo(Math.sin(phase * r), 6);
      expect(Math.cos(w[i])).toBeCloseTo(Math.cos(phase * r), 6);
    });
    expect(w[10]).toBeCloseTo((phase * 0.35) % 1, 6);
  });

  it("never jumps across a wrap", () => {
    const w = new Array(11).fill(0);
    w[3] = 2 * Math.PI - 1e-4;
    const before = Math.sin(w[3]);
    advancePhase(w, 1e-3);
    expect(w[3]).toBeLessThan(0.01);
    expect(Math.abs(Math.sin(w[3]) - before)).toBeLessThan(0.01);
  });
});

describe("WAVE_ORB_RADIUS", () => {
  it("leaves room for the brightest glow, off the widest contour, to fade out before the canvas edge", () => {
    const glow = Math.max(...Object.values(WAVE_ORB_STATES).map((s) => ("edgeGlow" in s ? s.edgeGlow : 0)));
    const edge = 1 / WAVE_ORB_RADIUS - 1.09; // ball radii past the widest contour
    expect(glow * Math.exp(-edge * 8.8) * 255).toBeLessThanOrEqual(1);
    expect(WAVE_ORB_RADIUS).toBeGreaterThan(0.5);
  });
});

describe("micGate", () => {
  const room = [0.62, 0.55, 0.3, 0.1, 0.01];
  const settle = (gate: ReturnType<typeof micGate>, secs: number) => {
    let out: number[] = [];
    for (let t = 0; t < secs; t += 1 / 60) out = gate(room.map((v) => v + 0.02 * Math.sin(t * 13)), 1 / 60);
    return out;
  };

  it("reads a quiet room as silence, even one the mic opened on ramping up", () => {
    const gate = micGate();
    gate([0, 0, 0, 0, 0], 1 / 60);
    gate([0.45, 0.09, 0, 0, 0], 1 / 60);
    expect(Math.max(...settle(gate, 2))).toBe(0);
  });

  it("lifts speech above the room to most of full scale", () => {
    const gate = micGate();
    settle(gate, 2);
    const speech = gate(room.map((v) => v + 0.3), 1 / 60);
    expect(voiceBands(speech, 0).all).toBeGreaterThan(0.6);
  });

  it("still hears the end of a long sentence", () => {
    const gate = micGate();
    settle(gate, 2);
    let out: number[] = [];
    for (let t = 0; t < 1.5; t += 1 / 60) out = gate(room.map((v) => v + 0.3), 1 / 60);
    expect(voiceBands(out, 0).all).toBeGreaterThan(0.3);
  });

  it("gives an analyser that has not filled yet as silence", () => {
    expect(micGate()([0, 0, 0, 0, 0], 1 / 60)).toEqual([0, 0, 0, 0, 0]);
  });
});
