import { describe, expect, it } from "vitest";
import type { HistoryChat } from "@openlive/shared";
import { flattenHistory, folderSessions, groupHistory, historyGroup, relativeTime, spanLabel } from "./historyList";

// A fixed local "now": Sunday 27 Sep 2026, 15:00.
const now = new Date(2026, 8, 27, 15, 0);
const at = (d: number, h = 12, m = 0) => new Date(2026, 8, d, h, m).toISOString();
const chat = (id: string, updatedAt: string, extra: Partial<HistoryChat> = {}): HistoryChat =>
  ({ id, title: id, updatedAt, agentId: null, source: "openlive", ...extra });

describe("historyGroup", () => {
  it("names recent days, then the month", () => {
    expect(historyGroup(at(27, 0, 5), now)).toBe("Today");
    expect(historyGroup(at(26, 23, 59), now)).toBe("Yesterday");
    expect(historyGroup(at(22), now)).toBe("Earlier this week");
    expect(historyGroup(at(10), now)).toBe("Last 30 days");
    expect(historyGroup(new Date(2026, 5, 3).toISOString(), now)).toBe(new Date(2026, 5, 3).toLocaleDateString(undefined, { month: "long" }));
    expect(historyGroup(new Date(2024, 5, 3).toISOString(), now)).toContain("2024");
    expect(historyGroup("not a date", now)).toBe("Earlier");
  });
});

describe("relativeTime", () => {
  it("counts up through the day, then names the day", () => {
    expect(relativeTime(at(27, 14, 59, ), now)).toBe("1m ago");
    expect(relativeTime(new Date(now.getTime() - 20_000).toISOString(), now)).toBe("just now");
    expect(relativeTime(at(27, 13), now)).toBe("2h ago");
    expect(relativeTime(at(26, 23), now)).toBe("Yesterday");
    expect(relativeTime(at(22), now)).toBe(new Date(2026, 8, 22).toLocaleDateString(undefined, { weekday: "short" }));
    expect(relativeTime("", now)).toBe("");
  });
  it("treats a clock running slightly ahead as just now", () => {
    expect(relativeTime(new Date(now.getTime() + 5_000).toISOString(), now)).toBe("just now");
  });
});

describe("spanLabel", () => {
  it("says minutes, then hours and minutes", () => {
    expect(spanLabel(at(27, 10, 0), at(27, 10, 18))).toBe("18 min");
    expect(spanLabel(at(27, 10, 0), at(27, 11, 4))).toBe("1 h 4 min");
    expect(spanLabel(at(27, 10, 0), at(27, 12, 0))).toBe("2 h");
    expect(spanLabel(at(27, 10, 0), new Date(new Date(at(27, 10, 0)).getTime() + 10_000).toISOString())).toBe("1 min");
  });
  it("is empty when unknown, backwards, or past a day", () => {
    expect(spanLabel(undefined, at(27))).toBe("");
    expect(spanLabel(at(27, 12), at(27, 11))).toBe("");
    expect(spanLabel(at(20), at(27))).toBe("");
  });
});

describe("flattenHistory + groupHistory", () => {
  it("merges workspaces newest first, keeps each id once, and groups runs of a day", () => {
    const rows = flattenHistory([
      { cwd: "/a", chats: [chat("x", at(27, 9)), chat("y", at(20))] },
      { cwd: "/b", chats: [chat("z", at(27, 11)), chat("x", at(27, 9))] },
      { cwd: "", chats: [chat("w", at(26))] },
    ]);
    expect(rows.map((r) => `${r.chat.id}@${r.cwd}`)).toEqual(["z@/b", "x@/a", "w@", "y@/a"]);
    expect(groupHistory(rows, now).map((g) => [g.label, g.rows.length])).toEqual([["Today", 2], ["Yesterday", 1], ["Last 30 days", 1]]);
  });
  it("handles nothing and a very long history", () => {
    expect(groupHistory(flattenHistory([]), now)).toEqual([]);
    const many = Array.from({ length: 5000 }, (_, i) => chat(`c${i}`, new Date(now.getTime() - i * 3_600_000).toISOString()));
    const groups = groupHistory(flattenHistory([{ cwd: "/a", chats: many }]), now);
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(5000);
    expect(new Set(groups.map((g) => g.label)).size).toBe(groups.length);
  });
});

describe("folderSessions", () => {
  it("collects each folder's deletable chats and leaves out the folderless and sqlite-backed ones", () => {
    const rows = flattenHistory([
      { cwd: "/a", chats: [chat("x", at(27)), chat("c", at(26), { source: "external", agentId: "claude-code" }), chat("o", at(25), { source: "external", agentId: "opencode" })] },
      { cwd: "/b", chats: [chat("y", at(27))] },
      { cwd: "", chats: [chat("w", at(26))] },
    ]);
    const folders = folderSessions(rows);
    expect(folders.get("/a")?.map((c) => c.id)).toEqual(["x", "c"]);
    expect(folders.get("/b")?.map((c) => c.id)).toEqual(["y"]);
    expect(folders.has("")).toBe(false);
    expect(folderSessions([]).size).toBe(0);
  });
});
