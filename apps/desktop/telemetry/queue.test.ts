import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { modeOf, readLines, tmpDir } from "./rig";

const { createQueue } = createRequire(import.meta.url)("./queue.cjs");

const rec = (n: string, extra: Record<string, unknown> = {}) => ({ n, p: { action: "open", ...extra }, t: "2026-09-29T12:00:00.000Z" });
const open = (dir: string, caps = {}) => createQueue({ dir, fs, ...caps });
const names = (q: { peek(): { rec: { n: string } } | undefined; ack(i: unknown): void; size(): number }) => {
  const out: string[] = [];
  while (q.size()) {
    const item = q.peek()!;
    out.push(item.rec.n);
    q.ack(item);
  }
  return out;
};

describe("queue", () => {
  it("keeps events in order, on disk, mode 0600", () => {
    const dir = tmpDir();
    const q = open(dir);
    q.append(rec("a"));
    q.append(rec("b"));
    expect(readLines(q.file).map((r) => r.n)).toEqual(["a", "b"]);
    if (process.platform !== "win32") expect(modeOf(q.file)).toBe(0o600);
    expect(q.size()).toBe(2);
    expect(q.peek().rec.n).toBe("a");
  });

  it("survives a restart", () => {
    const dir = tmpDir();
    const q = open(dir);
    q.append(rec("a"));
    q.append(rec("b"));
    expect(names(open(dir))).toEqual(["a", "b"]);
  });

  it("removes only what was acknowledged, and only the oldest", () => {
    const dir = tmpDir();
    const q = open(dir);
    q.append(rec("a"));
    q.append(rec("b"));
    const a = q.peek();
    q.ack(a);
    expect(readLines(q.file).map((r) => r.n)).toEqual(["b"]);
    q.ack(a);
    expect(q.size()).toBe(1);
    q.ack(undefined);
    expect(q.size()).toBe(1);
  });

  it("deletes the file when the last event is acknowledged", () => {
    const q = open(tmpDir());
    q.append(rec("a"));
    q.ack(q.peek());
    expect(existsSync(q.file)).toBe(false);
  });

  it("ignores an acknowledgement for an event a clear already removed", () => {
    const q = open(tmpDir());
    q.append(rec("a"));
    const stale = q.peek();
    q.clear();
    q.append(rec("b"));
    q.ack(stale);
    expect(q.peek().rec.n).toBe("b");
  });

  it("ignores a torn last line and cleans the file", () => {
    const dir = tmpDir();
    const q = open(dir);
    q.append(rec("a"));
    appendFileSync(q.file, '{"n":"b","p":{"acti');
    const reopened = open(dir);
    expect(reopened.size()).toBe(1);
    reopened.append(rec("c"));
    expect(readFileSync(q.file, "utf8").endsWith("\n")).toBe(true);
    expect(names(open(dir))).toEqual(["a", "c"]);
  });

  it("skips lines that are not our records", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "telemetry-queue.jsonl"), `${JSON.stringify(rec("a"))}\nnot json\n[1,2]\n{"n":5,"p":{},"t":"x"}\n${JSON.stringify(rec("z"))}\n`);
    expect(names(open(dir))).toEqual(["a", "z"]);
  });

  it("drops the oldest first past the event cap", () => {
    const q = open(tmpDir(), { maxEvents: 10 });
    for (let i = 0; i < 100; i++) q.append(rec(`e${i}`));
    expect(q.size()).toBeLessThanOrEqual(10);
    expect(q.size()).toBeGreaterThan(5);
    const kept = names(q);
    expect(kept.at(-1)).toBe("e99");
    expect(kept).not.toContain("e0");
    expect(kept).toEqual([...kept].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
  });

  it("drops the oldest first past the byte cap, and refuses one event bigger than the cap", () => {
    const q = open(tmpDir(), { maxBytes: 2000 });
    for (let i = 0; i < 50; i++) q.append(rec(`e${i}`, { pad: "x".repeat(100) }));
    expect(readFileSync(q.file, "utf8").length).toBeLessThanOrEqual(2000);
    expect(names(q).at(-1)).toBe("e49");
    q.append(rec("huge", { pad: "x".repeat(5000) }));
    expect(q.size()).toBe(0);
  });

  it("trims a file left over the cap, by an older build or by hand", () => {
    const dir = tmpDir();
    const big = open(dir, { maxEvents: 1000 });
    for (let i = 0; i < 40; i++) big.append(rec(`e${i}`));
    const small = open(dir, { maxEvents: 20 });
    expect(small.size()).toBeLessThanOrEqual(20);
    expect(readLines(small.file)).toHaveLength(small.size());
  });

  it("clear removes the file, and clearing nothing is fine", () => {
    const q = open(tmpDir());
    q.clear();
    q.append(rec("a"));
    q.clear();
    expect(existsSync(q.file)).toBe(false);
    expect(q.size()).toBe(0);
  });

  it("never throws when the disk will not take a write", () => {
    const broken = { ...fs, appendFileSync: () => { throw new Error("ENOSPC"); }, writeFileSync: () => { throw new Error("ENOSPC"); } };
    const q = createQueue({ dir: tmpDir(), fs: broken });
    expect(() => { q.append(rec("a")); q.ack(q.peek()); q.clear(); }).not.toThrow();
  });
});
