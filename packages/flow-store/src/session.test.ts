import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { entryChain, readSession } from "./jsonl";
import { FlowSession, readSessionState, resolveAsset } from "./session";
import { flowDir, sessionsDir } from "./paths";

const dir = mkdtempSync(join(tmpdir(), "flow-session-"));
beforeAll(() => { process.env.OPENLIVE_FLOW_HOME = dir; });
afterAll(() => { delete process.env.OPENLIVE_FLOW_HOME; rmSync(dir, { recursive: true, force: true }); });

const DEAD_PID = 0x7fffffff;

test("open, append, archive round-trips through the file", async () => {
  const s = await FlowSession.open({ title: "first" });
  expect(s.path.startsWith(sessionsDir())).toBe(true);
  await s.append("message", { role: "user", text: "hello" });
  await s.append("tool_call", { name: "insert_text" });
  expect(readSessionState(s.path)).toBe("active");
  await s.archive();
  expect(readSessionState(s.path)).toBe("archived");

  const { header, entries } = readSession(s.path);
  expect(header?.title).toBe("first");
  expect(entries.map((e) => e.type)).toEqual(["session_state", "message", "tool_call", "session_state"]);
  expect(entries.every((e, i) => e.seq === i)).toBe(true);
  expect(entries[0]!.parentId).toBeNull();            // session_state is not a tip
  expect(entries[1]!.parentId).toBeNull();            // the first message roots the tree
  expect(entries[2]!.parentId).toBe(entries[1]!.id); // parented into a tree
});

test("archive is idempotent", async () => {
  const s = await FlowSession.open();
  await s.archive();
  await s.archive();
  expect(readSession(s.path).entries.filter((e) => e.state === "archived")).toHaveLength(1);
});

test("resume continues from a chosen tip and branches", async () => {
  const s = await FlowSession.open();
  const a = await s.append("message", { role: "user", text: "a" });
  await s.append("message", { role: "assistant", text: "b" });
  await s.archive();

  const branched = await FlowSession.resume(s.path, a.id);
  const c = await branched.append("message", { role: "assistant", text: "c" });
  expect(c.parentId).toBe(a.id);
  expect(c.seq).toBeGreaterThan(4);
  const { entries } = readSession(s.path);
  expect(entryChain(entries, c.id).map((e) => e.text)).toEqual(["a", "c"]);
  await branched.archive();

  const tail = await FlowSession.resume(s.path);
  expect(tail.tip).toBe(c.id); // the last entry that was not a state marker
  await tail.archive();
});

test("a session left active by a dead owner reads as a crash", async () => {
  const s = await FlowSession.open();
  await s.append("message", { role: "user", text: "mid-sentence" });
  // Another process opened this session and was killed before it could archive.
  await s.append("session_state", { state: "active", pid: DEAD_PID, processStartId: "gone" });
  expect(readSessionState(s.path)).toBe("crash");

  const resumed = await FlowSession.resume(s.path);
  expect(readSessionState(s.path)).toBe("active");
  await resumed.archive();
  expect(readSessionState(s.path)).toBe("archived");
});

test("assets live beside the log, never inside it", async () => {
  const s = await FlowSession.open();
  const rel = s.writeAsset("shot.png", Buffer.from([1, 2, 3]));
  expect(rel).toBe(`assets/${s.id}/shot.png`);
  await s.append("tool_result", { name: "screenshot", asset: rel });
  expect(readFileSync(s.path, "utf8")).not.toContain("\u0001\u0002\u0003");
  expect(Array.from(s.readAsset(rel))).toEqual([1, 2, 3]);
  expect(s.writeAsset("../../escape.png", "x")).toBe(`assets/${s.id}/escape.png`);
  expect(() => resolveAsset("../../../etc/passwd")).toThrow(/escapes/);
  expect(resolveAsset(rel).startsWith(flowDir())).toBe(true);
  await s.archive();
});

test("the idle window archives the session and hands control back", async () => {
  let rolled = 0;
  const s = await FlowSession.open({ idleMs: 20, onIdle: () => { rolled++; } });
  await new Promise((r) => setTimeout(r, 10));
  await s.append("message", { role: "user", text: "still talking" }); // resets the window
  await new Promise((r) => setTimeout(r, 15));
  expect(readSessionState(s.path)).toBe("active");
  await new Promise((r) => setTimeout(r, 60));
  expect(rolled).toBe(1);
  expect(readSessionState(s.path)).toBe("archived");
});
