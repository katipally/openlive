import { describe, expect, it } from "vitest";
import { BLUETOOTH_WAIT_MS, UNKNOWN_WAIT_MS, WIRED_WAIT_MS, holdVerdict, micWaitMs } from "./holdLive";

describe("micWaitMs", () => {
  it("waits longest for Bluetooth", () => {
    for (const l of ["AirPods Pro", "Bluetooth Headset", "WH-1000XM5", "Jabra Elite"]) expect(micWaitMs(l)).toBe(BLUETOOTH_WAIT_MS);
  });
  it("waits least for built-in and wired", () => {
    for (const l of ["MacBook Pro Microphone", "Built-in Microphone", "USB Audio Device", "Internal Mic"]) expect(micWaitMs(l)).toBe(WIRED_WAIT_MS);
  });
  it("gives an unknown or empty label the middle wait", () => {
    expect(micWaitMs("")).toBe(UNKNOWN_WAIT_MS);
    expect(micWaitMs("Yeti X")).toBe(UNKNOWN_WAIT_MS);
  });
  it("reads Bluetooth first when a name says both", () => {
    expect(micWaitMs("Bluetooth USB Dongle")).toBe(BLUETOOTH_WAIT_MS);
  });
});

describe("holdVerdict", () => {
  it("is live once a frame with sound came, however late", () => {
    expect(holdVerdict("Built-in Microphone", 9999, true)).toBe("live");
  });
  it("waits until the device's wait is up", () => {
    expect(holdVerdict("Built-in Microphone", WIRED_WAIT_MS - 1, false)).toBe("waiting");
    expect(holdVerdict("Built-in Microphone", WIRED_WAIT_MS, false)).toBe("silent");
    expect(holdVerdict("AirPods", WIRED_WAIT_MS, false)).toBe("waiting");
    expect(holdVerdict("AirPods", BLUETOOTH_WAIT_MS, false)).toBe("silent");
  });
});
