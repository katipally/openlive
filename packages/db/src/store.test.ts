import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, expect, test } from "vitest";

// DATA_DIR is resolved at import time, so point it at a temp dir BEFORE the
// store module loads.
const dir = mkdtempSync(join(tmpdir(), "openlive-store-"));
process.env.OPENLIVE_DATA_DIR = dir;
let store: typeof import("./store");

beforeAll(async () => { store = await import("./store"); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("updateJson holds the lock across the whole read-modify-write cycle", async () => {
  // Each update reads, then yields (simulating the gap where the other process
  // used to sneak in), then writes. Without the lock every call would read 0
  // and the final count would be 1 — with it, all 20 increments land.
  const N = 20;
  await Promise.all(Array.from({ length: N }, () =>
    store.updateJson<{ n: number }>("counter.json", { n: 0 }, async (cur) => {
      await new Promise((r) => setTimeout(r, 1));
      return { n: cur.n + 1 };
    }),
  ));
  expect(store.readJson<{ n: number }>("counter.json", { n: 0 }).n).toBe(N);
});

test("updateJson releases the lock on fn throw", async () => {
  await expect(store.updateJson("counter.json", {}, () => { throw new Error("boom"); })).rejects.toThrow("boom");
  // Lock must be free again — a follow-up update succeeds promptly.
  await store.updateJson<{ n: number }>("counter.json", { n: 0 }, (c) => ({ n: c.n + 1 }));
  expect(store.readJson<{ n: number }>("counter.json", { n: 0 }).n).toBe(21);
});
