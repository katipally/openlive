import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ui = vi.hoisted(() => ({ liveOpen: false, mode: "chat" }));
vi.mock("@/lib/uiStore", () => ({ useUi: { getState: () => ui } }));

type Handler = (e: unknown) => void;
let handlers: Record<string, Handler>;
let track: ReturnType<typeof vi.fn>;
let mod: typeof import("./rendererError");

const load = async (path: string) => {
  handlers = {};
  track = vi.fn();
  vi.stubGlobal("window", {
    location: { pathname: path },
    addEventListener: (t: string, h: Handler) => { handlers[t] = h; },
    removeEventListener: (t: string) => { delete handlers[t]; },
    openlive: { telemetry: { track } },
  });
  vi.resetModules();
  mod = await import("./rendererError");
  return mod.watchRendererErrors();
};

beforeEach(() => { vi.useFakeTimers(); ui.liveOpen = false; ui.mode = "chat"; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("renderer errors", () => {
  it("reports an uncaught error and a rejection by kind, and never their text", async () => {
    await load("/");
    handlers.error!({ error: new Error("secret words"), message: "secret words" });
    handlers.unhandledrejection!({ reason: new Error("more secret words") });
    expect(track.mock.calls).toEqual([
      ["renderer_error", { surface: "main", kind: "uncaught", during: "other" }],
      ["renderer_error", { surface: "main", kind: "unhandled_rejection", during: "other" }],
    ]);
    expect(JSON.stringify(track.mock.calls)).not.toContain("secret");
  });

  it("ignores aborts, and error events that carry no error", async () => {
    await load("/");
    handlers.error!({ error: null, message: "ResizeObserver loop completed" });
    handlers.error!({ error: Object.assign(new Error("x"), { name: "AbortError" }) });
    handlers.unhandledrejection!({ reason: new DOMException("cancelled", "AbortError") });
    handlers.unhandledrejection!({ reason: undefined });
    expect(track).toHaveBeenCalledOnce();
    expect(track.mock.calls[0]![1].kind).toBe("unhandled_rejection");
  });

  it("says where the person was: a call, Flow in the main window, or the Flow owner", async () => {
    await load("/");
    ui.liveOpen = true;
    mod.trackRendererError("render_crash");
    expect(track.mock.calls[0]![1]).toEqual({ surface: "main", kind: "render_crash", during: "call" });
    ui.liveOpen = false; ui.mode = "flow";
    mod.trackRendererError("uncaught");
    expect(track.mock.calls[1]![1].during).toBe("flow");
    await load("/flow-owner");
    mod.trackRendererError("uncaught");
    expect(track.mock.calls[0]![1]).toEqual({ surface: "owner", kind: "uncaught", during: "flow" });
  });

  it("stays silent in the orb window", async () => {
    await load("/flow");
    mod.trackRendererError("uncaught");
    expect(track).not.toHaveBeenCalled();
  });

  it("sends a kind once per ten minutes, and again after", async () => {
    await load("/");
    for (let i = 0; i < 50; i++) mod.trackRendererError("uncaught");
    expect(track).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10 * 60_000);
    mod.trackRendererError("uncaught");
    expect(track).toHaveBeenCalledTimes(2);
  });

  it("stops listening when told to", async () => {
    const stop = await load("/");
    stop();
    expect(handlers).toEqual({});
  });
});
