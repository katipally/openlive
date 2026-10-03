import { describe, expect, it } from "vitest";
import { fromLocalStorage } from "./migrateLocal";
import type { Fields, Saved } from "./persist";

/** Run the migration over a fake localStorage and a fake ui.json. */
const run = (ls: Record<string, string>, file: Saved = {}) =>
  fromLocalStorage(Object.keys(ls), (k) => ls[k] ?? null, (g): Fields => file[g] ?? {});

const OLD = {
  "openlive-mode": "flow",
  "openlive-capabilities-tab": "skills",
  "ol-sessions-filter": "openlive",
  "ol-transcript-open": "0",
  "ol-transcript-w": "420",
  "openlive:disclosure": JSON.stringify({ "adv:voice": true, "hist:ws:/x": true, bad: "yes" }),
  "openlive-pipeline-v1": JSON.stringify({ language: "fr" }),
  "openlive-voice-input": "toggle",
  "openlive-ptt-enabled": "1",
  "openlive-bind:c1": "claude",
  "openlive-cwd:c1": "/code/app",
  "openlive-resume:c2": "sess-9",
  "openlive-recent-folders": JSON.stringify(["/code/app", 7, "/b"]),
  "openlive-meta:claude": JSON.stringify({ models: [], modes: [] }),
  "openlive-model:claude": "opus",
  "openlive-mode:claude": "plan",
  "openlive-opt:claude:effort": "high",
  "openlive-welcomed": "1",
  "openlive-flow-onboarded": "access",
  "openlive-tour-home": "1",
  "openlive-tour-flow": "1",
};

describe("fromLocalStorage", () => {
  it("moves every old key into its group and field, and removes them all", () => {
    const { patch, remove } = run({ ...OLD, "openlive-models-ready-v1": "wasm:tiny", "openlive-debug": "tts", "someone-else": "x" });
    expect(patch).toEqual({
      ui: { mode: "flow", capabilitiesTab: "skills", sessionsFilter: "openlive", transcriptOpen: false, transcriptWidth: 420 },
      disclosure: { "adv:voice": true },
      voice: { pipeline: { language: "fr" }, pttEnabled: true },
      sessions: {
        "chat:c1": { bind: "claude", cwd: "/code/app" },
        "chat:c2": { resume: "sess-9" },
        recentFolders: ["/code/app", "/b"],
        "agent:claude": { meta: { models: [], modes: [] }, model: "opus", mode: "plan", opts: { effort: "high" } },
      },
      onboarding: { welcomed: true, flowOnboarded: "access", tours: ["flow", "home"] },
    });
    expect(remove.sort()).toEqual(Object.keys(OLD).sort());
  });

  it("keeps the model cache flag, the debug switch and keys that are not OpenLive's", () => {
    const { patch, remove } = run({ "openlive-models-ready-v1": "wasm:tiny", "takt-live-models-ready-v1": "wasm", "openlive-debug": "tts", other: "1" });
    expect(patch).toEqual({});
    expect(remove).toEqual([]);
  });

  it("drops garbage values but still removes their keys", () => {
    const { patch, remove } = run({
      "openlive-mode": "banana", "openlive-capabilities-tab": "nope", "ol-transcript-w": "9000", "openlive-pipeline-v1": "{not json",
      "openlive:disclosure": "[1,2]", "openlive-recent-folders": "\"str\"", "openlive-meta:claude": "null", "openlive-bind:c1": "",
      "openlive-opt:claude": "x", "openlive-voice-input": "sideways", "openlive-flow-onboarded": "",
    });
    expect(patch).toEqual({});
    expect(remove).toHaveLength(11);
  });

  it("never overwrites what the file already has, field by field", () => {
    const file = {
      ui: { mode: "dictate" },
      sessions: { "chat:c1": { bind: "codex" }, "agent:claude": { opts: { effort: "low" } } },
      onboarding: { tours: ["chat"] },
    };
    const { patch, remove } = run(OLD, file);
    expect(patch.ui?.mode).toBeUndefined();
    expect(patch.ui?.capabilitiesTab).toBe("skills");
    expect(patch.sessions?.["chat:c1"]).toEqual({ bind: "codex", cwd: "/code/app" });
    expect((patch.sessions?.["agent:claude"] as Fields).opts).toEqual({ effort: "low" });
    expect(patch.onboarding?.tours).toBeUndefined();
    expect(remove).toContain("openlive-mode");
  });

  it("is idempotent: a second run over the result adds nothing", () => {
    const first = run(OLD);
    expect(run(OLD, first.patch).patch).toEqual({});
  });

  it("tells an agent's mode from the app's mode", () => {
    const { patch } = run({ "openlive-mode": "chat", "openlive-mode:codex": "auto" });
    expect(patch).toEqual({ ui: { mode: "chat" }, sessions: { "agent:codex": { mode: "auto" } } });
  });
});
