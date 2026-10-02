import { describe, expect, it } from "vitest";
import { Plug, Search } from "lucide-react";
import { toolActive, toolMeta } from "./toolMeta";

describe("toolMeta", () => {
  it("shows a connector tool as its connector and tool in words, never the raw name", () => {
    expect(toolMeta("github__create_issue")).toEqual({ label: "Github · Create issue", active: "Github · Create issue", icon: Plug, connector: "Github" });
    expect(toolMeta("many_tools-server__tool_1").label).toBe("Many tools server · Tool 1");
  });

  it("says a built-in tool in words, and an unknown one too", () => {
    expect(toolMeta("web_search")).toMatchObject({ label: "Searched the web", active: "Searching the web", icon: Search });
    expect(toolMeta("brand_new_tool")).toMatchObject({ label: "Brand new tool", active: "Using brand new tool" });
  });

  it("adds the call's gist to the running label", () => {
    expect(toolActive("set_timer", "10 min")).toBe("Setting a timer · 10 min");
    expect(toolActive("find_files")).toBe("Searching your files");
  });
});
