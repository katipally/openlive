import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modeOf, readJson, tmpDir } from "./rig";

const { createState, localDay, writeAtomic } = createRequire(import.meta.url)("./state.cjs");
const timers = { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: NodeJS.Timeout) => clearTimeout(t) };
const open = (dir: string, more = {}) => createState({ dir, fs, timers, ...more });
const ID = "0a1b2c3d-0000-4000-8000-000000000001";

afterEach(() => vi.useRealTimers());

describe("state", () => {
  it("starts with telemetry on and no ID", () => {
    const s = open(tmpDir());
    expect(s.data).toMatchObject({ installId: null, enabled: true, noticeSeenAt: null, firstOpenAt: null, once: [], featureBucket: {} });
  });

  it("keeps the prompt memory it wrote, and starts it over when a field is the wrong kind or missing", () => {
    const dir = tmpDir();
    const s = open(dir);
    expect(s.data.prompts).toEqual({ never: false, lastAt: 0, lastDay: "", lastSessionAt: 0, lastNpsAt: 0, ignoredInARow: 0, backoffUntil: 0, activeDays: 0, lastActiveDay: "", activated: false });
    s.data.prompts.never = true;
    s.data.prompts.activeDays = 4;
    s.save();
    expect(open(dir).data.prompts).toMatchObject({ never: true, activeDays: 4 });
    writeFileSync(join(dir, "telemetry.json"), JSON.stringify({ prompts: { never: "yes", activeDays: 4 } }));
    expect(open(dir).data.prompts.never).toBe(false);
  });

  it("writes atomically with mode 0600 and reads it back", () => {
    const dir = tmpDir();
    const s = open(dir);
    s.data.installId = ID;
    s.data.enabled = false;
    s.save();
    if (process.platform !== "win32") expect(modeOf(join(dir, "telemetry.json"))).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["telemetry.json"]);
    expect(open(dir).data).toMatchObject({ installId: ID, enabled: false });
  });

  it("starts over on a file it cannot read", () => {
    for (const text of ["", "{", "null", "[1]", "42"]) {
      const dir = tmpDir();
      writeFileSync(join(dir, "telemetry.json"), text);
      expect(open(dir).data.enabled).toBe(true);
    }
  });

  it("keeps only fields of the shape it expects", () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "telemetry.json"),
      JSON.stringify({ installId: 7, enabled: "no", noticeSeenAt: "yesterday", once: ["a", 3], caps: { day: 1 }, featureBucket: [], lastVersion: "1.0.0", extra: "x", firstOpenAt: 5 }),
    );
    const { data } = open(dir);
    expect(data).toMatchObject({ installId: null, enabled: true, noticeSeenAt: null, once: [], caps: { day: "", n: {} }, featureBucket: {}, lastVersion: "1.0.0", firstOpenAt: 5 });
    expect(data).not.toHaveProperty("extra");
  });

  it("keeps an install ID that is a UUID, and starts a new one for anything else, keeping the rest", () => {
    for (const installId of [ID, ID.toUpperCase()]) {
      const dir = tmpDir();
      writeFileSync(join(dir, "telemetry.json"), JSON.stringify({ installId }));
      expect(open(dir).data.installId).toBe(installId);
    }
    for (const installId of ["abc", "", `${ID}0`, ` ${ID}`, `${ID}\n`, "../../etc/passwd", "0a1b2c3d-0000-4000-8000-00000000000g", 7, {}]) {
      const dir = tmpDir();
      writeFileSync(join(dir, "telemetry.json"), JSON.stringify({ installId, firstOpenAt: 5, noticeSeenAt: 6, enabled: false }));
      expect(open(dir).data).toMatchObject({ installId: null, firstOpenAt: 5, noticeSeenAt: 6, enabled: false });
    }
  });

  it("saves soon, once, however many changes come", () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    const s = open(dir, { saveDelayMs: 1000 });
    s.data.lastVersion = "9.9.9";
    s.saveSoon();
    s.saveSoon();
    expect(existsSync(join(dir, "telemetry.json"))).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(readJson(join(dir, "telemetry.json")).lastVersion).toBe("9.9.9");
  });

  it("puts an opt-out on disk over an older file when the rename fails once, and when it always fails", () => {
    for (const failures of [1, Infinity]) {
      const dir = tmpDir();
      let left = 0;
      const flaky = { ...fs, renameSync: (from: string, to: string) => { if (left-- > 0) throw new Error("EPERM"); return fs.renameSync(from, to); } };
      const s = createState({ dir, fs: flaky, timers });
      s.data.installId = ID;
      s.save();
      left = failures;
      s.data.enabled = false;
      expect(() => s.save()).not.toThrow();
      expect(readJson(join(dir, "telemetry.json"))).toMatchObject({ installId: ID, enabled: false });
      if (process.platform !== "win32") expect(modeOf(join(dir, "telemetry.json"))).toBe(0o600);
      expect(readdirSync(dir)).toEqual(["telemetry.json"]);
    }
  });

  it("keeps an opt-out in a marker file when telemetry.json cannot take it, and reads the marker as off", () => {
    const dir = tmpDir();
    const broken = { on: false };
    const flaky = { ...fs, writeFileSync: (f: string, ...rest: unknown[]) => { if (broken.on && f.includes("telemetry.json")) throw new Error("ENOSPC"); return (fs.writeFileSync as (...a: unknown[]) => void)(f, ...rest); } };
    const s = createState({ dir, fs: flaky, timers });
    s.save();
    broken.on = true;
    s.data.enabled = false;
    s.save();
    expect(existsSync(join(dir, "telemetry-off"))).toBe(true);
    expect(readJson(join(dir, "telemetry.json")).enabled).toBe(true);
    expect(open(dir).data.enabled).toBe(false);

    const on = createState({ dir, fs: flaky, timers });
    on.data.enabled = true;
    on.save();
    expect(existsSync(join(dir, "telemetry-off"))).toBe(true);
    expect(open(dir).data.enabled).toBe(false);
    broken.on = false;
    on.save();
    expect(existsSync(join(dir, "telemetry-off"))).toBe(false);
    expect(open(dir).data.enabled).toBe(true);
  });

  it("writes no marker for a failed save while sharing is on", () => {
    const dir = tmpDir();
    const s = createState({ dir, fs: { ...fs, writeFileSync: () => { throw new Error("EROFS"); } }, timers });
    s.save();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("knows whether a telemetry.json was there, readable or not", () => {
    const dir = tmpDir();
    expect(open(dir).existed).toBe(false);
    writeFileSync(join(dir, "telemetry.json"), "{");
    expect(open(dir).existed).toBe(true);
  });

  it("never throws when the disk will not take a write", () => {
    const s = createState({ dir: tmpDir(), fs: { ...fs, writeFileSync: () => { throw new Error("EROFS"); } }, timers });
    expect(() => s.save()).not.toThrow();
  });
});

describe("writeAtomic", () => {
  it("leaves the whole new file and no temp file, and replaces an old one", () => {
    const dir = tmpDir();
    const file = join(dir, "preferences.json");
    writeAtomic(fs, file, '{"a":1}');
    writeAtomic(fs, file, '{"a":2}');
    expect(readJson(file)).toEqual({ a: 2 });
    expect(readdirSync(dir)).toEqual(["preferences.json"]);
  });
});

describe("localDay", () => {
  it("is the local calendar day, zero padded", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
    expect(localDay(new Date(2026, 11, 31, 0, 0).getTime())).toBe("2026-12-31");
  });
});
