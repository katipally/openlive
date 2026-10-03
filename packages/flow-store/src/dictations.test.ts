import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { addDictation, clearDictations, deleteDictation, DICTATION_CAP, dictationsPath, readDictations } from "./dictations";
import { KEEP_MS } from "./shared";

const dir = mkdtempSync(join(tmpdir(), "flow-dictations-"));
beforeAll(() => { process.env.OPENLIVE_FLOW_HOME = dir; });
afterAll(() => { delete process.env.OPENLIVE_FLOW_HOME; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => clearDictations());

const said = (final: string) => ({ raw: final, cleaned: final, final });
const lines = () => readFileSync(dictationsPath(), "utf8").split("\n").filter(Boolean).length;

test("dictations read back newest first, under the OpenLive home", () => {
  addDictation(said("first"), "week", 1000);
  addDictation({ ...said("second"), app: "Slack" }, "week", 2000);
  expect(dictationsPath().startsWith(dir)).toBe(true);
  expect(readDictations("week", 3000).map((d) => [d.final, d.app])).toEqual([["second", "Slack"], ["first", undefined]]);
});

test("history off keeps nothing new, and drops what was kept", () => {
  addDictation(said("kept"), "week", 1000);
  expect(addDictation(said("not kept"), "off")).toBeNull();
  expect(readDictations("off", 2000)).toEqual([]);
  expect(readDictations("forever", 2000)).toEqual([]);
});

test("retention prunes what is older than it keeps, and rewrites the file once most of it is dead", () => {
  const now = 100 * KEEP_MS.day;
  addDictation(said("two days old"), "forever", now - 2 * KEEP_MS.day);
  addDictation(said("three days old"), "forever", now - 3 * KEEP_MS.day);
  addDictation(said("an hour old"), "forever", now - 3_600_000);
  expect(readDictations("day", now).map((d) => d.final)).toEqual(["an hour old"]);
  expect(lines()).toBe(1);
  expect(readDictations("forever", now).map((d) => d.final)).toEqual(["an hour old"]);
});

test("a deletion is one appended line, and a later read leaves only what is kept", () => {
  const a = addDictation(said("a"), "week", 1000)!;
  addDictation(said("b"), "week", 2000);
  deleteDictation(a.id);
  expect(readDictations("week", 3000).map((d) => d.final)).toEqual(["b"]);
});

test("the store holds at most the cap, oldest dropped first", () => {
  for (let i = 0; i < DICTATION_CAP + 5; i++) addDictation(said(`n${i}`), "forever", i);
  const kept = readDictations("forever", DICTATION_CAP + 10);
  expect(kept).toHaveLength(DICTATION_CAP);
  expect(kept.at(-1)!.final).toBe("n5");
});
