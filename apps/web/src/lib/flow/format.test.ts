// The extremes matter more than the middle here: a three-second turn and a
// forty-minute one are drawn by the same code, next to each other, in a column
// sized once.
import assert from "node:assert";
import { test } from "vitest";
import { duration } from "./format.ts";

test("durations read as minutes and seconds, and grow an hour when they need one", () => {
  assert.equal(duration(0), "0:00");
  assert.equal(duration(900), "0:01");
  assert.equal(duration(9_000), "0:09");
  assert.equal(duration(40 * 60_000), "40:00");
  assert.equal(duration(3_903_000), "1:05:03");
  assert.equal(duration(-5), "0:00"); // a clock that went backwards is not a negative turn
});
