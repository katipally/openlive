"use client";

import { useSyncExternalStore } from "react";
import { focusManager, type Query, type QueryClient } from "@tanstack/react-query";

// The desktop window runs with backgroundThrottling off so a call keeps going
// while it is hidden, and that also leaves the page reading itself as visible
// forever. Main says when the window is hidden or minimised instead, and polls
// that only feed what is on screen wait until it is back. Every other window,
// and the browser build, never hears from main and counts as shown.

let shown = true;
const subs = new Set<() => void>();

export const windowShown = () => shown;

/** An interval that is live for this query right now. */
const polling = (q: Query) => q.observers.some((o) => {
  const every = o.options.refetchInterval;
  return !!(typeof every === "function" ? every(q) : every);
});

/** Follows main's word on the window. `subscribe` is the preload's
 *  `onWindowShown`. Returns the way to stop. */
export function watchWindowShown(qc: QueryClient, subscribe?: (cb: (shown: boolean) => void) => () => void): () => void {
  if (!subscribe) return () => {};
  const set = (next: boolean) => {
    if (next === shown) return;
    shown = next;
    // React Query skips an interval's tick, and holds a retry, while unfocused.
    focusManager.setFocused(next);
    // A poll that slept through the hidden time catches up at once, not one interval later.
    if (next) void qc.refetchQueries({ type: "active", predicate: polling });
    for (const f of subs) f();
  };
  const stop = subscribe(set);
  return () => { stop(); set(true); };
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => { subs.delete(f); };
};

/** Whether the window is up, for a hand-rolled poll to pause on. */
export const useWindowShown = () => useSyncExternalStore(subscribe, windowShown, () => true);
