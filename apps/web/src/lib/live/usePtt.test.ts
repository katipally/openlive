import { describe, expect, it, vi } from "vitest";
import { listenPtt } from "./usePtt";

/** A stand-in for the preload's onPtt: `fire` is main sending one edge. */
function bridge() {
  let cb: ((kind: string) => void) | null = null;
  const off = vi.fn(() => { cb = null; });
  return { onPtt: (f: (kind: string) => void) => { cb = f; return off; }, fire: (kind: string) => cb?.(kind), off };
}

describe("the global push-to-talk key in a call", () => {
  const handlers = () => ({ pttDown: vi.fn(), pttUp: vi.fn(), pttCancel: vi.fn() });

  it("holds, releases and cancels in push to talk", () => {
    const b = bridge(), h = handlers();
    listenPtt(b.onPtt, () => "ptt", h);
    b.fire("hold_start");
    b.fire("hold_end");
    b.fire("hold_start");
    b.fire("hold_cancel");
    expect(h.pttDown).toHaveBeenCalledTimes(2);
    expect(h.pttUp).toHaveBeenCalledTimes(1);
    expect(h.pttCancel).toHaveBeenCalledTimes(1);
  });

  it("starts nothing hands-free, yet still ends a hold the mode changed under", () => {
    const b = bridge(), h = handlers();
    let mode: "ptt" | "handsFree" = "ptt";
    listenPtt(b.onPtt, () => mode, h);
    b.fire("hold_start");
    mode = "handsFree";
    b.fire("hold_end");
    b.fire("hold_start");
    expect(h.pttDown).toHaveBeenCalledTimes(1);
    expect(h.pttUp).toHaveBeenCalledTimes(1);
  });

  it("listens to nothing without the desktop bridge, and lets go when the call ends", () => {
    const h = handlers();
    expect(() => listenPtt(undefined, () => "ptt", h)()).not.toThrow();
    const b = bridge();
    listenPtt(b.onPtt, () => "ptt", h)();
    expect(b.off).toHaveBeenCalled();
    b.fire("hold_start");
    expect(h.pttDown).not.toHaveBeenCalled();
  });
});
