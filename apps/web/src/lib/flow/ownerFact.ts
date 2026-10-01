import type { TelemetryEventProps, TelemetryFactProps } from "@openlive/shared";
import { roundMs } from "../live/perf";
import type { QuietReason } from "./quiet";
import type { FlowFailureCode } from "./types";

// Everything the owner window knows about one open interval of Flow, kept as
// one plain object and sent as a single fact just before Flow closes. Counts
// only: never what was said, shown or run.

type Fact = TelemetryFactProps<"flow_owner">;
export type OpenedBy = NonNullable<Fact["opened_by"]>;
export type FailureOrigin = NonNullable<TelemetryEventProps<"flow_failure_card">["origin"]>;
type Quiet = Exclude<QuietReason, "">;

export interface OwnerFact {
  openedBy: OpenedBy;
  /** `perf.mark()` when Flow opened: this open's latency is the turns recorded after it. */
  mark: number;
  ready?: NonNullable<Fact["ready"]>;
  readyMs?: number;
  stops: number;
  bargeIns: number;
  fixes: number;
  failureCards: number;
  lastFailure: FlowFailureCode | "none";
  /** Turns let go by the silence watchdog, and by a socket that dropped mid answer. */
  lostSilence: number;
  lostLink: number;
  linkDrops: number;
  micLost: number;
  permByVoice: number;
  quiet: Partial<Record<Quiet, number>>;
}

export const openFact = (openedBy: OpenedBy, mark: number): OwnerFact => ({
  openedBy, mark, stops: 0, bargeIns: 0, fixes: 0, failureCards: 0, lastFailure: "none",
  lostSilence: 0, lostLink: 0, linkDrops: 0, micLost: 0, permByVoice: 0, quiet: {},
});

/**
 * Which failure card is on screen. Health re-derives the same card on every
 * open, network change and settings write, so only a code that differs from the
 * one showing is a card appearing.
 */
export function cardWatch() {
  let shown: FlowFailureCode | null = null;
  return {
    /** The code, when it is a new card. `null` (no card) resets, so the same failure later is new again. */
    appears(code: FlowFailureCode | null): FlowFailureCode | undefined {
      if (code === shown) return undefined;
      shown = code;
      return code ?? undefined;
    },
    clear() { shown = null; },
  };
}

/**
 * The tray opens a closed Flow by firing the gesture, so the effect that opens it
 * looks like a double tap. Main says the tray asked just before, and the next
 * effect, whatever it is, is the answer: a stale ask cannot label a later tap.
 */
export function trayAsk() {
  let asked = false;
  return {
    ask() { asked = true; },
    /** Who opened Flow, for the effect that just arrived. */
    opener(): OpenedBy {
      const by = asked ? "tray_new" : "gesture";
      asked = false;
      return by;
    },
  };
}

/** The reason that quieted the most turns, "none" when no turn was quiet. First wins a tie. */
export const topQuietReason = (q: OwnerFact["quiet"]): NonNullable<Fact["top_quiet_reason"]> =>
  (Object.entries(q) as [Quiet, number][]).reduce<[Quiet | "none", number]>((top, e) => (e[1] > top[1] ? e : top), ["none", 0])[0];

/** Counts are sent even at zero: an average over sessions must not skip the ones with none. */
export const ownerFactProps = (f: OwnerFact, speech: Fact): Fact => ({
  opened_by: f.openedBy,
  ...(f.ready && { ready: f.ready }),
  ...(f.readyMs !== undefined && { ready_ms: roundMs(f.readyMs) }),
  stops: f.stops,
  barge_ins: f.bargeIns,
  top_quiet_reason: topQuietReason(f.quiet),
  failure_cards: f.failureCards,
  fixes_clicked: f.fixes,
  last_failure: f.lastFailure,
  lost_silence: f.lostSilence,
  lost_link: f.lostLink,
  link_drops: f.linkDrops,
  mic_lost: f.micLost,
  perm_by_voice: f.permByVoice,
  ...speech,
});
