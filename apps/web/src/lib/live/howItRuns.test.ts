import { describe, expect, it } from "vitest";
import { agentSummary, apiSummary, optLabel, switchValues } from "./howItRuns";

const v = (...pairs: [string, string][]) => pairs.map(([id, name]) => ({ id, name }));
const EFFORT = v(["default", "Default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Xhigh"], ["max", "Max"]);
const FAST = v(["off", "Off"], ["on", "On"]);

describe("switchValues", () => {
  it("reads an on/off pair whichever words and order the agent uses", () => {
    expect(switchValues(FAST)).toEqual({ on: "on", off: "off" });
    expect(switchValues(v(["true", "Enabled"], ["false", "Disabled"]))).toEqual({ on: "true", off: "false" });
    expect(switchValues(v(["a", "Yes"], ["b", "No"]))).toEqual({ on: "a", off: "b" });
  });
  it("leaves every other choice a choice", () => {
    expect(switchValues(EFFORT)).toBeNull();
    expect(switchValues(v(["low", "Low"], ["high", "High"]))).toBeNull();
    expect(switchValues(v(["on", "On"]))).toBeNull();
    expect(switchValues([])).toBeNull();
  });
});

describe("agentSummary", () => {
  const meta = {
    models: v(["haiku", "Haiku"], ["opus", "Opus"]), currentModelId: "haiku",
    modes: v(["default", "Default"], ["plan", "Plan"]), currentModeId: "default",
    options: [
      { id: "effort", label: "Effort", category: "thought_level", values: EFFORT, currentId: "low" },
      { id: "fast", label: "Fast mode", category: "", values: FAST, currentId: "off" },
      { id: "agent", label: "Agent", category: "", values: v(["default", "Default"], ["review", "Reviewer"]), currentId: "default" },
    ],
  };
  it("says model, mode and the options that are set, in the agent's order", () => {
    expect(agentSummary(meta)).toBe("Haiku · Default · Effort Low");
  });
  it("names a switch only while it is on, and a non-default choice with its label", () => {
    const on = { ...meta, options: meta.options.map((o) => (o.id === "fast" ? { ...o, currentId: "on" } : o.id === "agent" ? { ...o, currentId: "review" } : o)) };
    expect(agentSummary(on)).toBe("Haiku · Default · Effort Low · Fast mode · Agent Reviewer");
  });
  it("is empty before the agent has reported anything, and skips unknown ids", () => {
    expect(agentSummary({ models: [], currentModelId: null, modes: [], currentModeId: null, options: [] })).toBe("");
    expect(agentSummary({ ...meta, currentModelId: "gone", options: [] })).toBe("Default");
  });
  it("labels an unnamed option by its category", () => {
    expect(optLabel("thought_level", "")).toBe("Reasoning");
    expect(optLabel("", "")).toBe("Option");
    expect(agentSummary({ ...meta, options: [{ ...meta.options[0]!, label: "" }] })).toBe("Haiku · Default · Reasoning Low");
  });
});

describe("apiSummary", () => {
  it("joins what is known", () => {
    expect(apiSummary("Anthropic", "Haiku", "Low")).toBe("Anthropic · Haiku · Effort Low");
    expect(apiSummary("Ollama", undefined, undefined)).toBe("Ollama");
    expect(apiSummary(undefined, undefined, undefined)).toBe("");
  });
});
