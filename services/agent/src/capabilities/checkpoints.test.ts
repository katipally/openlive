import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Tool } from "./types.js";

// Its own home, so the checkpoints land in a temp cache/.
const dir = mkdtempSync(path.join(tmpdir(), "ol-checkpoints-"));
process.env.OPENLIVE_HOME = path.join(dir, "home");
const { FILE_TOOLS } = await import("./files.js");
const { EDIT_TOOLS, lineDelta, pick, prune, recentEdits, relKey, undoById, wsKey } = await import("./checkpoints.js");
const { dispatch, ToolSet } = await import("./dispatch.js");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// .native, as the file tools resolve it: it also expands Windows short names like RUNNER~1.
const ws = realpathSync.native(mkdtempSync(path.join(dir, "ws-")));
const tool = (n: string): Tool => [...FILE_TOOLS, ...EDIT_TOOLS].find((t) => t.name === n)!;
const ctx = { signal: new AbortController().signal, context: null, callId: "c", workspace: () => ws };
const run = async (n: string, args: Record<string, unknown>) => {
  const t = tool(n);
  await t.precheck?.(args, ctx);
  return t.execute(args, ctx);
};
const read = (rel: string) => readFileSync(path.join(ws, rel), "utf8");
const said = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text).join("");
const store = path.join(dir, "home", "cache", "checkpoints", wsKey(ws));

describe("checkpoints", () => {
  it("keeps the pre-image of a create, an overwrite and an edit, and undoes each in turn", async () => {
    await run("write_file", { path: "notes/a.txt", content: "one\ntwo\n" });
    await run("write_file", { path: "notes/a.txt", content: "one\ntwo\nthree\n" });
    await run("edit_file", { path: "notes/a.txt", find: "two", replace: "TWO" });
    const listed = said(await run("list_edits", {}));
    expect(listed.split("\n")).toHaveLength(3);
    expect(listed).toMatch(/notes\/a\.txt, .*\+1 -1 lines$/m);
    expect(listed).toMatch(/created, \+2 -0 lines/);

    await run("undo_edit", { path: "notes/a.txt" });
    expect(read("notes/a.txt")).toBe("one\ntwo\nthree\n");
    // One pre-image each for the overwrite, the edit and the undo; a create has none.
    expect(readdirSync(path.join(store, "blobs"))).toHaveLength(3);
  });

  it("asks first, naming the file", async () => {
    const t = tool("undo_edit");
    const args = { path: "notes/a.txt" };
    await t.precheck!(args, ctx);
    expect(t.confirm!(args)).toMatch(/^undo the .+ change to notes\/a\.txt$/);
    expect(t.readOnly).toBeFalsy();
    expect(tool("list_edits").readOnly).toBe(true);
  });

  it("refuses when the file changed after the edit, unless forced", async () => {
    await run("write_file", { path: "b.txt", content: "mine" });
    writeFileSync(path.join(ws, "b.txt"), "changed by hand");
    await expect(run("undo_edit", { path: "b.txt" })).rejects.toThrow(/b\.txt changed after that edit/);
    expect(read("b.txt")).toBe("changed by hand");
    await run("undo_edit", { path: "b.txt", force: true });
    expect(existsSync(path.join(ws, "b.txt"))).toBe(false);
  });

  it("undoing the undo redoes, and the latest edit of all is the default", async () => {
    await run("write_file", { path: "c.txt", content: "v1" });
    await run("write_file", { path: "c.txt", content: "v2" });
    const undone = await run("undo_edit", {});
    expect(read("c.txt")).toBe("v1");
    expect(said(undone)).toMatch(/To redo it, undo edit [0-9a-f]{8}\./);
    await run("undo_edit", {});
    expect(read("c.txt")).toBe("v2");
    const byId = /undo edit ([0-9a-f]{8})/.exec(said(undone))![1]!;
    // That undo was itself undone, so its own pre-image no longer matches: refused.
    await expect(run("undo_edit", { id: byId })).rejects.toThrow(/changed after that edit/);
    await expect(run("undo_edit", { id: "nope" })).rejects.toThrow(/No edit has id nope/);
    await expect(run("undo_edit", { path: "../outside" })).rejects.toThrow(/outside the workspace/);
  });

  it("is listed and undone from Settings, across workspaces", async () => {
    const items = await recentEdits(5);
    expect(items[0]).toMatchObject({ root: ws, path: "c.txt", tool: "undo_edit" });
    await run("write_file", { path: "d.txt", content: "x" });
    const latest = (await recentEdits(1))[0]!;
    expect(await undoById(latest.id)).toMatchObject({ tool: "undo_edit", path: "d.txt" });
    expect(existsSync(path.join(ws, "d.txt"))).toBe(false);
    expect(await undoById("missing")).toBeNull();
  });
});

describe("retention and paths", () => {
  const at = (daysAgo: number, now: number) => new Date(now - daysAgo * 86_400_000).toISOString();
  const edit = (id: string, daysAgo: number, bytes: number, now: number, before: string | null = id) =>
    ({ id, path: "a", at: at(daysAgo, now), tool: "write_file" as const, before, after: "h", bytes, added: 0, removed: 0 });
  const NOW = Date.parse("2026-10-01T22:00:00Z");

  it("keeps at most 200 edits, 200 MB of pre-images and 14 days, newest first", () => {
    const many = Array.from({ length: 250 }, (_, i) => edit(`e${i}`, 0, 1, NOW));
    expect(prune(many, NOW).map((e) => e.id)).toEqual(many.slice(50).map((e) => e.id));
    const big = [edit("a", 1, 150 * 1024 * 1024, NOW), edit("b", 0, 100 * 1024 * 1024, NOW)];
    expect(prune(big, NOW).map((e) => e.id)).toEqual(["b"]);
    // A blob two edits share counts once.
    const shared = [edit("a", 1, 150 * 1024 * 1024, NOW, "same"), edit("b", 0, 150 * 1024 * 1024, NOW, "same")];
    expect(prune(shared, NOW)).toHaveLength(2);
    expect(prune([edit("old", 15, 1, NOW), edit("new", 13, 1, NOW)], NOW).map((e) => e.id)).toEqual(["new"]);
  });

  it("deletes the blobs pruned edits leave behind", async () => {
    const before = readdirSync(path.join(store, "blobs")).length;
    const journal = JSON.parse(readFileSync(path.join(store, "journal.json"), "utf8"));
    journal.edits = journal.edits.map((e: { at: string }) => ({ ...e, at: at(30, Date.now()) }));
    writeFileSync(path.join(store, "journal.json"), JSON.stringify(journal));
    expect(before).toBeGreaterThan(0);
    expect(await recentEdits()).toEqual([]);
    expect(existsSync(store)).toBe(false);
  });

  it("compares Windows paths with either slash and any case", () => {
    expect(relKey("Sub\\A.TXT", "win32")).toBe("sub/a.txt");
    expect(relKey("Sub/A.txt", "darwin")).toBe("sub/a.txt");
    expect(relKey("Sub/A.txt", "linux")).toBe("Sub/A.txt");
    expect(relKey("a\\b", "linux")).toBe("a\\b");
    expect(wsKey("C:\\Work\\Proj", "win32")).toBe(wsKey("c:\\work\\proj", "win32"));
    expect(wsKey("/Work", "linux")).not.toBe(wsKey("/work", "linux"));
    const edits = [edit("x", 0, 1, NOW), { ...edit("y", 0, 1, NOW), path: "sub/a.txt" }];
    expect(pick(edits, { rel: "Sub\\A.TXT" }, "win32").id).toBe("y");
    expect(() => pick(edits, { rel: "Sub\\A.TXT" }, "linux")).toThrow(/No edit to/);
  });

  it("counts lines added and removed", () => {
    expect(lineDelta("", "a\nb\n")).toEqual({ added: 2, removed: 0 });
    expect(lineDelta("a\nb\nc", "a\nB\nc\nd")).toEqual({ added: 2, removed: 1 });
    expect(lineDelta("x\r\ny", "x\ny")).toEqual({ added: 0, removed: 0 });
  });
});

describe("through dispatch", () => {
  it("runs precheck before the question, so a refused undo is never asked about", async () => {
    await run("write_file", { path: "e.txt", content: "1" });
    writeFileSync(path.join(ws, "e.txt"), "2");
    const asked: string[] = [];
    const gen = dispatch([{ id: "u", name: "undo_edit", args: { path: "e.txt" } }], new ToolSet([tool("undo_edit")]), ctx,
      { approve: async ({ tool: t, args }) => { asked.push(t.confirm!(args)); return {}; } });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    expect(asked).toEqual([]);
    expect(r.value[0]).toMatchObject({ isError: true });
  });
});

describe("Flow's fence", () => {
  // Flow: relative paths start in its own folder, the tools reach all of home, and edits are kept against home.
  const home = realpathSync.native(mkdtempSync(path.join(dir, "home-")));
  const own = path.join(home, ".openlive", "workspace");
  const flow = { signal: new AbortController().signal, context: null, callId: "c", workspace: () => own, fence: () => home };
  const go = async (n: string, args: Record<string, unknown>) => { const t = tool(n); await t.precheck?.(args, flow); return t.execute(args, flow); };

  it("writes relative paths in its folder and full or ~ paths anywhere in home, and undoes either", async () => {
    await go("write_file", { path: "new.txt", content: "a" });
    expect(readFileSync(path.join(own, "new.txt"), "utf8")).toBe("a");
    await go("write_file", { path: path.join(home, "Documents", "b.txt"), content: "b" });
    await go("edit_file", { path: "~/Documents/b.txt", find: "b", replace: "B" });
    expect(readFileSync(path.join(home, "Documents", "b.txt"), "utf8")).toBe("B");
    expect(said(await go("list_edits", {}))).toMatch(/Documents\/b\.txt.*\n.*Documents\/b\.txt.*\n.*\.openlive\/workspace\/new\.txt/);
    await go("undo_edit", { path: "~/Documents/b.txt" });
    expect(readFileSync(path.join(home, "Documents", "b.txt"), "utf8")).toBe("b");
    await go("undo_edit", { path: "new.txt" });
    expect(existsSync(path.join(own, "new.txt"))).toBe(false);
  });

  it("refuses anything outside home", async () => {
    await expect(go("read_file", { path: path.join(dir, "elsewhere.txt") })).rejects.toThrow(/outside your home folder/);
    await expect(go("read_file", { path: "../../../x" })).rejects.toThrow(/outside your home folder/);
  });
});
