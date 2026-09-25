// The claim this file exists to keep honest: history costs a page, not an
// archive. Filenames sort chronologically, so recency needs no stat and no
// open; only the listed page is read, and search is capped by its own scan
// rather than by how much the person has ever said.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { listSessions, loadSession, searchSessions } from "./history";
import { sessionsDir } from "./paths";

const COUNT = 20_000;
const dir = mkdtempSync(join(tmpdir(), "flow-scale-"));
beforeAll(() => { process.env.OPENLIVE_FLOW_HOME = dir; });
afterAll(() => { delete process.env.OPENLIVE_FLOW_HOME; rmSync(dir, { recursive: true, force: true }); });

test("an empty store lists nothing rather than failing", () => {
  expect(listSessions()).toEqual([]);
  expect(searchSessions("anything")).toEqual([]);
  expect(loadSession("nothing")).toBeNull();
});

// Writing twenty thousand files takes ~3 s idle, past the 5 s default under a full parallel run.
test("twenty thousand sessions still cost one page", () => {
  mkdirSync(sessionsDir(), { recursive: true });
  // One of them is a forty-minute session, so the bounded head read is exercised
  // against a file far longer than the window it is given.
  const long = "and then I said ".repeat(4000);
  for (let i = 0; i < COUNT; i++) {
    const at = new Date(Date.UTC(2026, i % 9, 1 + (i % 28), i % 24, i % 60, i % 60)).toISOString();
    const stamp = at.replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
    writeFileSync(join(sessionsDir(), `${stamp}_id${i}.jsonl`),
      `${JSON.stringify({ v: 1, kind: "header", id: `id${i}`, createdAt: at })}\n` +
      `${JSON.stringify({ id: "a", parentId: null, seq: 0, timestamp: at, type: "message", role: "user", text: i === 7 ? `${long}needle` : "hi" })}\n`);
  }

  const listedAt = Date.now();
  expect(listSessions(40)).toHaveLength(40);
  const listMs = Date.now() - listedAt;

  const searchedAt = Date.now();
  expect(searchSessions("needle", 40).length).toBeLessThanOrEqual(40);
  const searchMs = Date.now() - searchedAt;

  // Generous by two orders of magnitude: this fails when someone starts opening
  // every file, not when a machine is slow.
  expect(listMs).toBeLessThan(2000);
  expect(searchMs).toBeLessThan(4000);
}, 20_000);
