import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { deleteSession, listAssets, listSessions, loadSession, renameSession, searchSessions, sessionPath } from "./history";
import { FlowSession } from "./session";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "flow-history-"));
beforeAll(() => { process.env.OPENLIVE_FLOW_HOME = dir; });
afterAll(() => { delete process.env.OPENLIVE_FLOW_HOME; rmSync(dir, { recursive: true, force: true }); });

test("an empty store lists nothing", () => {
  expect(listSessions()).toEqual([]);
  expect(searchSessions("anything")).toEqual([]);
  expect(loadSession("nope")).toBeNull();
  expect(listAssets("nope")).toEqual([]);
});

test("sessions list newest first, bounded by the limit", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    await sleep(2); // filenames carry millisecond stamps; same-ms ties order arbitrarily
    const s = await FlowSession.open({ title: `session ${i}` });
    await s.append("message", { role: "user", text: i === 3 ? "rename the branch" : `body ${i}` });
    await s.archive();
    ids.push(s.id);
  }
  const all = listSessions();
  expect(all).toHaveLength(12);
  expect(all[0]!.id).toBe(ids[11]);
  expect(all[0]!.title).toBe("session 11");
  expect(all[0]!.state).toBe("archived");
  expect(all[0]!.assetsDir).toContain(ids[11]!);
  expect(listSessions(3).map((s) => s.id)).toEqual(all.slice(0, 3).map((s) => s.id));
  expect(listSessions(3, 3).map((s) => s.id)).toEqual(all.slice(3, 6).map((s) => s.id));
  expect(listSessions(3, 12)).toEqual([]);
});

test("search matches content and is bounded by its scan cap", async () => {
  const hits = searchSessions("rename the branch");
  expect(hits).toHaveLength(1);
  expect(hits[0]!.title).toBe("session 3");
  expect(searchSessions("RENAME THE BRANCH")).toHaveLength(1);
  expect(searchSessions("nothing matches this")).toEqual([]);
  expect(searchSessions("body 0")).toHaveLength(1);
  expect(searchSessions("body 0", 60, 2)).toHaveLength(0); // never looked past the two newest
  expect(searchSessions("   ").length).toBe(listSessions().length);
  const bodies = searchSessions("body");
  expect(searchSessions("body", 2, undefined, 2).map((s) => s.id)).toEqual(bodies.slice(2, 4).map((s) => s.id));
});

test("loading a session brings its assets with it", async () => {
  const s = await FlowSession.open({ title: "with assets" });
  const rel = s.writeAsset("frame.bin", Buffer.from([7, 7, 7]));
  await s.append("tool_result", { name: "screenshot", asset: rel });
  await s.archive();

  const loaded = loadSession(s.id);
  expect(loaded?.header?.title).toBe("with assets");
  expect(loaded?.truncated).toBe(false);
  expect(loaded?.entries.some((e) => e.asset === rel)).toBe(true);
  expect(loaded?.assets).toEqual([{ name: "frame.bin", path: join(dir, "flow", "assets", s.id, "frame.bin"), bytes: 3 }]);
});

test("a live session reports as active", async () => {
  await sleep(2);
  const s = await FlowSession.open({ title: "live" });
  expect(listSessions(1)[0]!.state).toBe("active");
  await s.archive();
});

test("a session can be found by id and removed with everything captured for it", async () => {
  const s = await FlowSession.open({ meta: { mode: "flow" } });
  await s.append("message", { role: "user", text: "delete me" });
  s.writeAsset("screen.png", Buffer.from("not really a png"));
  await s.archive();

  expect(sessionPath(s.id)).toBe(s.path);
  expect(sessionPath("no-such-session")).toBe("");
  expect(listAssets(s.id).map((a) => a.name)).toEqual(["screen.png"]);

  expect(deleteSession(s.id)).toBe(true);
  expect(sessionPath(s.id)).toBe("");
  expect(listAssets(s.id)).toEqual([]);
  expect(loadSession(s.id)).toBeNull();
  expect(deleteSession(s.id)).toBe(false); // deleting what is already gone is not an error
});

test("a session can be renamed, and cleared back to what was said", async () => {
  await sleep(2);
  const s = await FlowSession.open({ meta: { mode: "flow" } });
  await s.append("message", { role: "user", text: "what was said" });
  expect(renameSession(s.id, "while live")).toBe(false); // its owner may still append
  await s.archive();

  expect(renameSession(s.id, "  A better name  ")).toBe(true);
  const listed = listSessions(1)[0]!;
  expect(listed.id).toBe(s.id);
  expect(listed.title).toBe("A better name");
  const loaded = loadSession(s.id)!;
  expect(loaded.header?.mode).toBe("flow");
  expect(loaded.entries.map((e) => e.type)).toEqual(["session_state", "message", "session_state"]);
  expect(loaded.truncated).toBe(false);

  expect(renameSession(s.id, "")).toBe(true);
  expect(listSessions(1)[0]!.title).toBe("what was said");
  expect(renameSession("no-such-session", "x")).toBe(false);
  deleteSession(s.id);
});
