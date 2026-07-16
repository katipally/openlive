"use client";

import { useEffect } from "react";
import { useLiveStore } from "./liveStore";
import { openliveBridge } from "./panelBridge";

const isTyping = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
};

/** In-app Space behavior (Settings → General): "hold" = press-and-hold to talk;
 *  "toggle" = tap to start, tap to stop. */
export type VoiceInputMode = "hold" | "toggle";
const MODE_KEY = "openlive-voice-input";
export function voiceInputMode(): VoiceInputMode {
  try { return localStorage.getItem(MODE_KEY) === "toggle" ? "toggle" : "hold"; } catch { return "hold"; }
}
export function setVoiceInputMode(m: VoiceInputMode): void {
  try { localStorage.setItem(MODE_KEY, m); } catch { /* private mode */ }
}

/** Push-to-talk + send-now keys for an active call:
 *  Space = talk (hold or toggle per the General setting);
 *  Enter = commit a held mid-thought pause immediately.
 *  In the desktop mini pill, the global hotkey arrives as a TOGGLE (Electron's
 *  globalShortcut has no keyup) via openlive:ptt-toggle. */
export function usePtt(active: boolean, { pttDown, pttUp, sendNow }: { pttDown: () => void; pttUp: () => void; sendNow: () => void }) {
  useEffect(() => {
    if (!active) return;
    const down = (e: KeyboardEvent) => {
      if (isTyping()) return;
      if (e.code === "Space" && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (voiceInputMode() === "toggle") { if (useLiveStore.getState().pttActive) pttUp(); else pttDown(); }
        else pttDown();
      }
      else if (e.key === "Enter" && useLiveStore.getState().holdUntil) { e.preventDefault(); sendNow(); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && voiceInputMode() === "hold" && useLiveStore.getState().pttActive) { e.preventDefault(); pttUp(); }
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
