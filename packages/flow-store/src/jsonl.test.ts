import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { appendEntry, entryChain, fileStamp, parseSession, readSession, sessionFileName, sessionIdFromFileName, tailEntries, writeHeader } from "./jsonl";
import { SESSION_FORMAT_VERSION, type SessionEntry } from "./types";

const dir = mkdtempSync(join(tmpdir(), "flow-jsonl-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const entry = (id: string, parentId: string | null, seq: number, extra: Record<string, unknown> = {}): SessionEntry =>
  ({ id, parentId, seq, timestamp: new Date(seq).toISOString(), type: "message", ...extra });

test("filenames sort chronologically and round-trip the id", () => {
  const early = sessionFileName("a", new Date("2026-01-02T03:04:05.006Z"));
  const late = sessionFileName("b", new Date("2026-09-21T00:00:00.000Z"));
  expect(early < late).toBe(true);
  expect(sessionIdFromFileName(late)).toBe("b");
  expect(sessionIdFromFileName("config.json")).toBeNull();
  expect(fileStamp(new Date("2026-01-02T03:04:05.006Z"))).toBe("20260102T030405006Z");
});

test("header plus entries round-trip", async () => {
  const path = join(dir, "round.jsonl");
  await writeHeader(path, { v: SESSION_FORMAT_VERSION, kind: "header", id: "s", createdAt: "now", title: "hi" });
  await appendEntry(path, entry("e1", null, 0, { text: "one" }));
  await appendEntry(path, entry("e2", "e1", 1, { text: "two" }));
  const { header, entries, truncated } = readSession(path);
  expect(header?.id).toBe("s");
  expect(header?.title).toBe("hi");
  expect(entries.map((e) => e.text)).toEqual(["one", "two"]);
  expect(truncated).toBe(false);
});

test("torn trailing record is discarded, the good entries survive", () => {
  const path = join(dir, "torn.jsonl");
  writeFileSync(path, "");
  appendFileSync(path, `${JSON.stringify({ v: 1, kind: "header", id: "s", createdAt: "now" })}\n`);
  appendFileSync(path, `${JSON.stringify(entry("e1", null, 0, { text: "kept" }))}\n`);
  appendFileSync(path, JSON.stringify(entry("e2", "e1", 1, { text: "lost" })).slice(0, 40)); // crash mid-append
  const { header, entries, truncated } = readSession(path);
  expect(header?.id).toBe("s");
  expect(entries.map((e) => e.text)).toEqual(["kept"]);
  expect(truncated).toBe(true);
});

test("a bounded read always drops its last line", async () => {
  const path = join(dir, "bounded.jsonl");
  await writeHeader(path, { v: 1, kind: "header", id: "s", createdAt: "now" });
  for (let i = 0; i < 50; i++) await appendEntry(path, entry(`e${i}`, i ? `e${i - 1}` : null, i, { text: "x".repeat(200) }));
  const full = readSession(path);
  const head = readSession(path, 2048);
  expect(head.entries.length).toBeGreaterThan(0);
  expect(head.entries.length).toBeLessThan(full.entries.length);
  expect(head.truncated).toBe(true);
});

test("tailEntries reads the end without the whole file", async () => {
  const path = join(dir, "tail.jsonl");
  await writeHeader(path, { v: 1, kind: "header", id: "s", createdAt: "now" });
  for (let i = 0; i < 50; i++) await appendEntry(path, entry(`e${i}`, i ? `e${i - 1}` : null, i, { text: "y".repeat(200) }));
  const tail = tailEntries(path, 2048);
  expect(tail.length).toBeGreaterThan(0);
  expect(tail[tail.length - 1]!.id).toBe("e49");
});

test("appends from concurrent callers never interleave", async () => {
  const path = join(dir, "concurrent.jsonl");
  await writeHeader(path, { v: 1, kind: "header", id: "s", createdAt: "now" });
  await Promise.all(Array.from({ length: 100 }, (_, i) => appendEntry(path, entry(`e${i}`, null, i))));
  const { entries } = readSession(path);
  expect(entries).toHaveLength(100);
  expect(new Set(entries.map((e) => e.id)).size).toBe(100);
});

test("entryChain walks a branch back to its root", () => {
  const entries = [entry("a", null, 0), entry("b", "a", 1), entry("c", "a", 2), entry("d", "c", 3)];
  expect(entryChain(entries, "d").map((e) => e.id)).toEqual(["a", "c", "d"]);
  expect(entryChain(entries, "b").map((e) => e.id)).toEqual(["a", "b"]);
  expect(entryChain(entries, "missing")).toEqual([]);
});

test("garbage lines are skipped, not fatal", () => {
  const { header, entries } = parseSession(`${JSON.stringify({ kind: "header", id: "s", createdAt: "" })}\nnot json\n${JSON.stringify(entry("e1", null, 0))}\n`);
  expect(header?.id).toBe("s");
  expect(entries.map((e) => e.id)).toEqual(["e1"]);
});
