"use client";

import { useEffect } from "react";
import { useLiveStore } from "./liveStore";
import { openliveBridge } from "./panelBridge";

const isTyping = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
};

/** Push-to-talk + send-now keys for an active call:
 *  hold Space = talk (release sends the turn, auto end-of-turn suspended);
 *  Enter = commit a held mid-thought pause immediately.
 *  In the desktop mini pill, the global hotkey arrives as a TOGGLE (Electron's
 *  globalShortcut has no keyup) via openlive:ptt-toggle. */
export function usePtt(active: boolean, { pttDown, pttUp, sendNow }: { pttDown: () => void; pttUp: () => void; sendNow: () => void }) {
  useEffect(() => {
    if (!active) return;
    const down = (e: KeyboardEvent) => {
      if (isTyping()) return;
      if (e.code === "Space" && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); pttDown(); }
      else if (e.key === "Enter" && useLiveStore.getState().holdUntil) { e.preventDefault(); sendNow(); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && useLiveStore.getState().pttActive) { e.preventDefault(); pttUp(); }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [active, pttDown, pttUp, sendNow]);

  // Desktop global hotkey (mini mode): each press toggles talk on/off.
  useEffect(() => {
    if (!active || !openliveBridge()?.onPttToggle) return;
    // preload's ipcRenderer.on has no matching off-API exposed; guard staleness by
    // checking the CURRENT store state each fire instead of unsubscribing.
    openliveBridge()!.onPttToggle!(() => {
      const s = useLiveStore.getState();
      if (!s.active) return;
      if (s.pttActive) pttUp(); else pttDown();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
