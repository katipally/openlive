"use client";

import { useSyncExternalStore } from "react";

// The desktop app's UI scale. The shell owns it (the zoom shortcuts and the
// View menu move it too) and says which steps it has; this side shows it and
// asks for one. In a plain browser there is no bridge, and the browser's own
// zoom does the job.

export interface Zoom {
  /** 1 is 100%. Always one of `steps`. */
  factor: number;
  steps: readonly number[];
}

type Bridge = {
  get: () => Zoom;
  set: (factor: number) => Promise<Zoom>;
  onChange: (cb: (z: Zoom) => void) => () => void;
};
const bridge = (): Bridge | undefined =>
  typeof window !== "undefined" ? (window as unknown as { openlive?: { zoom?: Bridge } }).openlive?.zoom : undefined;

export const zoomLabel = (factor: number) => `${Math.round(factor * 100)}%`;

// Read once, on first use, then kept by the shell's broadcasts for the page's life.
let current: Zoom | null | undefined;
const listeners = new Set<() => void>();
function publish(z: Zoom) {
  current = z;
  listeners.forEach((l) => l());
}
function read() {
  if (current === undefined) {
    const b = bridge();
    current = b?.get() ?? null;
    b?.onChange(publish);
  }
  return current;
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The shell's current scale, or null outside the desktop app. */
export const useZoom = () => useSyncExternalStore(subscribe, read, () => null);

export function setZoom(factor: number) {
  void bridge()?.set(factor).then(publish);
}
