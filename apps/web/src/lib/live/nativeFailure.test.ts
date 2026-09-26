import assert from "node:assert";
import { test } from "vitest";
import { failureIsLasting, notDownloaded } from "./nativeFailure.ts";

const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

test("failureIsLasting: not installed, a bad request, a missing profile, or no agent latches the fallback", () => {
  assert.equal(failureIsLasting(http(409)), true);
  assert.equal(failureIsLasting(http(404)), true);
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

test("notDownloaded: only the agent's not-installed answer, never a real failure", () => {
  assert.equal(notDownloaded(http(409)), true);
  for (const e of [http(400), http(404), http(500), http(502), new TypeError("Failed to fetch"), null]) assert.equal(notDownloaded(e), false);
});
