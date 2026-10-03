"use client";

import { useEffect } from "react";
import type { TalkMode } from "@openlive/flow-store";
import { useLiveStore } from "./liveStore";
import { isControlTarget, isTextTarget } from "./keyTargets";
import { openliveBridge } from "./panelBridge";

export interface PttHandlers {
  pttDown: () => void;
  pttUp: () => void;
  pttCancel: () => void;
}

/**
 * The global push-to-talk key in a live call, as main routes it here while
 * Flow and Dictate are closed (`onPtt`, absent outside the desktop app). A
 * press starts a hold only in push to talk; a release or a cancel always ends
 * one, so a hold the mode changed under still finishes. Returns the unsubscribe.
 */
export function listenPtt(onPtt: ((cb: (kind: string) => void) => () => void) | undefined, mode: () => TalkMode, h: PttHandlers): () => void {
  if (!onPtt) return () => {};
  return onPtt((kind) => {
    if (kind === "hold_start") { if (mode() === "ptt") h.pttDown(); }
    else if (kind === "hold_end") h.pttUp();
    else if (kind === "hold_cancel") h.pttCancel();
  });
}

/** A live call's keys: the global push-to-talk key, and Enter to send a held pause now. */
export function usePtt(active: boolean, { pttDown, pttUp, pttCancel, sendNow }: PttHandlers & { sendNow: () => void }) {
  useEffect(() => {
    if (!active) return;
    const off = listenPtt(openliveBridge()?.onPtt, () => useLiveStore.getState().talk.mode, { pttDown, pttUp, pttCancel });
    const down = (e: KeyboardEvent) => {
      // A keyboard-focused button or switch owns Enter. A mouse click also
      // focuses the button it hit, and that one should not swallow it.
      const el = document.activeElement as HTMLElement | null;
      if (isTextTarget(el) || (isControlTarget(el) && el?.matches(":focus-visible"))) return;
      if (e.key === "Enter" && useLiveStore.getState().holdUntil) { e.preventDefault(); sendNow(); }
    };
    window.addEventListener("keydown", down);
    return () => { off(); window.removeEventListener("keydown", down); };
  }, [active, pttDown, pttUp, pttCancel, sendNow]);
}
