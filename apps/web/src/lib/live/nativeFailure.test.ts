import assert from "node:assert";
import { test } from "vitest";
import { failureIsLasting } from "./nativeFailure.ts";

const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

test("failureIsLasting: not installed, a bad request, or no agent latches the fallback", () => {
  assert.equal(failureIsLasting(http(409)), true);
  assert.equal(failureIsLasting(http(400)), true);
  assert.equal(failureIsLasting(http(502)), true);
});

test("failureIsLasting: timeouts, server errors and network blips are retried next call", () => {
  assert.equal(failureIsLasting(http(500)), false);
  assert.equal(failureIsLasting(http(504)), false);
  assert.equal(failureIsLasting(new DOMException("timed out", "TimeoutError")), false);
  assert.equal(failureIsLasting(new TypeError("Failed to fetch")), false);
  assert.equal(failureIsLasting(null), false);
  assert.equal(failureIsLasting(undefined), false);
});
