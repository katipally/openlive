"use client";

import { useCallback, useEffect, useRef } from "react";

/** Follows one pointer drag on window until release, cancel, or unmount, so a
 *  tile closed mid-drag never leaves listeners behind. Returns `start(move, onEnd?)`. */
export function usePointerDrag() {
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  return useCallback((move: (e: PointerEvent) => void, onEnd?: () => void) => {
    stop.current?.();
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      stop.current = null;
      onEnd?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    stop.current = end;
  }, []);
}
