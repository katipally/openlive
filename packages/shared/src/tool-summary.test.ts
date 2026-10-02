import { describe, expect, it } from "vitest";
import { durationWords, toolSummary } from "./tool-summary";

describe("toolSummary", () => {
  it("names a timer by its length and label, and a reminder by its text", () => {
    expect(toolSummary("set_timer", { duration: "PT10M", label: "pasta" })).toBe("10 min · pasta");
    expect(toolSummary("set_timer", { duration: 5400 })).toBe("1 h 30 min");
    expect(toolSummary("remind", { text: "call the bank", in: "PT1H" })).toBe("call the bank");
  });

  it("joins held keys and takes the first argument a person would read", () => {
    expect(toolSummary("keypress", { keys: ["cmd", "s"] })).toBe("cmd+s");
    expect(toolSummary("write_file", { path: "notes.md", content: "x" })).toBe("notes.md");
    expect(toolSummary("find_files", { query: "  tax return " })).toBe("tax return");
  });

  it("reads a connector tool's own arguments out of read_tool's and use_tool's", () => {
    expect(toolSummary("github__get_issue", { name: "github__get_issue", arguments: { title: "Crash on start" } })).toBe("Crash on start");
    expect(toolSummary("github__get_issue", { name: "github__get_issue", query: "crash" })).toBe("crash");
    expect(toolSummary("github__get_issue", { name: "github__get_issue" })).toBeUndefined();
  });

  it("never echoes typed text, and says nothing when no argument fits", () => {
    expect(toolSummary("type", { text: "hunter2" })).toBeUndefined();
    expect(toolSummary("insert_text", { text: "secret" })).toBeUndefined();
    expect(toolSummary("screenshot", {})).toBeUndefined();
    expect(toolSummary("look", undefined)).toBeUndefined();
  });
});

describe("durationWords", () => {
  it("reads ISO 8601 and seconds, and passes anything else through", () => {
    expect(durationWords("PT1H30M")).toBe("1 h 30 min");
    expect(durationWords("P1DT2S")).toBe("1 d 2 s");
    expect(durationWords("45")).toBe("45 s");
    expect(durationWords("soon")).toBe("soon");
    expect(durationWords("P")).toBe("P");
  });
});
