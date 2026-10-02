import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReminderWire } from "@openlive/shared";
import type { Tool } from "../capabilities/types.js";

// Its own home and a fixed zone, so "6 PM" means the same thing on every machine.
const dir = mkdtempSync(join(tmpdir(), "ol-reminders-"));
process.env.OPENLIVE_HOME = dir;
process.env.TZ = "America/Los_Angeles";
const { reminderTools, clockNote } = await import("./tools.js");
const { Scheduler } = await import("./scheduler.js");
const { deliver, hearReminders, liveSockets, reminderMsg } = await import("./fire.js");
const { ToolSet, dispatchAll } = await import("../capabilities/dispatch.js");
const { allowAll } = await import("../capabilities/approval.js");
const { registry } = await import("../capabilities/registry.js");
const { CHAT, FLOW } = await import("../capabilities/profiles.js");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Thursday, October 1, 2026, 3:00 PM in Los Angeles.
const NOW = Date.parse("2026-10-01T22:00:00Z");

let stored: ReminderWire[] = [];
const fired: string[] = [];
let tools: ToolSet;
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  stored = [];
  fired.length = 0;
  const s = new Scheduler({ read: () => stored, update: async (fn) => (stored = fn(stored)), fire: (r) => fired.push(r.text) });
  tools = new ToolSet(reminderTools(s));
});
afterEach(() => vi.useRealTimers());

const ctx = { signal: new AbortController().signal, context: null };
let n = 0;
async function run(name: string, args: Record<string, unknown>) {
  const [r] = await dispatchAll([{ id: `c${n++}`, name, args }], tools, ctx, { approve: allowAll });
  return { text: r!.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: r!.isError, details: r!.details as any };
}

describe("set_timer", () => {
  it("takes ISO 8601 or seconds, and says when it ends", async () => {
    const a = await run("set_timer", { duration: "PT10M", label: "pasta" });
    expect(a.text).toMatch(/^Timer set for 10 minutes \(pasta\)\. It ends at 3:10 PM today \(PDT\)\. Id [0-9a-f]{8}\.$/);
    const b = await run("set_timer", { duration: 90 });
    expect(b.text).toMatch(/^Timer set for 1 minute 30 seconds\. It ends at 3:01 PM today \(PDT\)\./);
    expect(stored.map((r) => [r.kind, r.text, r.tz])).toEqual([["timer", "pasta", "America/Los_Angeles"], ["timer", "", "America/Los_Angeles"]]);
  });

  it("refuses a duration it cannot read", async () => {
    const r = await run("set_timer", { duration: "a while" });
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('"a while" is not a duration') });
    expect(stored).toEqual([]);
  });
});

describe("remind", () => {
  it("reads a local time in the user's zone and says it back", async () => {
    const r = await run("remind", { text: "call the bank", at: "2026-10-01T18:00" });
    expect(r.text).toMatch(/^Reminder set for 6:00 PM today \(PDT\): call the bank\. Id /);
    expect(stored[0]).toMatchObject({ kind: "reminder", dueAt: "2026-10-02T01:00:00.000Z", repeat: "none", status: "pending" });
  });

  it("takes an offset, a bare clock time, and a duration", async () => {
    expect((await run("remind", { text: "a", at: "2026-10-02T09:00:00-04:00" })).text).toContain("6:00 AM tomorrow (PDT)");
    expect((await run("remind", { text: "b", at: "08:30" })).text).toContain("8:30 AM tomorrow (PDT)");
    expect((await run("remind", { text: "c", in: "PT2H" })).text).toContain("5:00 PM today (PDT)");
  });

  it("repeats at the same local time, a weekday one starting on a weekday", async () => {
    const r = await run("remind", { text: "stand up", at: "2026-10-03T09:00", repeat: "weekdays" });
    expect(r.text).toContain("Reminder set for 9:00 AM on Monday, October 5 (PDT), then every weekday: stand up.");
  });

  it("refuses the past, both or neither of at and in, and no text", async () => {
    expect(await run("remind", { text: "x", at: "2026-10-01T09:00" })).toMatchObject({ isError: true, text: "9:00 AM today (PDT) has already passed. It is now 3:00 PM today (PDT)." });
    expect((await run("remind", { text: "x", at: "18:00", in: "PT1H" })).text).toBe("Give exactly one of `at` (a local time) or `in` (a duration).");
    expect((await run("remind", { text: "x" })).isError).toBe(true);
    expect((await run("remind", { text: "  ", in: "PT1H" })).text).toBe("Say what to remind them of.");
    expect(stored).toEqual([]);
  });
});

describe("list_reminders and cancel_reminder", () => {
  it("lists what is pending soonest first, with the time now", async () => {
    await run("remind", { text: "call the bank", at: "18:00" });
    await run("set_timer", { duration: "PT5M" });
    const r = await run("list_reminders", {});
    const [now, first, second] = r.text.split("\n");
    expect(now).toBe("It is now 3:00 PM on Thursday, October 1, 2026 (America/Los_Angeles, PDT).");
    expect(first).toMatch(/^- [0-9a-f]{8}: Timer at 3:05 PM today \(PDT\)$/);
    expect(second).toMatch(/^- [0-9a-f]{8}: Reminder "call the bank" at 6:00 PM today \(PDT\)$/);
    expect((await run("list_reminders", {})).details.items).toHaveLength(2);
  });

  it("cancels by id or by words, and lists the candidates when words match several", async () => {
    await run("remind", { text: "call the bank", at: "18:00" });
    await run("remind", { text: "email the bank", at: "19:00" });
    await run("remind", { text: "water plants", at: "20:00" });
    const several = await run("cancel_reminder", { text_match: "bank" });
    expect(several.isError).toBe(false);
    expect(several.text).toMatch(/^2 match, so none was cancelled:\n- \w+: Reminder "call the bank" at 6:00 PM today \(PDT\)\n- \w+: Reminder "email the bank" at 7:00 PM today \(PDT\)$/);
    expect(several.details.candidates).toHaveLength(2);
    expect(stored.every((r) => r.status === "pending")).toBe(true);

    const plants = stored.find((r) => r.text === "water plants")!.id;
    expect((await run("cancel_reminder", { text_match: "PLANTS" })).text).toBe(`Cancelled: ${plants}: Reminder "water plants" at 8:00 PM today (PDT)`);
    const id = stored.find((r) => r.text === "call the bank")!.id;
    expect((await run("cancel_reminder", { id })).isError).toBe(false);
    expect((await run("cancel_reminder", { id })).text).toBe(`No pending timer or reminder has id ${id}.`);
    expect((await run("cancel_reminder", { text_match: "dentist" })).text).toBe('No pending timer or reminder mentions "dentist".');
    expect(stored.map((r) => r.status)).toEqual(["cancelled", "pending", "cancelled"]);
  });
});

describe("the tools in every session", () => {
  const session = { clipboard: { read: async () => "", write: async () => {} } };
  const reminderNames = (list: readonly Tool[]) => list.filter((t) => t.group === "reminders").map((t) => [t.name, !!t.readOnly, !!t.confirm]);

  it("are offered to Chat and Flow alike, only list marked read-only, none asking first", () => {
    const expected = [["set_timer", false, false], ["remind", false, false], ["list_reminders", true, false], ["cancel_reminder", false, false]];
    expect(reminderNames(registry.tools(CHAT, session).list)).toEqual(expected);
    expect(reminderNames(registry.tools(FLOW, session).list)).toEqual(expected);
  });

  it("bring the local time into the transient tail, while the system prompt stays byte-identical", () => {
    const list = registry.tools(CHAT, session).list;
    expect(clockNote(list)).toBe("It is now 3:00 PM on Thursday, October 1, 2026 (America/Los_Angeles, PDT).");
    expect(clockNote(list.filter((t) => t.group !== "reminders"))).toBe("");
    const chat = CHAT.prompt(list), flow = FLOW.prompt(list);
    vi.setSystemTime(NOW + 47 * 60_000);
    expect(clockNote(list)).toContain("3:47 PM");
    expect(CHAT.prompt(list)).toBe(chat);
    expect(FLOW.prompt(list)).toBe(flow);
    expect(chat).not.toContain("3:00 PM");
  });
});

describe("firing", () => {
  const timer: ReminderWire = { id: "t1", kind: "timer", text: "pasta", dueAt: new Date(NOW).toISOString(), createdAt: new Date(NOW).toISOString(), tz: "America/Los_Angeles", repeat: "none", status: "pending" };
  const bank = { ...timer, id: "r1", kind: "reminder" as const, text: "call the bank" };

  it("says what went off, and a missed one when it was due", () => {
    expect(reminderMsg(bank, false)).toEqual({ t: "reminder", title: "Reminder", body: "call the bank" });
    expect(reminderMsg(timer, false)).toEqual({ t: "reminder", title: "Timer", body: "pasta. Time's up." });
    expect(reminderMsg({ ...timer, text: "" }, false).body).toBe("Time's up.");
    expect(reminderMsg(bank, true, NOW + 26 * 3_600_000).body).toBe("Missed: call the bank. It was due 3:00 PM yesterday (PDT).");
  });

  it("posts a notification to Electron main and tells every open session, whichever fails", () => {
    const posted: unknown[] = [], heard: unknown[] = [];
    const broken = () => { throw new Error("socket gone"); };
    const listen = (m: unknown) => heard.push(m);
    liveSockets.add(broken);
    liveSockets.add(listen);
    try {
      deliver(bank, false, { postMessage: (m) => posted.push(m) });
      deliver(timer, false, { postMessage: () => { throw new Error("port closed"); } });
    } finally { liveSockets.delete(broken); liveSockets.delete(listen); }
    expect(posted).toEqual([{ openlive: "notify", title: "Reminder", body: "call the bank" }]);
    expect(heard).toEqual([{ t: "reminder", title: "Reminder", body: "call the bank" }, { t: "reminder", title: "Timer", body: "pasta. Time's up." }]);
  });

  it("with no desktop app and no session open, keeps it for the next session to hear as missed", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    deliver(bank, false, undefined);
    expect(warn).toHaveBeenCalledWith("[reminders]", "Reminder: call the bank (nothing open to show it yet)");
    warn.mockRestore();
    const heard: unknown[] = [];
    const late = (m: unknown) => heard.push(m);
    hearReminders(late);
    hearReminders(late);
    liveSockets.delete(late);
    expect(heard).toEqual([reminderMsg(bank, true)]);
  });
});
