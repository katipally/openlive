import { describe, expect, it } from "vitest";
import { mergeListed } from "./agentSessions";

const s = (id: string, title: string, updatedAt: string, cwd = "/w") => ({ id, title, updatedAt, cwd });

describe("mergeListed", () => {
  it("lets the agent's own list win, keeps disk-only sessions, newest first", () => {
    const disk = [s("a", "From disk", "2026-09-01T00:00:00.000Z"), s("b", "Only on disk", "2026-09-02T00:00:00.000Z")];
    const listed = [s("a", "Agent title", "2026-09-05T00:00:00.000Z"), s("c", "New", "2026-09-03T00:00:00.000Z")];
    expect(mergeListed(disk, listed, "Codex session").map((x) => [x.id, x.title])).toEqual([["a", "Agent title"], ["c", "New"], ["b", "Only on disk"]]);
  });

  it("falls back to the disk title, then the agent name, for a missing or boilerplate title", () => {
    const disk = [s("a", "Fix login", "2026-09-01T00:00:00.000Z")];
    const listed = [s("a", "[You're being used through OpenLive...", ""), s("b", "", "2026-09-02T00:00:00.000Z")];
    const out = mergeListed(disk, listed, "Codex session");
    expect(out.map((x) => [x.id, x.title, x.updatedAt])).toEqual([
      ["b", "Codex session", "2026-09-02T00:00:00.000Z"],
      ["a", "Fix login", "2026-09-01T00:00:00.000Z"],
    ]);
  });

  it("drops sessions with no folder or time, and caps the list", () => {
    expect(mergeListed([], [s("a", "x", "2026-09-01T00:00:00.000Z", ""), s("b", "y", "")], "S")).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) => s(`s${i}`, "t", new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
    const out = mergeListed([], many, "S");
    expect(out).toHaveLength(60);
    expect(out[0]!.id).toBe("s79");
  });
});
