// confine() is the security fence for the built-in assistant's file tools — it MUST
// keep every path inside the user's chosen workspace. If it leaks, the voice
// assistant could read or overwrite arbitrary files.
import assert from "node:assert";
import path from "node:path";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "vitest";
import { confine } from "./files.ts";

// Platform-portable fake root: /home/u/proj on POSIX, <drive>:\home\u\proj on
// Windows — a hardcoded POSIX string made every startsWith comparison fail there.
const root = path.resolve(path.sep, "home", "u", "proj");
const inside = (rel: string) => assert.ok(confine(root, rel)?.startsWith(root), `should allow: ${rel}`);
const blocked = (rel: string) => assert.strictEqual(confine(root, rel), null, `should block: ${rel}`);

test("allows the root itself and anything nested under it", () => {
  inside("");
  inside(".");
  inside("src");
  inside("src/live/session.ts");
  inside("a/../b"); // normalizes to /home/u/proj/b — still inside
  assert.strictEqual(confine(root, "src"), path.join(root, "src"));
});

test("blocks anything that escapes the root", () => {
  blocked("..");
  blocked("../secrets");
  blocked("../../etc/passwd");
  blocked("/etc/passwd");       // absolute path elsewhere
  blocked("src/../../outside"); // climbs out via a nested ..
  assert.strictEqual(confine("", "anything"), null); // no workspace set → nothing allowed
});

test("a sibling folder sharing a name prefix must NOT count as inside", () => {
  blocked("../proj-evil/x");
});

test("a symlink inside the workspace pointing outside is refused", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "ol-confine-"));
  try {
    const ws = path.join(tmp, "workspace");
    const outsideDir = path.join(tmp, "outside");
    mkdirSync(ws); mkdirSync(outsideDir);
    writeFileSync(path.join(outsideDir, "secret.txt"), "s");
    symlinkSync(outsideDir, path.join(ws, "link"));           // dir symlink → out
    symlinkSync(path.join(outsideDir, "secret.txt"), path.join(ws, "file-link")); // file symlink → out
    assert.strictEqual(confine(ws, "link/secret.txt"), null, "read through an escaping dir symlink");
    assert.strictEqual(confine(ws, "link/new.txt"), null, "write through an escaping dir symlink");
    assert.strictEqual(confine(ws, "file-link"), null, "escaping file symlink");
    // Sanity: real files inside still pass, including not-yet-existing write targets.
    writeFileSync(path.join(ws, "ok.txt"), "x");
    assert.strictEqual(confine(ws, "ok.txt"), path.join(realpathSync.native(ws), "ok.txt"));
    assert.ok(confine(ws, "new-dir/new.txt"));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("the file tools read inside the workspace and refuse without one", async () => {
  const { FILE_TOOLS } = await import("./files.ts");
  const tool = (n: string) => FILE_TOOLS.find((t) => t.name === n)!;
  const tmp = mkdtempSync(path.join(tmpdir(), "ol-files-"));
  try {
    writeFileSync(path.join(tmp, "a.txt"), "hello");
    const ctx = (ws: string) => ({ signal: new AbortController().signal, context: null, callId: "c", workspace: () => ws });
    const read = await tool("read_file").execute({ path: "a.txt" }, ctx(tmp));
    assert.deepStrictEqual(read.content, [{ type: "text", text: "hello" }]);
    await assert.rejects(tool("read_file").execute({ path: "a.txt" }, ctx("")), /No workspace folder/);
    await assert.rejects(tool("read_file").execute({ path: "../x" }, ctx(tmp)), /outside the workspace/);
    await tool("edit_file").execute({ path: "a.txt", find: "hello", replace: "bye" }, ctx(tmp));
    assert.deepStrictEqual((await tool("read_file").execute({ path: "a.txt" }, ctx(tmp))).content, [{ type: "text", text: "bye" }]);
    assert.strictEqual(tool("write_file").available!({}), false);
    assert.strictEqual(tool("write_file").available!({ workspace: () => "" }), true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
