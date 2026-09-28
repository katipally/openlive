"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

// The Glass/Flat look. The desktop shell decides what can run and what the
// window wears (it owns the OS material); this side tags <html data-look>,
// plays the switch, reports the theme and the choice back, and times glass
// once so a machine that draws it slowly gets Flat. In a plain browser there
// is no desktop behind the page, so the look is always Flat.

export type Look = "glass" | "flat";
export type GlassReason = "reduce-transparency" | "no-gpu" | "unsupported-os" | "slow";
export interface Appearance {
  saved: Look | null;
  look: Look;
  support: { supported: boolean; reason: GlassReason | null };
  probe: boolean;
}

type Bridge = {
  get: () => Appearance;
  set: (patch: { look?: Look; theme?: string; slow?: boolean }) => Promise<Appearance>;
  onChange: (cb: (a: Appearance) => void) => () => void;
};
const bridge = (): Bridge | undefined =>
  typeof window !== "undefined" ? (window as unknown as { openlive?: { appearance?: Bridge } }).openlive?.appearance : undefined;

export const GLASS_REASON: Record<GlassReason, string> = {
  "reduce-transparency": "Glass is off because Reduce transparency is on. Turn it off in System Settings, Accessibility, Display. On Windows: Transparency effects.",
  "no-gpu": "Glass needs graphics acceleration. It is off or unavailable on this computer, so OpenLive uses Flat.",
  "unsupported-os": "Glass needs macOS or Windows 11. On Linux and Windows 10, OpenLive uses Flat.",
  slow: "Glass was turned off because this computer drew it slowly. Flat keeps calls smooth.",
};

/** One frame in twenty slower than 30 fps. A GPU that keeps up has its p95 at
 *  the display's own interval (8 to 17 ms); one that can't blur in time sits
 *  well past this. */
export const SLOW_P95_MS = 34;
const PROBE_MS = 1000;
// After launch settles: hydration and the voice model warm-up are not glass.
const PROBE_DELAY_MS = 2500;

export function p95(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

/** No samples is no evidence, never a verdict of slow. */
export const slowFrames = (intervals: readonly number[]): boolean => p95(intervals) > SLOW_P95_MS;

/** Frame intervals over `ms`, or null when the window was hidden for any of it
 *  (rAF stops while hidden, which says nothing about the GPU). */
function sampleFrames(ms: number): Promise<number[] | null> {
  return new Promise((resolve) => {
    const out: number[] = [];
    let last = 0;
    const start = performance.now();
    const tick = (t: number) => {
      if (document.hidden) return resolve(null);
      if (last) out.push(t - last);
      last = t;
      if (t - start < ms) requestAnimationFrame(tick);
      else resolve(out);
    };
    requestAnimationFrame(tick);
  });
}

/** Swap the look with one cross-fade of the whole window (globals.css
 *  `look-switching`). The shell has already put the material under the page
 *  going to glass, and keeps it until the fade is done going to flat. */
let target: Look | null = null;
function applyLook(next: Look) {
  const root = document.documentElement;
  // The shell answers one switch twice (the reply and its broadcast), both
  // before the transition's update runs, so compare with where it is going.
  // Starting a second transition would skip the first.
  if ((target ?? root.dataset.look ?? "flat") === next) return;
  target = next;
  const set = () => { root.dataset.look = next; };
  if (!document.startViewTransition || document.hidden) return set();
  root.classList.add("look-switching");
  const transition = document.startViewTransition(set);
  // A quicker switch back skips this one, which rejects `ready`: expected, not an error.
  transition.ready.catch(() => {});
  void transition.finished.finally(() => root.classList.remove("look-switching"));
}

let current: Appearance | null = null;
const listeners = new Set<() => void>();
function publish(a: Appearance) {
  current = a;
  applyLook(a.look);
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The shell's current answer, or null outside the desktop app. */
export const useAppearance = () => useSyncExternalStore(subscribe, () => current, () => null);

export function setLook(look: Look) {
  void bridge()?.set({ look }).then(publish);
}

let probing = false;
async function probe() {
  if (probing) return;
  probing = true;
  try {
    await new Promise((r) => setTimeout(r, PROBE_DELAY_MS));
    while (document.hidden) await new Promise((r) => document.addEventListener("visibilitychange", r, { once: true }));
    const frames = await sampleFrames(PROBE_MS);
    if (frames && current?.probe) publish(await bridge()!.set({ slow: slowFrames(frames) }));
  } finally {
    probing = false;
  }
}

/** Mounted once per page: follows the shell, reports the theme, runs the probe. */
export function useAppearanceSync() {
  const { theme } = useTheme();
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    const take = (a: Appearance) => { publish(a); if (a.probe) void probe(); };
    take(b.get());
    return b.onChange(take);
  }, []);
  useEffect(() => {
    if (theme) void bridge()?.set({ theme });
  }, [theme]);
}
