import { randomUUID } from "node:crypto";
import type { ReminderKind, ReminderRepeat, ReminderWire } from "@openlive/shared";
import { log } from "../log.js";
import { nextOccurrence } from "./time.js";

// Timers and reminders, fired by the agent whether or not a call is open.
//
// One timer, pointing at the soonest pending item, recomputed on every add,
// cancel and fire. Finding the soonest is a scan: O(n) per change for n items,
// at most PENDING_MAX + DONE_KEPT, which the JSON write each change makes anyway
// costs more than. A heap would make the pick O(log n) but a cancel O(n) all the
// same, for no win at this size.
//
// The timer never waits longer than RECHECK_MS before looking at the wall clock
// again. A Node timer runs on a monotonic clock that stops while the machine
// sleeps and never sees the wall clock jump (a manual change, an NTP step, a new
// time zone), so a reminder due during a nap would otherwise fire late by the
// whole nap. Re-reading Date.now() every 30 seconds catches all of those the
// same way on every OS, with or without Electron's resume event, at the cost of
// one wakeup per 30 seconds while anything is pending. It also keeps every delay
// far under setTimeout's 2^31-1 ms ceiling, past which Node fires at once.

export const PENDING_MAX = 500;
/** Fired, missed and cancelled items kept for list_reminders' include_done, newest first. */
const DONE_KEPT = 50;
export const RECHECK_MS = 30_000;
/** Fired later than this, an item says it was missed and when it was due. */
export const LATE_MS = 60_000;

export interface SchedulerDeps {
  read: () => ReminderWire[];
  /** Change the stored items under the store's lock; resolves to what was written. */
  update: (fn: (cur: ReminderWire[]) => ReminderWire[]) => Promise<ReminderWire[]>;
  /** Show and say one item. `late`: it came due while OpenLive was closed or asleep. Must not throw. */
  fire: (item: ReminderWire, late: boolean) => void;
}

export interface NewItem { kind: ReminderKind; text: string; dueAt: number; tz: string; repeat: ReminderRepeat }

const due = (r: ReminderWire) => Date.parse(r.dueAt);
const pending = (items: readonly ReminderWire[]) => items.filter((r) => r.status === "pending");

/** Every pending item, and the newest DONE_KEPT of the rest, so the file stays small however long it is used. */
function prune(items: ReminderWire[]): ReminderWire[] {
  const done = items.filter((r) => r.status !== "pending");
  if (done.length <= DONE_KEPT) return items;
  const kept = new Set(done.slice(-DONE_KEPT));
  return items.filter((r) => r.status === "pending" || kept.has(r));
}

export class Scheduler {
  private items: ReminderWire[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Re-arm what was pending when OpenLive last ran. What came due meanwhile fires now, as missed. */
  start(): Promise<void> {
    try { this.items = this.deps.read(); } catch (e) { log.warn("reminders", "read:", e); }
    return this.tick();
  }

  stop(): void { clearTimeout(this.timer); }

  /** Pending items soonest first; with `done`, the finished ones after them, newest first. */
  list(done = false): ReminderWire[] {
    const soonest = pending(this.items).sort((a, b) => due(a) - due(b));
    return done ? [...soonest, ...this.items.filter((r) => r.status !== "pending").reverse()] : soonest;
  }

  async add(n: NewItem): Promise<ReminderWire> {
    const item: ReminderWire = {
      id: randomUUID().slice(0, 8), kind: n.kind, text: n.text, dueAt: new Date(n.dueAt).toISOString(),
      createdAt: new Date().toISOString(), tz: n.tz, repeat: n.repeat, status: "pending",
    };
    await this.change((cur) => {
      if (pending(cur).length >= PENDING_MAX) throw new Error(`${PENDING_MAX} timers and reminders are already pending, the most OpenLive keeps. Cancel some first.`);
      return [...cur, item];
    });
    return item;
  }

  /** Cancels a pending item. Resolves to it, or null when no pending item has that id. */
  async cancel(id: string): Promise<ReminderWire | null> {
    let hit: ReminderWire | null = null;
    await this.change((cur) => cur.map((r) => (r.id === id && r.status === "pending" ? (hit = { ...r, status: "cancelled" }) : r)));
    return hit;
  }

  private async change(fn: (cur: ReminderWire[]) => ReminderWire[]): Promise<void> {
    this.items = await this.deps.update((cur) => prune(fn(cur)));
    this.arm();
  }

  private arm(wait?: number): void {
    clearTimeout(this.timer);
    const next = Math.min(...pending(this.items).map(due));
    if (!Number.isFinite(next) && wait === undefined) return;
    this.timer = setTimeout(() => void this.tick(), wait ?? Math.max(0, Math.min(next - Date.now(), RECHECK_MS)));
    this.timer.unref?.();
  }

  /** Fire everything due, soonest first. A repeat moves on to its next time after now, however many it slept through. */
  private async tick(): Promise<void> {
    const now = Date.now();
    // Most ticks are the 30-second recheck with nothing due: no write for those.
    if (!pending(this.items).some((r) => due(r) <= now)) return this.arm();
    const fired: { item: ReminderWire; late: boolean }[] = [];
    try {
      await this.change((cur) => cur.map((r) => {
        if (r.status !== "pending" || due(r) > now) return r;
        const late = now - due(r) > LATE_MS;
        fired.push({ item: r, late });
        if (r.repeat !== "none") return { ...r, dueAt: new Date(nextOccurrence(due(r), r.repeat, r.tz, now)).toISOString() };
        return { ...r, status: late ? "missed" : "fired" };
      }));
    } catch (e) {
      // Unwritable (a hand-broken file): try again later rather than spin on an item still due.
      log.warn("reminders", "could not save, trying again shortly:", e);
      this.arm(RECHECK_MS);
      return;
    }
    for (const f of fired.sort((a, b) => due(a.item) - due(b.item))) this.deps.fire(f.item, f.late);
  }
}
