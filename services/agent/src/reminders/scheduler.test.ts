import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReminderWire } from "@openlive/shared";
import { LATE_MS, PENDING_MAX, RECHECK_MS, Scheduler, type NewItem } from "./scheduler.js";

const LA = "America/Los_Angeles";
const NOW = Date.parse("2026-10-01T22:00:00Z");
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** A scheduler over a store in memory, recording what fires. */
function harness(stored: ReminderWire[] = []) {
  let items = stored;
  const fired: { text: string; late: boolean }[] = [];
  const s = new Scheduler({
    read: () => items,
    update: async (fn) => (items = fn(structuredClone(items))),
    fire: (r, late) => fired.push({ text: r.text, late }),
  });
  return { s, fired, items: () => items };
}

const item = (text: string, dueAt: number, over: Partial<ReminderWire> = {}): ReminderWire => ({
  id: text, kind: "reminder", text, dueAt: new Date(dueAt).toISOString(), createdAt: new Date(NOW - DAY).toISOString(), tz: LA, repeat: "none", status: "pending", ...over,
});
const add = (s: Scheduler, text: string, inMs: number, over: Partial<NewItem> = {}) =>
  s.add({ kind: "reminder", text, dueAt: Date.now() + inMs, tz: LA, repeat: "none", ...over });

afterEach(() => vi.useRealTimers());

describe("the scheduler", () => {
  it("keeps one timer on the soonest item, and fires each in due order", async () => {
    vi.useFakeTimers({ now: NOW });
    const { s, fired, items } = harness();
    await add(s, "third", 3_000);
    await add(s, "first", 1_000);
    await add(s, "second", 2_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fired).toEqual([{ text: "first", late: false }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fired.map((f) => f.text)).toEqual(["first", "second", "third"]);
    expect(items().map((r) => r.status)).toEqual(["fired", "fired", "fired"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-arms what was pending when it starts again", async () => {
    vi.useFakeTimers({ now: NOW });
    const { s, fired, items } = harness([item("later", NOW + 5 * MIN)]);
    await s.start();
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(fired).toEqual([{ text: "later", late: false }]);
    expect(items()[0]!.status).toBe("fired");
  });

  it("fires what came due while it was closed once, as missed, and moves a repeat to its next time", async () => {
    vi.useFakeTimers({ now: NOW });
    const { s, fired, items } = harness([
      item("bank", NOW - 2 * HOUR),
      item("pills", NOW - 2 * DAY - 6 * HOUR, { repeat: "daily" }),
      item("soon", NOW + HOUR),
    ]);
    await s.start();
    expect(fired).toEqual([{ text: "pills", late: true }, { text: "bank", late: true }]);
    const [bank, pills, soon] = items();
    expect(bank!.status).toBe("missed");
    expect(pills!.status).toBe("pending");
    // Due at 9 AM, three days of it slept through: next is 9 AM tomorrow.
    expect(pills!.dueAt).toBe("2026-10-02T16:00:00.000Z");
    expect(soon!.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(fired.at(-1)).toEqual({ text: "soon", late: false });
  });

  it("never sets a timer past the 30-second recheck, so a far one is not fired at once by setTimeout's ceiling", async () => {
    vi.useFakeTimers({ now: NOW });
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => { delays.push(ms ?? 0); return real(fn, ms); }) as typeof setTimeout);
    const { s, fired } = harness();
    await add(s, "in forty days", 40 * DAY);
    expect(delays.at(-1)).toBe(RECHECK_MS);
    await vi.advanceTimersByTimeAsync(5 * RECHECK_MS);
    expect(fired).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    expect(delays.every((d) => d > 0 && d <= RECHECK_MS)).toBe(true);
  });

  it("catches up after a sleep or a clock jump within the recheck, saying it was late", async () => {
    vi.useFakeTimers({ now: NOW });
    const { s, fired } = harness();
    await add(s, "stretch", 10 * MIN);
    // Asleep: the wall clock moves on and no timer runs.
    vi.setSystemTime(NOW + 2 * HOUR);
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(fired).toEqual([{ text: "stretch", late: true }]);
  });

  it("is not late within a minute of due", async () => {
    vi.useFakeTimers({ now: NOW });
    const { s, fired } = harness();
    await add(s, "tea", 10 * MIN);
    vi.setSystemTime(NOW + 10 * MIN + LATE_MS - RECHECK_MS);
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(fired).toEqual([{ text: "tea", late: false }]);
  });

  it("refuses past the cap, with what to do", async () => {
    vi.useFakeTimers({ now: NOW });
    const { s } = harness(Array.from({ length: PENDING_MAX }, (_, i) => item(`r${i}`, NOW + DAY + i)));
    await expect(add(s, "one more", HOUR)).rejects.toThrow(`${PENDING_MAX} timers and reminders are already pending, the most OpenLive keeps. Cancel some first.`);
  });

  it("cancels one, re-arms for the next, and never fires the cancelled", async () => {
    vi.useFakeTimers({ now: NOW });
    const { s, fired } = harness();
    const a = await add(s, "a", MIN);
    await add(s, "b", 2 * MIN);
    expect((await s.cancel(a.id))?.status).toBe("cancelled");
    expect(await s.cancel(a.id)).toBeNull();
    expect(s.list().map((r) => r.text)).toEqual(["b"]);
    expect(s.list(true).map((r) => `${r.text} ${r.status}`)).toEqual(["b pending", "a cancelled"]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(fired.map((f) => f.text)).toEqual(["b"]);
  });

  it("keeps the file small: every pending item, and only the newest finished ones", async () => {
    vi.useFakeTimers({ now: NOW });
    const { s, items } = harness(Array.from({ length: 80 }, (_, i) => item(`done${i}`, NOW - DAY, { status: "fired" })));
    await add(s, "new", HOUR);
    expect(items()).toHaveLength(51);
    expect(items()[0]!.text).toBe("done30");
  });

  it("writes nothing on a recheck with nothing due", async () => {
    vi.useFakeTimers({ now: NOW });
    let writes = 0;
    let stored: ReminderWire[] = [];
    const s = new Scheduler({ read: () => stored, update: async (fn) => { writes++; return (stored = fn(stored)); }, fire: () => {} });
    await add(s, "far", DAY);
    await vi.advanceTimersByTimeAsync(10 * RECHECK_MS);
    expect(writes).toBe(1);
  });
});
