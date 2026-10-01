import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import { CONFIG, DAY_1, tmpDir } from "./rig";

const require = createRequire(import.meta.url);
const { createSender, classify, retryAfterMs, PACE_MS, BACKOFF_MAX_MS } = require("./sender.cjs");
const { createQueue } = require("./queue.cjs");
const { usernameOf } = require("./username.cjs");

const ID = "0a1b2c3d-0000-4000-8000-000000000001";
const ID_2 = "0a1b2c3d-0000-4000-8000-000000000002";
const NAME = usernameOf(ID);
const NAME_2 = usernameOf(ID_2);
const identify = (id: string, name: string) => ({ profileId: id, firstName: name, properties: { username: name } });

type Reply = { status: number; retryAfter?: string } | Error;
const timers = { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: NodeJS.Timeout) => clearTimeout(t) };
// One queued record; `action` tells the events apart.
const rec = (action: string) => ({ n: "tray_action", p: { app_version: "1.2.3", platform: "darwin", action }, t: "2026-09-29T12:00:00.000Z" });

function make(dir = tmpDir()) {
  const queue = createQueue({ dir, fs });
  const script: Reply[] = [];
  const calls: { at: number; type: string; name?: string; action?: string; req: any }[] = [];
  const post = vi.fn(async (req: any) => {
    const json = JSON.parse(req.body);
    calls.push({ at: Date.now(), type: json.type, name: json.payload.name, action: json.payload.properties?.action, req: { ...req, json } });
    const r = script.shift() ?? { status: 200 };
    if (r instanceof Error) throw r;
    return r;
  });
  const flags = { gate: true, id: ID as string | null, random: 0.5 };
  const sender = createSender({
    queue, post, config: CONFIG, now: Date.now, timers,
    random: () => flags.random,
    sleep: async () => {},
    gate: () => flags.gate,
    profileId: () => flags.id,
  });
  return { dir, queue, sender, script, calls, post, flags, tracks: () => calls.filter((c) => c.type === "track") };
}

beforeEach(() => vi.useFakeTimers({ now: DAY_1 }));
afterEach(() => vi.useRealTimers());

describe("sender request", () => {
  it("posts each event as OpenPanel's track, with the install ID as profile, a device ID of its own and a loopback address", async () => {
    const s = make();
    s.queue.append(rec("open"));
    s.queue.append(rec("quit"));
    s.sender.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.calls.map((c) => c.type)).toEqual(["track", "track"]);
    const [track] = s.calls;
    expect(track!.req.url).toBe("https://ingest.example.test/api/track");
    expect(track!.req.headers).toEqual({ "content-type": "application/json", "openpanel-client-id": CONFIG.clientId, origin: "https://app.example.test" });
    expect(track!.req.json).toEqual({
      type: "track",
      payload: {
        name: "tray_action",
        profileId: ID,
        properties: {
          app_version: "1.2.3", platform: "darwin", username: NAME, action: "open", __timestamp: "2026-09-29T12:00:00.000Z", __ip: "127.0.0.1",
          __deviceId: `device-${ID}`, __identify: identify(ID, NAME),
        },
      },
    });
    expect(s.calls[1]!.req.json.payload.properties).toEqual({
      app_version: "1.2.3", platform: "darwin", username: NAME, action: "quit", __timestamp: "2026-09-29T12:00:00.000Z", __ip: "127.0.0.1", __deviceId: `device-${ID}`,
    });
  });

  it("never sends a registration request, for the first install ID or a new one", async () => {
    const s = make();
    s.queue.append(rec("open"));
    s.sender.start();
    await vi.advanceTimersByTimeAsync(60_000);
    s.flags.id = ID_2;
    s.queue.append(rec("quit"));
    s.sender.kick();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.calls.map((c) => c.type)).toEqual(["track", "track"]);
    expect(s.calls.map((c) => [c.req.json.payload.profileId, c.req.json.payload.properties.__deviceId])).toEqual([[ID, `device-${ID}`], [ID_2, `device-${ID_2}`]]);
  });

  it("tolerates a trailing slash on the endpoint", async () => {
    const dir = tmpDir();
    const queue = createQueue({ dir, fs });
    const post = vi.fn(async () => ({ status: 200 }));
    const sender = createSender({ queue, post, config: { ...CONFIG, endpoint: "https://ingest.example.test///" }, now: Date.now, timers, random: () => 0, sleep: async () => {}, gate: () => true, profileId: () => ID });
    queue.append(rec("open"));
    sender.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(post.mock.calls[0]![0].url).toBe("https://ingest.example.test/api/track");
  });
});

describe("sender username", () => {
  it("names the profile with the first event a launch gets taken, and not again for that install", async () => {
    const s = make();
    s.queue.append(rec("open"));
    s.queue.append(rec("quit"));
    s.sender.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.calls.map((c) => c.req.json.payload.properties.__identify)).toEqual([identify(ID, NAME), undefined]);
  });

  it("names a new install ID again, under its own name", async () => {
    const s = make();
    s.queue.append(rec("open"));
    s.sender.start();
    await vi.advanceTimersByTimeAsync(60_000);
    s.flags.id = ID_2;
    s.queue.append(rec("quit"));
    s.sender.kick();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(NAME_2).not.toBe(NAME);
    expect(s.calls.map((c) => [c.req.json.payload.properties.username, c.req.json.payload.properties.__identify])).toEqual([
      [NAME, identify(ID, NAME)],
      [NAME_2, identify(ID_2, NAME_2)],
    ]);
  });

  it("keeps naming the profile until a request that carries the name was taken", async () => {
    const s = make();
    s.script.push({ status: 503 }, { status: 200 });
    s.queue.append(rec("open"));
    s.queue.append(rec("quit"));
    s.sender.start();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(s.calls.map((c) => [c.action, !!c.req.json.payload.properties.__identify])).toEqual([["open", true], ["open", true], ["quit", false]]);
  });

  it("takes the name from the install ID, whatever a queued record says", async () => {
    const s = make();
    s.queue.append({ n: "tray_action", p: { app_version: "1.2.3", platform: "darwin", action: "open", username: "someone-real-00000000" }, t: "2026-09-29T12:00:00.000Z" });
    s.sender.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.calls[0]!.req.json.payload.properties.username).toBe(NAME);
  });

  it("never asks for a named profile on the last event of an install, but still carries the name as a property", async () => {
    const s = make();
    expect(await s.sender.sendBestEffort({ n: "telemetry_disabled", p: { from: "notice", days_since_first_open: 0 }, t: "2026-09-29T12:00:00.000Z" }, ID_2)).toBe(true);
    const props = s.calls[0]!.req.json.payload.properties;
    expect(props).toMatchObject({ username: NAME_2 });
    expect(props).not.toHaveProperty("__identify");
  });
});

describe("sender re-validation", () => {
  const props = (n: string, p: Record<string, unknown>, t = "2026-09-29T12:00:00.000Z") => ({ n, p, t });

  it("sends only what the schema allows, from a queue file that was edited", async () => {
    const s = make();
    s.queue.append(props("tray_action", { app_version: "1.2.3", platform: "darwin", action: "open", path: "/Users/me/secret", extra: 1 }));
    s.queue.append(props("tray_action", { app_version: "1.2.3; drop", platform: "/etc/passwd", arch: "arm64", action: "open" }));
    s.sender.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.calls.map((c) => c.req.json.payload.properties)).toEqual([
      {
        app_version: "1.2.3", platform: "darwin", username: NAME, action: "open", __timestamp: "2026-09-29T12:00:00.000Z", __ip: "127.0.0.1",
        __deviceId: `device-${ID}`, __identify: identify(ID, NAME),
      },
      { arch: "arm64", username: NAME, action: "open", __timestamp: "2026-09-29T12:00:00.000Z", __ip: "127.0.0.1", __deviceId: `device-${ID}` },
    ]);
  });

  it("drops a record that is not an event, or has a bad required prop or time, without a request", async () => {
    const s = make();
    for (const bad of [props("not_an_event", { x: 1 }), props("tray_action", { action: "rm -rf" }), props("tray_action", {}), props("tray_action", { action: "open" }, "yesterday"), props("__proto__", {})]) s.queue.append(bad);
    s.queue.append(rec("quit"));
    s.sender.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.calls.map((c) => c.action)).toEqual(["quit"]);
    expect(s.queue.size()).toBe(0);
  });

  it("normalizes the time it sends", async () => {
    const s = make();
    s.queue.append(props("tray_action", { action: "open" }, "2026-09-29T12:00:00Z"));
    s.sender.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.calls[0]!.req.json.payload.properties.__timestamp).toBe("2026-09-29T12:00:00.000Z");
  });
});

describe("sender pacing", () => {
  it("waits a random head start of up to a minute before the first send", async () => {
    for (const [random, at] of [[0.25, 15_000], [0.5, 30_000], [1, 60_000]] as const) {
      const s = make();
      s.queue.append(rec("open"));
      s.flags.random = random;
      s.sender.start();
      await vi.advanceTimersByTimeAsync(at - 1_000);
      expect(s.post).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(s.post).toHaveBeenCalled();
    }
  });

  it("after the notice, waits 15 to 60 seconds from that moment", async () => {
    for (const [random, at] of [[0, 15_000], [0.5, 37_500], [1, 60_000]] as const) {
      const s = make();
      s.queue.append(rec("open"));
      s.flags.random = random;
      s.sender.start({ afterNotice: true });
      await vi.advanceTimersByTimeAsync(at - 1_000);
      expect(s.post).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(s.post).toHaveBeenCalled();
    }
  });

  it("holds an event queued during the head start until it ends", async () => {
    const s = make();
    s.flags.random = 1;
    s.sender.start();
    await vi.advanceTimersByTimeAsync(10_000);
    s.queue.append(rec("open"));
    s.sender.kick();
    await vi.advanceTimersByTimeAsync(49_000);
    expect(s.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.tracks()).toHaveLength(1);
  });

  it("sends at most two requests a second", async () => {
    const s = make();
    for (const action of ["open", "quit", "settings", "new_flow", "allow_accessibility", "open"]) s.queue.append(rec(action));
    s.sender.start();
    await vi.advanceTimersByTimeAsync(120_000);
    const times = s.calls.map((c) => c.at);
    expect(times).toHaveLength(6);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(PACE_MS);
    expect(s.calls.map((c) => c.action)).toEqual(["open", "quit", "settings", "new_flow", "allow_accessibility", "open"]);
  });

  it("sends nothing while a gate is closed, and resumes when it opens", async () => {
    const s = make();
    s.queue.append(rec("open"));
    s.flags.gate = false;
    s.sender.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.post).not.toHaveBeenCalled();
    s.flags.gate = true;
    s.sender.kick();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.tracks()).toHaveLength(1);
  });

  it("sends nothing without an install ID, or before start, or after stop", async () => {
    const s = make();
    s.queue.append(rec("open"));
    s.sender.kick();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.post).not.toHaveBeenCalled();
    s.flags.id = null;
    s.sender.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.post).not.toHaveBeenCalled();
    s.flags.id = ID;
    s.sender.stop();
    s.sender.kick();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.post).not.toHaveBeenCalled();
  });
});

describe("sender failures", () => {
  it("removes an event only once the server took it", async () => {
    const s = make();
    s.queue.append(rec("open"));
    s.script.push({ status: 503 });
    s.sender.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(s.queue.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.queue.size()).toBe(0);
    expect(s.tracks()).toHaveLength(2);
  });

  it("backs off exponentially with jitter, up to a cap", async () => {
    const s = make();
    s.flags.random = 0.5;
    s.queue.append(rec("open"));
    for (let i = 0; i < 12; i++) s.script.push({ status: 500 });
    s.sender.start();
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS * 20);
    const gaps = s.calls.slice(1).map((c, i) => c.at - s.calls[i]!.at);
    expect(gaps.slice(0, 4)).toEqual([22_500, 45_000, 90_000, 180_000]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    expect(gaps.at(-1)).toBe(BACKOFF_MAX_MS * 0.75);
    expect(s.queue.size()).toBe(0);
  });

  it("jitters the wait between half and all of the backoff", async () => {
    for (const [random, gap] of [[0, 15_000], [1, 30_000]] as const) {
      const s = make();
      s.flags.random = random;
      s.queue.append(rec("open"));
      s.script.push({ status: 500 });
      s.sender.start();
      await vi.advanceTimersByTimeAsync(gap * 2 + 1_000 + (random ? 60_000 : 0));
      expect(s.calls[1]!.at - s.calls[0]!.at).toBe(gap);
    }
  });

  it("starts the backoff over after a success", async () => {
    const s = make();
    s.queue.append(rec("open"));
    s.queue.append(rec("quit"));
    s.script.push({ status: 500 }, { status: 500 }, { status: 200 }, { status: 500 });
    s.sender.start();
    await vi.advanceTimersByTimeAsync(600_000);
    const gaps = s.calls.slice(1).map((c, i) => c.at - s.calls[i]!.at);
    expect(gaps[0]).toBe(22_500);
    expect(gaps[1]).toBe(45_000);
    expect(gaps[3]).toBe(22_500);
  });

  it("keeps the event through a network error", async () => {
    const s = make();
    s.queue.append(rec("open"));
    s.script.push(new Error("ECONNRESET"), new Error("ETIMEDOUT"));
    s.sender.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(s.tracks()).toHaveLength(3);
    expect(s.queue.size()).toBe(0);
  });

  it("honors Retry-After in seconds on a 429, without inventing a backoff", async () => {
    const s = make();
    s.queue.append(rec("open"));
    s.script.push({ status: 429, retryAfter: "120" });
    s.sender.start();
    await vi.advanceTimersByTimeAsync(119_000 + 30_000);
    expect(s.tracks()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.tracks()).toHaveLength(2);
    expect(s.calls[1]!.at - s.calls[0]!.at).toBe(120_000);
  });

  it("honors Retry-After as an HTTP date, and falls back to backoff without a usable one", async () => {
    const s = make();
    s.queue.append(rec("open"));
    s.script.push({ status: 429, retryAfter: new Date(DAY_1.getTime() + 300_000).toUTCString() }, { status: 429 }, { status: 429, retryAfter: "soon" });
    s.sender.start();
    await vi.advanceTimersByTimeAsync(3_000_000);
    const gaps = s.calls.slice(1).map((c, i) => c.at - s.calls[i]!.at);
    expect(gaps[0]).toBe(270_000);
    expect(gaps[1]).toBe(22_500);
    expect(gaps[2]).toBe(45_000);
  });

  it("drops an event the server will never take, and carries on with the next", async () => {
    const s = make();
    s.queue.append(rec("open"));
    s.queue.append(rec("quit"));
    s.script.push({ status: 400 });
    s.sender.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.tracks().map((c) => c.action)).toEqual(["open", "quit"]);
    expect(s.queue.size()).toBe(0);
  });

  it("keeps the event and backs off on an auth failure, since that is a config fault to be fixed", async () => {
    const s = make();
    s.queue.append(rec("open"));
    s.script.push({ status: 401 }, { status: 403 });
    s.sender.start();
    await vi.advanceTimersByTimeAsync(31_000 + 60_000);
    expect(s.tracks().length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(s.queue.size()).toBe(0);
  });

  it("picks up where a previous run stopped", async () => {
    const first = make();
    first.queue.append(rec("open"));
    first.queue.append(rec("quit"));
    const second = make(first.dir);
    second.sender.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(second.tracks().map((c) => c.action)).toEqual(["open", "quit"]);
  });

  it("does not remove an event a clear replaced while its request was in flight", async () => {
    const s = make();
    s.queue.append(rec("open"));
    let release!: () => void;
    s.post.mockImplementationOnce(() => new Promise((r) => (release = () => r({ status: 200 }))));
    s.sender.start();
    await vi.advanceTimersByTimeAsync(31_000);
    s.queue.clear();
    s.queue.append(rec("settings"));
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.queue.peek().rec.p.action).toBe("settings");
  });
});

describe("sendBestEffort", () => {
  const record = { n: "telemetry_disabled", p: { app_version: "1.2.3", platform: "darwin", from: "settings", days_since_first_open: 3 }, t: "2026-09-29T12:00:00.000Z" };

  it("makes one request when the server takes it", async () => {
    const s = make();
    expect(await s.sender.sendBestEffort(record, ID_2)).toBe(true);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.type).toBe("track");
    expect(s.calls[0]!.req.json.payload).toMatchObject({ name: "telemetry_disabled", profileId: ID_2, properties: { days_since_first_open: 3, username: NAME_2, __ip: "127.0.0.1", __deviceId: `device-${ID_2}` } });
  });

  it("sends nothing for a record that fails validation", async () => {
    const s = make();
    expect(await s.sender.sendBestEffort({ ...record, p: { from: "elsewhere" } }, ID_2)).toBe(false);
    expect(s.calls).toHaveLength(0);
  });

  it("tries three times and then gives up", async () => {
    const s = make();
    s.script.push({ status: 500 }, new Error("offline"), { status: 502 }, { status: 200 });
    expect(await s.sender.sendBestEffort(record, ID_2)).toBe(false);
    expect(s.calls).toHaveLength(3);
  });

  it("stops after the first success", async () => {
    const s = make();
    s.script.push(new Error("offline"), { status: 200 });
    expect(await s.sender.sendBestEffort(record, ID_2)).toBe(true);
    expect(s.calls).toHaveLength(2);
  });
});

describe("classify and retryAfterMs", () => {
  it("sorts a status into what to do next", () => {
    expect(classify({ status: 200 })).toBe("ok");
    expect(classify({ status: 204 })).toBe("ok");
    expect(classify({ status: 429 })).toBe("limited");
    for (const status of [500, 502, 503, 504, 401, 403, 408, 425]) expect(classify({ status })).toBe("retry");
    for (const status of [400, 404, 413, 422, 301]) expect(classify({ status })).toBe("drop");
  });

  it("reads seconds and dates, clamps them, and shrugs at anything else", () => {
    expect(retryAfterMs("30", 0)).toBe(30_000);
    expect(retryAfterMs("0", 0)).toBe(1_000);
    expect(retryAfterMs("999999999", 0)).toBe(BACKOFF_MAX_MS);
    expect(retryAfterMs(new Date(60_000).toUTCString(), 0)).toBe(60_000);
    expect(retryAfterMs(new Date(0).toUTCString(), 60_000)).toBe(1_000);
    for (const bad of ["soon", "", undefined, null]) expect(retryAfterMs(bad, 0)).toBeUndefined();
  });
});
