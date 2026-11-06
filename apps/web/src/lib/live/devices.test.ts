import { expect, it } from "vitest";
import { deviceOptions, pickedDevice, withDefault } from "./devices";

const dev = (kind: "audioinput" | "audiooutput", deviceId: string, label = "") => ({ kind, deviceId, label });

it("numbers a device whose label is hidden until mic access is granted", () => {
  const devs = [dev("audioinput", "a"), dev("audiooutput", "s"), dev("audioinput", "b", "USB Mic")];
  expect(deviceOptions(devs, "audioinput")).toEqual([{ id: "a", label: "Microphone 1" }, { id: "b", label: "USB Mic" }]);
  expect(deviceOptions(devs, "audiooutput")).toEqual([{ id: "s", label: "Speaker 1" }]);
});

it("offers the system default first and drops Chromium's duplicate entries", () => {
  const opts = withDefault(deviceOptions([dev("audioinput", "default", "Default - Mic"), dev("audioinput", "communications", "Comms"), dev("audioinput", "a", "Mic")], "audioinput"));
  expect(opts).toEqual([{ id: "", label: "System default" }, { id: "a", label: "Mic" }]);
  expect(withDefault([])).toEqual([{ id: "", label: "System default" }]);
});

it("falls back to the system default when the saved device is gone", () => {
  const opts = withDefault([{ id: "a", label: "Mic" }]);
  expect(pickedDevice(opts, "a")).toBe("a");
  expect(pickedDevice(opts, "unplugged")).toBe("");
  expect(pickedDevice(opts, "")).toBe("");
});
