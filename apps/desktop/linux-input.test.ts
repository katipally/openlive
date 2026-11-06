import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { classify } = createRequire(import.meta.url)("./linux-input.cjs");

const INPUT = 104;
const denied = { gid: INPUT, error: "EACCES" };
const state = (over = {}) => ({ sandboxed: false, devices: [denied, denied], processGroups: [1000], memberOf: () => false, ...over });

describe("why Flow cannot read /dev/input on Linux", () => {
  it("is fine as soon as one device opens", () => {
    expect(classify(state({ devices: [denied, { gid: INPUT, error: null }] }))).toBe("ok");
  });

  it("names a user outside the input group", () => {
    expect(classify(state())).toBe("not_in_group");
    expect(classify(state({ devices: [{ gid: INPUT, error: "EPERM" }] }))).toBe("not_in_group");
  });

  it("tells a group that was added after this login session began", () => {
    expect(classify(state({ memberOf: (gid: number) => gid === INPUT }))).toBe("needs_relogin");
  });

  it("finds no devices, and does not blame the group for that", () => {
    expect(classify(state({ devices: [] }))).toBe("no_devices");
  });

  it("blames the sandbox before the group", () => {
    expect(classify(state({ sandboxed: true }))).toBe("sandboxed");
    expect(classify(state({ sandboxed: true, devices: [] }))).toBe("sandboxed");
  });

  it("leaves what it cannot tell as other", () => {
    expect(classify(state({ devices: [{ gid: INPUT, error: "EIO" }] }))).toBe("other");
    // Already in the device's group in this session, yet refused: the group is not the cause.
    expect(classify(state({ processGroups: [1000, INPUT] }))).toBe("other");
  });
});
