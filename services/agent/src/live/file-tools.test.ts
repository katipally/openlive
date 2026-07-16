// confine() is the security fence for the built-in assistant's file tools — it MUST
// keep every path inside the user's chosen workspace. If it leaks, the voice
// assistant could read or overwrite arbitrary files.
import assert from "node:assert";
import path from "node:path";
import { test } from "vitest";
import { confine } from "./file-tools.ts";

const root = "/home/u/proj";
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
