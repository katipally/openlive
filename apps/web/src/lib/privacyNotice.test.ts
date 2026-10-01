import { afterEach, describe, expect, it, vi } from "vitest";
import { noticeOwed } from "./privacyNotice";

const status = (over: Record<string, unknown>) => ({ active: true, enabled: true, noticeSeen: false, installIdTail: "", appVersion: "1.0.0", osName: "macOS", osMajor: "15", ...over });
const bridge = (get: () => unknown) => vi.stubGlobal("window", { openlive: { telemetry: { get } } });

afterEach(() => vi.unstubAllGlobals());

describe("first-run notice", () => {
  it("is owed to a person on a reporting build who has not seen it", async () => {
    bridge(async () => status({}));
    expect(await noticeOwed()).toBe(true);
  });

  it("is not owed once seen, or on a build that never reports", async () => {
    bridge(async () => status({ noticeSeen: true }));
    expect(await noticeOwed()).toBe(false);
    bridge(async () => status({ active: false }));
    expect(await noticeOwed()).toBe(false);
  });

  it("is not owed while sharing is off, seen or not", async () => {
    bridge(async () => status({ enabled: false }));
    expect(await noticeOwed()).toBe(false);
  });

  it("is not owed in a browser tab or when the shell cannot answer", async () => {
    vi.stubGlobal("window", {});
    expect(await noticeOwed()).toBe(false);
    bridge(() => { throw new Error("ipc gone"); });
    expect(await noticeOwed()).toBe(false);
  });
});
