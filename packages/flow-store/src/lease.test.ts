import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { acquireLease, isOwnerLive, isProcessAlive, readLease, selfProcessStartId } from "./lease";
import { ensureDir, flowDir, leasePath } from "./paths";

const dir = mkdtempSync(join(tmpdir(), "flow-lease-"));
beforeAll(() => { process.env.OPENLIVE_FLOW_HOME = dir; ensureDir(flowDir()); });
afterAll(() => { delete process.env.OPENLIVE_FLOW_HOME; rmSync(dir, { recursive: true, force: true }); });

const DEAD_PID = 0x7fffffff; // far above any live pid on a test machine

test("a live owner keeps the lease, a second acquire is refused", async () => {
  const first = await acquireLease("/sessions/a.jsonl");
  expect(first).not.toBeNull();
  expect(readLease()?.sessionPath).toBe("/sessions/a.jsonl");
  expect(await acquireLease("/sessions/b.jsonl")).toBeNull();
  await first!.release();
  expect(readLease()).toBeNull();
});

test("release is idempotent and never throws", async () => {
  const lease = await acquireLease("/sessions/c.jsonl");
  await lease!.release();
  await lease!.release();
  const other = await acquireLease("/sessions/d.jsonl");
  expect(other).not.toBeNull();
  await other!.release();
});

test("a dead owner is reclaimed, and release does not steal the new owner's lease", async () => {
  const stale = { version: 1, token: "stale", pid: DEAD_PID, processStartId: "whenever", sessionPath: "/sessions/old.jsonl", createdAt: new Date(0).toISOString() };
  writeFileSync(leasePath(), JSON.stringify(stale));
  const lease = await acquireLease("/sessions/new.jsonl");
  expect(lease).not.toBeNull();
  expect(JSON.parse(readFileSync(leasePath(), "utf8")).sessionPath).toBe("/sessions/new.jsonl");

  const { releaseLease } = await import("./lease");
  await releaseLease(stale); // the evicted owner waking up late
  expect(readLease()?.token).toBe(lease!.owner.token);
  await lease!.release();
});

test("staleness is a liveness probe, not a timestamp", () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(isProcessAlive(DEAD_PID)).toBe(false);
  // Ancient record, live process, matching run: still the owner.
  expect(isOwnerLive({ pid: process.pid, processStartId: selfProcessStartId() })).toBe(true);
  // Same pid, different run: pid reuse must not read as ownership.
  if (selfProcessStartId()) expect(isOwnerLive({ pid: process.pid, processStartId: "a different run" })).toBe(false);
  expect(isOwnerLive({ pid: DEAD_PID, processStartId: null })).toBe(false);
});
