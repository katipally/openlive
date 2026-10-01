import { describe, expect, it } from "vitest";
import { cardWatch, openFact, ownerFactProps, topQuietReason, trayAsk } from "./ownerFact";

describe("topQuietReason", () => {
  it("is none when no turn was quiet", () => {
    expect(topQuietReason({})).toBe("none");
  });
  it("is the reason that quieted the most turns, and the first of a tie", () => {
    expect(topQuietReason({ meeting: 1, dnd: 3, off: 2 })).toBe("dnd");
    expect(topQuietReason({ mic_busy: 2, meeting: 2 })).toBe("mic_busy");
  });
});

describe("ownerFactProps", () => {
  it("sends every count, zero included, so an average over sessions is not skewed", () => {
    expect(ownerFactProps(openFact("gesture", 0), {})).toEqual({
      opened_by: "gesture", stops: 0, barge_ins: 0, top_quiet_reason: "none", failure_cards: 0, fixes_clicked: 0, last_failure: "none",
      lost_silence: 0, lost_link: 0, link_drops: 0, mic_lost: 0, perm_by_voice: 0,
    });
  });

  it("leaves out what never happened: no readiness for a late speech open, no latency without a measured turn", () => {
    const props = ownerFactProps(openFact("late_speech", 0), {});
    expect(props).not.toHaveProperty("ready");
    expect(props).not.toHaveProperty("ready_ms");
    expect(props).not.toHaveProperty("v2v_ms_p50");
  });

  it("rounds the readiness time to 10 ms and carries what the open recorded", () => {
    const f = openFact("carry_on", 4);
    Object.assign(f, { ready: "ok", readyMs: 1234.5, stops: 2, bargeIns: 1, failureCards: 1, lastFailure: "offline", linkDrops: 3, permByVoice: 1 });
    f.quiet = { meeting: 2 };
    const props = ownerFactProps(f, { v2v_ms_p50: 900, v2v_turns: 5, webgpu: true });
    expect(props).toMatchObject({
      opened_by: "carry_on", ready: "ok", ready_ms: 1230, stops: 2, barge_ins: 1, top_quiet_reason: "meeting",
      failure_cards: 1, last_failure: "offline", link_drops: 3, perm_by_voice: 1, v2v_ms_p50: 900, v2v_turns: 5, webgpu: true,
    });
  });

  it("starts each open from nothing", () => {
    const a = openFact("gesture", 0);
    a.stops = 5;
    a.quiet.dnd = 1;
    expect(openFact("gesture", 9)).toMatchObject({ stops: 0, quiet: {}, mark: 9 });
  });
});

describe("cardWatch", () => {
  it("counts a code as a card once, however often health derives it again", () => {
    const w = cardWatch();
    expect(w.appears("offline")).toBe("offline");
    expect(w.appears("offline")).toBeUndefined();
    expect(w.appears("offline")).toBeUndefined();
  });

  it("counts a different code as a new card", () => {
    const w = cardWatch();
    w.appears("offline");
    expect(w.appears("turn_failed")).toBe("turn_failed");
    expect(w.appears("offline")).toBe("offline");
  });

  it("counts the same failure again once the card has gone", () => {
    const w = cardWatch();
    w.appears("mic_failed");
    expect(w.appears(null)).toBeUndefined();
    expect(w.appears("mic_failed")).toBe("mic_failed");
  });

  it("counts the same failure again after a clear, as at the next open", () => {
    const w = cardWatch();
    w.appears("no_provider");
    w.clear();
    expect(w.appears("no_provider")).toBe("no_provider");
  });
});

describe("trayAsk", () => {
  it("is a double tap until the tray says otherwise", () => {
    expect(trayAsk().opener()).toBe("gesture");
  });

  it("names the tray for the one effect that follows its ask, then goes back to the gesture", () => {
    const t = trayAsk();
    t.ask();
    expect(t.opener()).toBe("tray_new");
    expect(t.opener()).toBe("gesture");
  });
});
