"use client";

import { useEffect, useRef } from "react";
import type { TelemetryEventProps } from "@openlive/shared";
import { telemetry } from "../telemetry";
import { useLiveStore } from "./liveStore";

type Blocked = TelemetryEventProps<"lobby_blocked">;
export type LobbyGap = Blocked["gap"];

/** A gap counts only once it has been up this long: the queries behind them load late, so one flickers first. */
export const HELD_MS = 1000;

export interface LobbyState {
  modelsMissing: boolean; agentGap: "install" | "signin" | null; needFolder: boolean; folderGap: boolean; keyGap: boolean; micGap: boolean;
}

/** The gap the lobby puts first, in the order it shows them. The download offer stands in for all the others. Pure. */
export function lobbyGap(s: LobbyState): LobbyGap | null {
  if (s.modelsMissing) return "models_not_downloaded";
  if (s.agentGap) return s.agentGap === "install" ? "agent_not_installed" : "agent_signed_out";
  if (s.needFolder) return "folder_unset";
  if (s.folderGap) return "folder_missing";
  if (s.keyGap) return "no_api_key";
  return s.micGap ? "no_mic" : null;
}

/** The gap to report for a lobby left at `now`: the one showing, if it had been for HELD_MS. Pure. */
export const heldGap = (at: { gap: LobbyGap | null; since: number }, now: number): LobbyGap | null =>
  at.gap && now - at.since >= HELD_MS ? at.gap : null;

/** Reports a lobby left on a gap, unless the call went on to start. Returns how the person is leaving, to call before they do. */
export function useLobbyBlocked(gap: LobbyGap | null, brainKind: Blocked["brain_kind"], brainId: Blocked["brain_id"]) {
  const at = useRef({ gap, since: Date.now(), brainKind, brainId, via: "other" as NonNullable<Blocked["left_via"]> });
  useEffect(() => {
    const cur = at.current;
    at.current = { ...cur, gap, brainKind, brainId, since: cur.gap === gap ? cur.since : Date.now() };
  }, [gap, brainKind, brainId]);
  useEffect(() => () => {
    const { brainKind, brainId, via } = at.current;
    const held = heldGap(at.current, Date.now());
    if (held && !useLiveStore.getState().active) telemetry.track("lobby_blocked", { gap: held, brain_kind: brainKind, brain_id: brainId, left_via: via });
  }, []);
  return (via: NonNullable<Blocked["left_via"]>) => { at.current.via = via; };
}
