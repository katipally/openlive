import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { addDictation, clearDictations, deleteDictation, DICTATION_CAP, dictationsPath, readDictations } from "./dictations";
import { KEEP_MS } from "./shared";

const dir = mkdtempSync(join(tmpdir(), "flow-dictations-"));
beforeAll(() => { process.env.OPENLIVE_FLOW_HOME = dir; });
afterAll(() => { delete process.env.OPENLIVE_FLOW_HOME; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => clearDictations());

const said = (final: string) => ({ raw: final, cleaned: final, final });
const disk = () => (existsSync(dictationsPath()) ? readFileSync(dictationsPath(), "utf8") : "");
const lines = () => disk().split("\n").filter(Boolean).length;

test("dictations read back newest first, under the OpenLive home", async () => {
  await addDictation(said("first"), "week", 1000);
  await addDictation({ ...said("second"), app: "Slack" }, "week", 2000);
  expect(dictationsPath().startsWith(dir)).toBe(true);
  expect((await readDictations("week", 3000)).map((d) => [d.final, d.app])).toEqual([["second", "Slack"], ["first", undefined]]);
});

test("history off keeps nothing new, and removes what was kept from disk", async () => {
  await addDictation(said("kept"), "week", 1000);
  expect(await addDictation(said("not kept"), "off")).toBeNull();
  expect(await readDictations("off", 2000)).toEqual([]);
  expect(existsSync(dictationsPath())).toBe(false);
  expect(await readDictations("forever", 2000)).toEqual([]);
});

test("retention removes what is older than it keeps from disk on the read that finds it", async () => {
  const now = 100 * KEEP_MS.day;
  await addDictation(said("two days old"), "forever", now - 2 * KEEP_MS.day);
  await addDictation(said("an hour old"), "forever", now - 3_600_000);
  expect((await readDictations("day", now)).map((d) => d.final)).toEqual(["an hour old"]);
  expect(lines()).toBe(1);
  expect(disk()).not.toContain("two days old");
});

test("a delete removes the dictation from disk at once, and leaves the rest as they were", async () => {
  const a = (await addDictation(said("secret a"), "week", 1000))!;
  await addDictation(said("b"), "week", 2000);
  await deleteDictation(a.id);
  expect(disk()).not.toContain("secret a");
  expect(lines()).toBe(1);
  expect((await readDictations("week", 3000)).map((d) => d.final)).toEqual(["b"]);
  await deleteDictation("no such id");
  expect(lines()).toBe(1);
});

test("Clear all removes the file", async () => {
  await addDictation(said("gone"), "week", 1000);
  await clearDictations();
  expect(existsSync(dictationsPath())).toBe(false);
});

test("an append rewrites nothing, and a read rewrites only when something is to go", async () => {
  await addDictation(said("a"), "forever", 1000);
  const before = disk();
  await addDictation(said("b"), "forever", 2000);
  expect(disk().startsWith(before)).toBe(true);
  await readDictations("forever", 3000);
  expect(lines()).toBe(2);
});

test("the store holds at most the cap, oldest dropped first, and from disk a batch at a time", async () => {
  for (let i = 0; i < DICTATION_CAP + 5; i++) await addDictation(said(`n${i}`), "forever", i);
  const kept = await readDictations("forever", DICTATION_CAP + 10);
  expect(kept).toHaveLength(DICTATION_CAP);
  expect(kept.at(-1)!.final).toBe("n5");
  expect(lines()).toBe(DICTATION_CAP + 5);
  for (let i = 0; i < 100; i++) await addDictation(said(`m${i}`), "forever", DICTATION_CAP + 20 + i);
  await readDictations("forever", DICTATION_CAP + 200);
  expect(lines()).toBe(DICTATION_CAP);
});

test("a crash mid-append or mid-rewrite loses nothing kept, and what it left behind is removed", async () => {
  await addDictation(said("safe"), "forever", 1000);
  // A torn last line, and a half-written temp from a rewrite that never renamed.
  appendFileSync(dictationsPath(), '{"id":"torn","at":2000,"fi');
  const temp = `${dictationsPath()}.99999.tmp`;
  writeFileSync(temp, '{"id":"x","at":1,"raw":"half","clean');
  expect((await readDictations("forever", 3000)).map((d) => d.final)).toEqual(["safe"]);
  expect(disk()).not.toContain("torn");
  expect(existsSync(temp)).toBe(false);
  expect(readdirSync(dirname(dictationsPath())).filter((n) => n.endsWith(".tmp"))).toEqual([]);
});

test("an older file's deletion lines still delete, and the rewrite drops them", async () => {
  const a = (await addDictation(said("old delete"), "forever", 1000))!;
  appendFileSync(dictationsPath(), `${JSON.stringify({ id: a.id, deleted: true })}\n`);
  expect(await readDictations("forever", 2000)).toEqual([]);
  expect(existsSync(dictationsPath())).toBe(false);
});

test("an append during a rewrite waits for it and is kept", async () => {
  const a = (await addDictation(said("a"), "forever", 1000))!;
  await addDictation(said("b"), "forever", 2000);
  const del = deleteDictation(a.id);
  const add = addDictation(said("c"), "forever", 3000);
  await Promise.all([del, add]);
  expect((await readDictations("forever", 4000)).map((d) => d.final)).toEqual(["c", "b"]);
});

test("another process holding the file holds off appends and rewrites until it lets go", async () => {
  const a = (await addDictation(said("a"), "forever", 1000))!;
  const release = await lockfile.lock(dictationsPath(), { realpath: false });
  let done = false;
  const writes = Promise.all([addDictation(said("b"), "forever", 2000), deleteDictation(a.id)]).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 60));
  expect(done).toBe(false);
  expect(lines()).toBe(1);
  await release();
  await writes;
  expect((await readDictations("forever", 3000)).map((d) => d.final)).toEqual(["b"]);
});
