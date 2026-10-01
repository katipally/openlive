import { describe, expect, it } from "vitest";
import { afterDuration, firstOccurrence, nextOccurrence, nowLine, parseAt, parseDuration, spokenDuration, spokenTime } from "./time.js";

const LA = "America/Los_Angeles", NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);
// Thursday, October 1, 2026, 3:00 PM in Los Angeles.
const NOW = at("2026-10-01T22:00:00Z");

describe("durations", () => {
  it("reads ISO 8601, seconds and the short form, and refuses the rest", () => {
    expect(parseDuration("PT10M")).toBe(600_000);
    expect(parseDuration("P1DT2H")).toBe(93_600_000);
    expect(parseDuration("pt1h30m")).toBe(5_400_000);
    expect(parseDuration("P1W")).toBe(604_800_000);
    expect(parseDuration("600")).toBe(600_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("90s")).toBe(90_000);
    for (const bad of ["P1M", "P1Y", "PT", "", "ten minutes", "-5"]) expect(parseDuration(bad), bad).toBeNull();
  });

  it("ends from now, and refuses zero, nonsense and the absurd", () => {
    expect(afterDuration("PT5M", NOW)).toEqual({ ok: true, at: NOW + 300_000 });
    expect(afterDuration("0", NOW)).toEqual({ ok: false, error: "The duration has to be more than zero." });
    expect(afterDuration("soon", NOW).ok).toBe(false);
    expect(afterDuration("P9999W", NOW)).toEqual({ ok: false, error: "That is more than ten years away." });
  });

  it("says a duration in words", () => {
    expect(spokenDuration(5_400_000)).toBe("1 hour 30 minutes");
    expect(spokenDuration(45_000)).toBe("45 seconds");
    expect(spokenDuration(90_061_000)).toBe("1 day 1 hour 1 minute 1 second");
  });
});

describe("times", () => {
  it("reads a local time without an offset in the user's zone", () => {
    expect(parseAt("2026-10-01T18:00", NOW, LA)).toEqual({ ok: true, at: at("2026-10-02T01:00:00Z") });
    expect(parseAt("2026-10-01 18:00:00", NOW, LA)).toEqual({ ok: true, at: at("2026-10-02T01:00:00Z") });
    expect(parseAt("2026-10-01T19:00", NOW, NY)).toEqual({ ok: true, at: at("2026-10-01T23:00:00Z") });
  });

  it("takes an offset or Z as given", () => {
    for (const s of ["2026-10-01T18:00:00-07:00", "2026-10-02T01:00Z", "2026-10-02T06:30+0530", "2026-10-02T06:30:00.000+05:30"]) {
      expect(parseAt(s, NOW, LA), s).toEqual({ ok: true, at: at("2026-10-02T01:00:00Z") });
    }
  });

  it("reads a bare clock time as its next occurrence, today or tomorrow", () => {
    expect(parseAt("18:00", NOW, LA)).toEqual({ ok: true, at: at("2026-10-02T01:00:00Z") });
    expect(parseAt("9:00", NOW, LA)).toEqual({ ok: true, at: at("2026-10-02T16:00:00Z") });
  });

  it("refuses a time already past, saying what time it is now", () => {
    expect(parseAt("2026-10-01T14:00", NOW, LA)).toEqual({ ok: false, error: "2:00 PM today (PDT) has already passed. It is now 3:00 PM today (PDT)." });
    expect(parseAt("2026-10-01T22:00Z", NOW, LA).ok).toBe(false);
  });

  it("refuses what is not a real date and time", () => {
    expect(parseAt("2026-02-30T10:00", NOW, LA)).toEqual({ ok: false, error: '"2026-02-30T10:00" is not a real date and time.' });
    expect(parseAt("25:00", NOW, LA).ok).toBe(false);
    expect(parseAt("tomorrow at six", NOW, LA)).toMatchObject({ ok: false, error: expect.stringContaining("is not a time OpenLive reads") });
    expect(parseAt("2026-10-02", NOW, LA).ok).toBe(false);
  });

  it("says a time back the way a person would", () => {
    expect(spokenTime(at("2026-10-02T01:00:00Z"), NOW, LA)).toBe("6:00 PM today (PDT)");
    expect(spokenTime(at("2026-10-02T16:00:00Z"), NOW, LA)).toBe("9:00 AM tomorrow (PDT)");
    expect(spokenTime(at("2026-10-01T16:00:00Z"), NOW, LA)).toBe("9:00 AM today (PDT)");
    expect(spokenTime(at("2026-09-30T16:00:00Z"), NOW, LA)).toBe("9:00 AM yesterday (PDT)");
    expect(spokenTime(at("2026-10-09T16:00:00Z"), NOW, LA)).toBe("9:00 AM on Friday, October 9 (PDT)");
    expect(spokenTime(at("2027-01-05T17:00:00Z"), NOW, LA)).toBe("9:00 AM on Tuesday, January 5, 2027 (PST)");
    expect(nowLine(NOW, LA)).toBe("It is now 3:00 PM on Thursday, October 1, 2026 (America/Los_Angeles, PDT).");
  });
});

describe("repeats", () => {
  it("keep their wall-clock time across a DST change, both ways", () => {
    // Spring forward on March 8, 2026: 9 AM EST, then 9 AM EDT.
    expect(nextOccurrence(at("2026-03-07T14:00:00Z"), "daily", NY, at("2026-03-07T14:00:00Z"))).toBe(at("2026-03-08T13:00:00Z"));
    // Fall back on November 1, 2026.
    expect(nextOccurrence(at("2026-10-31T13:00:00Z"), "daily", NY, at("2026-10-31T13:00:00Z"))).toBe(at("2026-11-01T14:00:00Z"));
    expect(nextOccurrence(at("2026-10-29T13:00:00Z"), "weekly", NY, at("2026-10-29T13:00:00Z"))).toBe(at("2026-11-05T14:00:00Z"));
  });

  it("skip the weekend on weekdays, and keep the weekday on weekly", () => {
    // Friday October 2, 9 AM in Los Angeles, then Monday.
    expect(nextOccurrence(at("2026-10-02T16:00:00Z"), "weekdays", LA, at("2026-10-02T16:00:00Z"))).toBe(at("2026-10-05T16:00:00Z"));
    // Set on a Thursday, slept through two weeks: the next Thursday after now.
    expect(nextOccurrence(at("2026-10-01T16:00:00Z"), "weekly", LA, at("2026-10-20T00:00:00Z"))).toBe(at("2026-10-22T16:00:00Z"));
    // A weekday repeat set for Saturday starts on Monday; anything else starts when set.
    expect(firstOccurrence(at("2026-10-03T16:00:00Z"), "weekdays", LA)).toBe(at("2026-10-05T16:00:00Z"));
    expect(firstOccurrence(at("2026-10-03T16:00:00Z"), "daily", LA)).toBe(at("2026-10-03T16:00:00Z"));
  });

  it("jump straight past a long absence to the next one after now", () => {
    expect(nextOccurrence(at("2025-10-01T16:00:00Z"), "daily", LA, NOW)).toBe(at("2026-10-02T16:00:00Z"));
    expect(nextOccurrence(at("2025-10-01T16:00:00Z"), "daily", LA, at("2026-10-01T15:00:00Z"))).toBe(at("2026-10-01T16:00:00Z"));
  });
});
