import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type Where = "owner" | "main" | null;
const { talkBindings, pttRouter } = createRequire(import.meta.url)("./talk.cjs") as {
  talkBindings: (cfg: unknown, platform: string) => { flow: string; dictate: string | null; ptt: string | null };
  pttRouter: () => (kind: string, s: { orbUp: boolean; callLive: boolean }) => Where;
};

describe("the keys main registers", () => {
  it("are Control and either Option by default, with no push-to-talk key while hands-free", () => {
    expect(talkBindings({ dictate: { enabled: true }, talk: { mode: "handsFree" } }, "darwin")).toEqual({ flow: "ctrl", dictate: "option", ptt: null });
  });

  it("leave Dictate's key off while Dictate is", () => {
    expect(talkBindings({ dictate: { enabled: false }, talk: { dictateKey: "f20" } }, "linux").dictate).toBeNull();
  });

  it("add the push-to-talk key in push to talk, Fn on a Mac and Right Ctrl elsewhere unless one was picked", () => {
    expect(talkBindings({ talk: { mode: "ptt" } }, "darwin").ptt).toBe("fn");
    expect(talkBindings({ talk: { mode: "ptt" } }, "win32").ptt).toBe("ctrl_right");
    expect(talkBindings({ talk: { mode: "ptt", pttKey: "f18" } }, "linux").ptt).toBe("f18");
  });

  it("read a file from before talk was kept, or an undecided mode, as hands-free on the old keys", () => {
    for (const cfg of [{ version: 8, dictate: { enabled: true, hotkey: "option_right" } }, { talk: { mode: null }, dictate: { enabled: true } }]) {
      expect(talkBindings(cfg, "darwin")).toEqual({ flow: "ctrl", dictate: "option", ptt: null });
    }
    expect(talkBindings(null, "linux")).toEqual({ flow: "ctrl", dictate: null, ptt: null });
  });

  it("follow the keys picked", () => {
    expect(talkBindings({ dictate: { enabled: true }, talk: { flowKey: "ctrl_left", dictateKey: "option_left" } }, "win32")).toEqual({ flow: "ctrl_left", dictate: "option_left", ptt: null });
  });
});

describe("where a push-to-talk hold goes", () => {
  const up = { orbUp: true, callLive: false };
  const call = { orbUp: false, callLive: true };
  const none = { orbUp: false, callLive: false };

  it("is the orb while Flow or Dictate is open, even with a call live", () => {
    const route = pttRouter();
    expect(route("hold_start", { orbUp: true, callLive: true })).toBe("owner");
    expect(route("hold_end", { orbUp: true, callLive: true })).toBe("owner");
  });

  it("is the call with nothing open, and nowhere with no call either", () => {
    const route = pttRouter();
    expect(route("hold_start", call)).toBe("main");
    expect(route("hold_cancel", call)).toBe("main");
    expect(route("hold_start", none)).toBeNull();
    expect(route("hold_end", none)).toBeNull();
  });

  it("ends where it started, even when the orb closed or opened mid-hold", () => {
    const route = pttRouter();
    expect(route("hold_start", up)).toBe("owner");
    expect(route("hold_end", call)).toBe("owner");
    expect(route("hold_start", none)).toBeNull();
    expect(route("hold_end", up)).toBeNull();
    expect(route("hold_start", call)).toBe("main");
    expect(route("hold_cancel", up)).toBe("main");
  });

  it("forgets a hold once it has ended, so a stray end goes nowhere", () => {
    const route = pttRouter();
    route("hold_start", up);
    route("hold_end", up);
    expect(route("hold_end", up)).toBeNull();
  });
});
