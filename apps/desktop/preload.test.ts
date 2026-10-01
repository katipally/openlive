import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { DAY_1, rig } from "./telemetry/rig";

const require = createRequire(import.meta.url);
const electron = require.resolve("electron");
const preload = require.resolve("./preload.cjs");

/** preload.cjs run against a stand-in for electron: what it exposes, and what it sends. */
function load() {
  const calls: { send: unknown[][]; invoke: unknown[][] } = { send: [], invoke: [] };
  const fake = {
    send: vi.fn((...args: unknown[]) => void calls.send.push(args)),
    invoke: vi.fn(async (...args: unknown[]) => void calls.invoke.push(args)),
  };
  const on = vi.fn();
  let exposed: any;
  require.cache[electron] = {
    id: electron, filename: electron, loaded: true, children: [], paths: [], path: "",
    exports: {
      contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => (exposed = api) },
      ipcRenderer: { ...fake, sendSync: vi.fn(), on, removeAllListeners: vi.fn(), removeListener: vi.fn() },
    },
  } as unknown as NodeJS.Module;
  delete require.cache[preload];
  require(preload);
  return { api: exposed, calls, fake, on };
}

afterEach(() => {
  vi.useRealTimers();
  delete require.cache[electron];
  delete require.cache[preload];
});

describe("window.openlive.telemetry", () => {
  it("is exactly the contract's members", () => {
    expect(Object.keys(load().api.telemetry).sort()).toEqual(["count", "fact", "feedbackAnswer", "feedbackNext", "get", "noticeShown", "set", "setFeedback", "track"]);
  });

  it("sends one-way messages in the shapes main's handler reads", () => {
    const { api, calls } = load();
    api.telemetry.track("lobby_blocked", { gap: "no_mic" });
    api.telemetry.fact("flow_owner", { stops: 1 });
    api.telemetry.count("n_palette_open");
    api.telemetry.noticeShown();
    expect(calls.send).toEqual([
      ["openlive:telemetry", { t: "track", name: "lobby_blocked", props: { gap: "no_mic" } }],
      ["openlive:telemetry", { t: "fact", scope: "flow_owner", props: { stops: 1 } }],
      ["openlive:telemetry", { t: "count", key: "n_palette_open" }],
      ["openlive:telemetry", { t: "notice" }],
    ]);
  });

  it("reports a prompt's answer over the one-way channel, and never lets a page name the route", () => {
    const { api, calls } = load();
    api.telemetry.feedbackAnswer({ outcome: "answered", rating: "down", reason: "too_slow", t: "track" });
    expect(calls.send).toEqual([["openlive:telemetry", { outcome: "answered", rating: "down", reason: "too_slow", t: "feedback" }]]);
  });

  it("asks main for the next prompt and sets don't ask again over invoke", async () => {
    const { api, calls } = load();
    await api.telemetry.feedbackNext();
    await api.telemetry.setFeedback(false);
    expect(calls.invoke).toEqual([["openlive:telemetry-feedback-next"], ["openlive:telemetry-feedback-allow", false]]);
  });

  it("asks main for status and consent over invoke", async () => {
    const { api, calls } = load();
    await api.telemetry.get();
    await api.telemetry.set(false, "settings");
    expect(calls.invoke).toEqual([
      ["openlive:telemetry-get"],
      ["openlive:telemetry-set", false, "settings"],
    ]);
  });

  it("never throws into the page when a payload will not clone", () => {
    const { api, fake } = load();
    fake.send.mockImplementation(() => { throw new Error("An object could not be cloned."); });
    expect(() => api.telemetry.track("lobby_blocked", { gap: () => 1 })).not.toThrow();
    expect(() => api.telemetry.fact("flow_owner", undefined)).not.toThrow();
    expect(() => api.telemetry.count("n_palette_open")).not.toThrow();
    expect(() => api.telemetry.noticeShown()).not.toThrow();
  });

  it("feeds the real telemetry handler: notice, event, fact and counter all land", () => {
    vi.useFakeTimers({ now: DAY_1 });
    const r = rig();
    r.telemetry.start({ launchKind: "manual" });
    const { api, fake } = load();
    fake.send.mockImplementation((channel: string, msg: unknown) => {
      if (channel === "openlive:telemetry") r.telemetry.handleRendererMessage(msg);
    });
    api.telemetry.track("lobby_blocked", { gap: "no_mic" });
    expect(r.queue().map((q) => q.n)).toEqual([]);
    api.telemetry.noticeShown();
    api.telemetry.count("n_palette_open");
    r.telemetry.openFlow();
    api.telemetry.fact("flow_owner", { stops: 2 });
    r.telemetry.onQuit("tray_menu");
    expect(r.queue().map((q) => q.n)).toEqual(["app_first_open", "lobby_blocked", "flow_session", "feature_usage", "app_quit"]);
    expect(r.queue().find((q) => q.n === "flow_session")!.p.stops).toBe(2);
  });
});

describe("window.openlive.endOnLock", () => {
  it("reads with nothing and sets with a boolean, both over the one channel", async () => {
    const { api, calls } = load();
    await api.endOnLock();
    await api.endOnLock(false);
    expect(calls.invoke).toEqual([["openlive:end-on-lock", undefined], ["openlive:end-on-lock", false]]);
  });
});

describe("window.openlive.flow", () => {
  it("sends the close reason, and nothing that is not a string", () => {
    const { api, calls } = load();
    api.flow.dismiss("idle");
    api.flow.dismiss();
    api.flow.dismiss({ reason: "idle" });
    expect(calls.send).toEqual([
      ["openlive:flow-dismiss", "idle"],
      ["openlive:flow-dismiss", undefined],
      ["openlive:flow-dismiss", undefined],
    ]);
  });

  it("sends where a permission was asked from, and stays compatible with a bare request", async () => {
    const { api, calls } = load();
    await api.flow.request("accessibility", "onboarding");
    await api.flow.request("microphone");
    await api.flow.request("screen", { from: "x" });
    expect(calls.invoke).toEqual([
      ["openlive:flow-request", "accessibility", "onboarding"],
      ["openlive:flow-request", "microphone", undefined],
      ["openlive:flow-request", "screen", undefined],
    ]);
  });

  it("tells the owner whether Flow was open when the tray asked for a new session", () => {
    const { api, on } = load();
    const seen: boolean[] = [];
    api.flow.onNewSession((wasOpen: boolean) => seen.push(wasOpen));
    const handler = on.mock.calls.find(([channel]) => channel === "openlive:flow-new-session")![1];
    handler({}, true);
    handler({}, false);
    handler({});
    expect(seen).toEqual([true, false, false]);
  });
});
