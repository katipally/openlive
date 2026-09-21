"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flowBridge, type FlowCapabilities } from "./bridge";

// What the machine can honestly do, read from the addon rather than assumed.
//
// macOS never calls back when a grant is given, so the only way to notice one is
// to keep asking. The poll runs at 1Hz, stops itself after a run of failures
// rather than hammering a broken bridge forever, and surfaces the reason so the
// screen can offer "Check now" instead of spinning.

const POLL_MS = 1000;
const MAX_CONSECUTIVE_ERRORS = 5;

export interface CapabilityState {
  caps: FlowCapabilities | null;
  /** Empty while healthy. Set when the bridge stopped answering. */
  error: string;
  /** False in the browser build: there is no addon to ask. */
  available: boolean;
  refresh: () => void;
}

export function useFlowCapabilities(poll = false): CapabilityState {
  const [caps, setCaps] = useState<FlowCapabilities | null>(null);
  const [error, setError] = useState("");
  const errors = useRef(0);
  const stopped = useRef(false);
  const available = !!flowBridge();

  const refresh = useCallback(async () => {
    const api = flowBridge();
    if (!api) return;
    const r = await api.capabilities();
    if (r.ok) {
      errors.current = 0;
      stopped.current = false;
      setError("");
      setCaps(r.value);
      return;
    }
    errors.current += 1;
    if (errors.current >= MAX_CONSECUTIVE_ERRORS) {
      stopped.current = true;
      setError(r.error || "The desktop stopped answering.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!poll) return;
    const timer = setInterval(() => { if (!stopped.current) void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [poll, refresh]);

  // A manual "Check now" is also the way back from a stopped poll.
  const manual = useCallback(() => { stopped.current = false; errors.current = 0; setError(""); void refresh(); }, [refresh]);

  return { caps, error, available, refresh: manual };
}
