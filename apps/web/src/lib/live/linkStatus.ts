import { create } from "zustand";

// The live socket's health, for the connection banner. One per window: the main
// window holds at most one LiveClient (lobby pre-connect or a call), and the Flow
// owner renderer keeps its own. "off" means no connection is wanted right now.

export type LinkState = "off" | "connecting" | "open" | "reconnecting";

interface LinkStatus {
  state: LinkState;
  /** Reconnect tries in the current outage, 1-based once reconnecting. */
  attempt: number;
  /** Skip the backoff wait and try now. Null while nothing is connecting. */
  retry: (() => void) | null;
}

export const useLinkStatus = create<LinkStatus>(() => ({ state: "off", attempt: 0, retry: null }));

const BASE_MS = 300;
export const MAX_BACKOFF_MS = 10_000;

/** Wait before reconnect try `attempt` (0-based): doubling from 300 ms, capped at
 *  10 s so a page left open through a long outage still checks back often. */
export function reconnectDelay(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_MS * 2 ** Math.min(attempt, 16));
}
