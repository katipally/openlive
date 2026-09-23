"use client";

import { useEffect } from "react";
import { useLiveStore } from "./liveStore";
import { isControlTarget, isTextTarget } from "./keyTargets";


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

/** Arm/disarm push-to-talk (the in-call toggle next to the mic). OFF by default —
 *  hands-free VAD listening is the normal mode; Space only drives talking once
 *  the user opts in. Persisted across calls. */
export function setPttEnabled(on: boolean): void {
  useLiveStore.getState().set({ pttEnabled: on });
  try { localStorage.setItem("openlive-ptt-enabled", on ? "1" : ""); } catch { /* private mode */ }
  // Disarming mid-hold is the caller's job (it has the session's pttUp) — the
  // engine owns the held-audio state, not this store flag.
}

/** Push-to-talk + send-now keys for an active call (only while push-to-talk is
 *  ARMED via the in-call toggle):
 *  Space = talk (hold or tap-to-toggle per the General setting);
 *  Enter = commit a held mid-thought pause immediately. */
export function usePtt(active: boolean, { pttDown, pttUp, sendNow }: { pttDown: () => void; pttUp: () => void; sendNow: () => void }) {
  useEffect(() => {
    if (!active) return;
    const down = (e: KeyboardEvent) => {
      // A keyboard-focused button or switch owns Space/Enter. A mouse click also
      // focuses the button it hit, and that one should not swallow push-to-talk.
      const el = document.activeElement as HTMLElement | null;
      if (isTextTarget(el) || (isControlTarget(el) && el?.matches(":focus-visible"))) return;
      if (e.code === "Space" && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!useLiveStore.getState().pttEnabled) return; // PTT not armed — Space stays a normal key
        e.preventDefault();
        if (voiceInputMode() === "toggle") { if (useLiveStore.getState().pttActive) pttUp(); else pttDown(); }
        else pttDown();
      }
      else if (e.key === "Enter" && useLiveStore.getState().holdUntil) { e.preventDefault(); sendNow(); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && voiceInputMode() === "hold" && useLiveStore.getState().pttActive) { e.preventDefault(); pttUp(); }
    };
    // A hold whose keyup lands in another app never arrives; let go when focus leaves.
    const release = () => { if (voiceInputMode() === "hold" && useLiveStore.getState().pttActive) pttUp(); };
    const onVisibility = () => { if (document.hidden) release(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", down); window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release); document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, pttDown, pttUp, sendNow]);
}
