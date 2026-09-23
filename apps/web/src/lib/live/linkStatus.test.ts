import { describe, expect, it } from "vitest";
import { MAX_BACKOFF_MS, reconnectDelay } from "./linkStatus";

describe("reconnect backoff", () => {
  it("doubles from 300 ms", () => {
    expect([0, 1, 2, 3, 4].map(reconnectDelay)).toEqual([300, 600, 1200, 2400, 4800]);
  });
  it("caps, and stays capped however long the outage runs", () => {
    expect(reconnectDelay(6)).toBe(MAX_BACKOFF_MS);
    expect(reconnectDelay(1000)).toBe(MAX_BACKOFF_MS);
    expect(Number.isFinite(reconnectDelay(1e9))).toBe(true);
  });
});
