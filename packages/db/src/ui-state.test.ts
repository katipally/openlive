import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

// PATHS is resolved at import, so the home is set before the module loads.
const dir = mkdtempSync(join(tmpdir(), "openlive-ui-state-"));
process.env.OPENLIVE_HOME = dir;
const ui = await import("./ui-state");
const { PATHS } = await import("./paths");

afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => { for (const f of [PATHS.ui, `${PATHS.ui}.corrupt`]) rmSync(f, { force: true }); });

const put = (text: string) => { mkdirSync(dirname(PATHS.ui), { recursive: true }); writeFileSync(PATHS.ui, text); };
const onDisk = () => JSON.parse(readFileSync(PATHS.ui, "utf8"));

describe("parseUiState", () => {
  test("nothing saved reads as no groups", () => {
    expect(ui.parseUiState(undefined)).toEqual({ version: 1, groups: {}, corrupt: false });
  });
  test("broken or non-object text reads as no groups, marked corrupt", () => {
    for (const t of ["{ broken", "[]", "null", "42", ""]) expect(ui.parseUiState(t)).toMatchObject({ groups: {}, corrupt: true });
  });
  test("a bad group is dropped alone; the rest survive", () => {
    const text = JSON.stringify({ version: 1, ui: { mode: "flow" }, voice: "oops", sessions: [1], "Bad Name": {}, onboarding: { welcomed: true } });
    expect(ui.parseUiState(text).groups).toEqual({ ui: { mode: "flow" }, onboarding: { welcomed: true } });
  });
  test("a newer version is read, and a missing or silly one counts as current", () => {
    expect(ui.parseUiState(JSON.stringify({ version: 9, ui: { mode: "chat" } }))).toMatchObject({ version: 9, groups: { ui: { mode: "chat" } } });
    for (const v of [undefined, -1, 1.5, "2"]) expect(ui.parseUiState(JSON.stringify({ version: v })).version).toBe(1);
  });
});

describe("validUiPatch", () => {
  test("takes objects of objects", () => {
    expect(ui.validUiPatch({ ui: { mode: "flow", gone: null } })).toEqual({ ui: { mode: "flow", gone: null } });
  });
  test("refuses anything else with a reason", () => {
    for (const b of [null, [], "x", { ui: 1 }, { ui: [] }, { version: {} }, { "../x": {} }, { ui: { ["x".repeat(201)]: 1 } }]) {
      expect(typeof ui.validUiPatch(b)).toBe("string");
    }
  });
});

describe("mergeUiPatch", () => {
  test("sets and removes fields, keeps the rest, drops a group left empty", () => {
    const cur = { ui: { mode: "chat", tab: "tools" }, voice: { pttMode: "hold" }, future: { x: 1 } };
    expect(ui.mergeUiPatch(cur, { ui: { mode: "flow" }, voice: { pttMode: null }, onboarding: { welcomed: true } })).toEqual({
      ui: { mode: "flow", tab: "tools" }, future: { x: 1 }, onboarding: { welcomed: true },
    });
    expect(cur.ui.mode).toBe("chat");
  });
});

describe("patchUiState", () => {
  test("starts a missing file and reads it back", async () => {
    await ui.patchUiState({ ui: { mode: "dictate" } });
    expect(onDisk()).toEqual({ version: 1, ui: { mode: "dictate" } });
    expect(ui.readUiState()).toEqual({ ui: { mode: "dictate" } });
  });

  test("concurrent writers to different fields all land", async () => {
    const N = 25;
    await Promise.all(Array.from({ length: N }, (_, i) => ui.patchUiState({ sessions: { [`chat${i}`]: { bind: "claude" } } })));
    expect(Object.keys(onDisk().sessions)).toHaveLength(N);
  });

  test("a broken file is set aside, not written over", async () => {
    put("{ half a fi");
    expect(ui.readUiState()).toEqual({});
    await ui.patchUiState({ ui: { mode: "flow" } });
    expect(readFileSync(`${PATHS.ui}.corrupt`, "utf8")).toBe("{ half a fi");
    expect(onDisk()).toEqual({ version: 1, ui: { mode: "flow" } });
  });

  test("a newer version's file keeps its version and its unknown fields", async () => {
    put(JSON.stringify({ version: 3, ui: { mode: "chat", later: [1, 2] }, later: { a: 1 } }));
    await ui.patchUiState({ ui: { mode: "flow" } });
    expect(onDisk()).toEqual({ version: 3, ui: { mode: "flow", later: [1, 2] }, later: { a: 1 } });
  });

  test("no temp file is left behind", async () => {
    await ui.patchUiState({ ui: { mode: "chat" } });
    expect(existsSync(`${PATHS.ui}.${process.pid}.tmp`)).toBe(false);
  });
});
