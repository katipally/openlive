import { describe, expect, it } from "vitest";
import { DEFAULT_FLOW_CONFIG, parseFlowConfig } from "@openlive/flow-store";
import { flowBrain } from "@openlive/flow-store/shared";
import { DEFAULT_PIPELINE_CONFIG, TURN_PRESETS, activeTurnPreset, turnPresetOf, withWait } from "../live/pipelineConfig";
import { effectiveWait, settleTurnOverride } from "./wait";

const preset = (id: string) => TURN_PRESETS.find((p) => p.id === id)!.values;
const chatOn = (id: string) => withWait(DEFAULT_PIPELINE_CONFIG, preset(id));
const flow = (voice: Record<string, unknown>, version = 7) => parseFlowConfig({ version, voice });

describe("wait before answering", () => {
  it("names the presets Patient, Even and Quick, on the numbers Relaxed, Balanced and Snappy had", () => {
    expect(TURN_PRESETS.map((p) => p.name)).toEqual(["Patient", "Even", "Quick"]);
    expect(preset("patient")).toEqual({ redemptionMs: 800, threshold: 0.65, holdMs: 6000 });
    expect(preset("even")).toEqual({ redemptionMs: 550, threshold: 0.5, holdMs: 4000 });
    expect(preset("quick")).toEqual({ redemptionMs: 350, threshold: 0.35, holdMs: 2500 });
    // Chat's stored defaults were Balanced, which is Even.
    expect(activeTurnPreset(DEFAULT_PIPELINE_CONFIG)).toBe("even");
    expect(turnPresetOf({ redemptionMs: 600, threshold: 0.5, holdMs: 4000 })).toBe("custom");
  });

  it("chat always waits the shared way, whatever Flow keeps for itself", () => {
    const own = flow({ turnOverride: true, turn: preset("patient") });
    expect(effectiveWait("chat", chatOn("quick"), own)).toEqual(preset("quick"));
  });

  it("flow follows the shared wait while its override is off", () => {
    const off = flow({ turnOverride: false, turn: preset("patient") });
    expect(effectiveWait("flow", chatOn("quick"), off)).toEqual(preset("quick"));
    expect(effectiveWait("flow", chatOn("even"), parseFlowConfig({}))).toEqual(preset("even"));
    expect(effectiveWait("flow", chatOn("quick"), null)).toEqual(preset("quick"));
  });

  it("flow keeps its own wait while its override is on, or not yet decided", () => {
    expect(effectiveWait("flow", chatOn("quick"), flow({ turnOverride: true, turn: preset("patient") }))).toEqual(preset("patient"));
    expect(effectiveWait("flow", chatOn("quick"), flow({ turnOverride: null, turn: preset("patient") }))).toEqual(preset("patient"));
  });
});

describe("migrating a Flow from before the wait was shared", () => {
  it("turns the override on when Flow already waited differently from Chat", () => {
    const old = flow({ turn: preset("patient") }, 6);
    expect(old.voice.turnOverride).toBeNull();
    expect(settleTurnOverride(old, chatOn("even"))).toBe(true);
    // A hand-tuned Chat wait is a different wait too.
    expect(settleTurnOverride(old, withWait(DEFAULT_PIPELINE_CONFIG, { redemptionMs: 800, threshold: 0.6, holdMs: 6000 }))).toBe(true);
  });

  it("leaves it off when the two already matched, so Flow follows Chat from now on", () => {
    expect(settleTurnOverride(flow({ turn: preset("quick") }, 6), chatOn("quick"))).toBe(false);
  });

  it("never revisits a decided override", () => {
    expect(settleTurnOverride(flow({ turnOverride: false, turn: preset("patient") }), chatOn("even"))).toBeNull();
    expect(settleTurnOverride(flow({ turnOverride: true, turn: preset("even") }), chatOn("even"))).toBeNull();
    expect(settleTurnOverride(DEFAULT_FLOW_CONFIG, chatOn("quick"))).toBeNull();
  });

  it("keeps a v6 coding agent brain as Flow's own, and a v6 API brain as the default's", () => {
    const agent = parseFlowConfig({ version: 6, brain: { kind: "acp", agentId: "codex" } });
    expect(flowBrain(agent, {})).toMatchObject({ kind: "acp", agentId: "codex" });
    expect(flowBrain(parseFlowConfig({ version: 6, brain: { kind: "api", agentId: "codex" } }), {}).kind).toBe("api");
  });
});
