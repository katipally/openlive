import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { classifyPrevExit } = createRequire(import.meta.url)("./prev-exit.cjs");

const BOOT = 1_000_000;
const base = { pids: [11, 12], alive: () => false, writtenAtMs: BOOT + 5000, bootAtMs: BOOT };

describe("classifyPrevExit", () => {
  it("is clean when the pid file is empty or missing", () => {
    expect(classifyPrevExit({ ...base, pids: [] })).toBe("clean");
  });

  it("is an OS restart when the file is older than the boot, even if a pid is reused", () => {
    expect(classifyPrevExit({ ...base, writtenAtMs: BOOT - 1 })).toBe("os_restart");
    expect(classifyPrevExit({ ...base, writtenAtMs: BOOT - 1, alive: () => true })).toBe("os_restart");
  });

  it("is killed when a server of the last run still runs", () => {
    expect(classifyPrevExit({ ...base, alive: (pid: number) => pid === 12 })).toBe("killed");
  });

  it("is unknown when every pid is gone and the machine did not restart", () => {
    expect(classifyPrevExit(base)).toBe("unknown");
  });

  it("counts a file written at the boot instant as after it", () => {
    expect(classifyPrevExit({ ...base, writtenAtMs: BOOT })).toBe("unknown");
  });
});
