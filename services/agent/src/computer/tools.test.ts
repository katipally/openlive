import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computerTools } from "./tools.js";
import { ComputerHelper, type ActionResult, type ComputerPort, type Snapshot } from "./helper.js";
import { InputLock } from "../capabilities/input-lock.js";
import type { DevicePort } from "../capabilities/device.js";
import type { Tool, ToolCtx } from "../capabilities/types.js";

const FAKE = fileURLToPath(new URL("./fake-helper.mjs", import.meta.url));
const ctx = { signal: new AbortController().signal } as ToolCtx;
const byName = (tools: Tool[], name: string) => tools.find((t) => t.name === name)!;
const device = { recognizeText: async (_png: string, shot: { width: number; height: number }) => [{ text: "Total", confidence: 1, x: shot.width / 2, y: 10, width: 30, height: 12 }] } as unknown as DevicePort;

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  app: { name: "Notes", bundleId: "com.apple.Notes", pid: 42, active: true },
  window: { id: 7, appName: "Notes", pid: 42, title: "Groceries", x: 0, y: 0, width: 800, height: 600, onScreen: true },
  treeText: "0 window Groceries\n\t1 button Save",
  elementCount: 2,
  truncated: false,
  screenshot: { data: "PNG", mime: "image/png", width: 1280, height: 960 },
  ...over,
});

/** Answers like the helper and remembers what it was asked. */
function recorder(reply: (method: string) => unknown = (m) => (m === "getAppState" ? snapshot() : { action: { path: "accessibility", actionName: "AXPress", verified: false }, state: snapshot() })) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const port: ComputerPort = { call: async <T>(method: string, params: Record<string, unknown> = {}) => { calls.push({ method, params }); return reply(method) as T; } };
  return { port, calls };
}

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

describe("the computer tools", () => {
  it("lead with the tree and follow with the picture, both as window state", async () => {
    const { port } = recorder();
    const r = await byName(computerTools({ computer: port, device }), "get_app_state").execute({ app: "Notes" }, ctx);
    expect(r.content).toEqual([{ type: "text", text: "The window now.\nNotes, window 7." }]);
    expect(r.state![0]).toMatchObject({ type: "text" });
    expect((r.state![0] as { text: string }).text).toContain("1 button Save");
    expect((r.state![0] as { text: string }).text).toContain("1280 by 960");
    expect(r.state![1]).toEqual({ type: "image", data: "PNG", mime: "image/png" });
  });

  it("keep working in the window the model last looked at, until it names another app", async () => {
    const { port, calls } = recorder();
    const tools = computerTools({ computer: port, device });
    await byName(tools, "get_app_state").execute({ app: "Notes" }, ctx);
    await byName(tools, "click").execute({ element: 1 }, ctx);
    expect(calls[1]).toEqual({ method: "click", params: { app: "com.apple.Notes", windowId: 7, elementIndex: 1, settleMs: 700 } });
    await byName(tools, "get_app_state").execute({ app: "Safari" }, ctx);
    expect(calls[2].params).toEqual({ app: "Safari", screenshot: true });
  });

  it("map each tool onto its helper method", async () => {
    const { port, calls } = recorder();
    const tools = computerTools({ computer: port, device });
    await byName(tools, "type").execute({ text: "milk", paste: true }, ctx);
    await byName(tools, "keypress").execute({ keys: ["Return"] }, ctx);
    await byName(tools, "keypress").execute({ keys: ["cmd", "shift", "p"] }, ctx);
    await byName(tools, "scroll").execute({ x: 10, y: 20, direction: "down", pages: 2 }, ctx);
    await byName(tools, "drag").execute({ from_element: 1, to_x: 5, to_y: 6 }, ctx);
    await byName(tools, "perform_action").execute({ element: 1, action: "scroll down" }, ctx);
    await byName(tools, "move").execute({ element: 2 }, ctx);
    await byName(tools, "mouse_down").execute({ x: 3, y: 4, button: "right" }, ctx);
    await byName(tools, "mouse_up").execute({ x: 5, y: 6 }, ctx);
    expect(calls.map((c) => c.method)).toEqual(["pasteText", "pressKey", "hotkey", "scroll", "drag", "performSecondaryAction", "move", "mouseDown", "mouseUp"]);
    expect(calls[6].params).toMatchObject({ elementIndex: 2 });
    expect(calls[7].params).toMatchObject({ x: 3, y: 4, button: "right" });
    expect(calls[8].params).toMatchObject({ x: 5, y: 6 });
    expect(calls[8].params.button).toBeUndefined();
    expect(calls[2].params.key).toBe("cmd+shift+p");
    expect(calls[3].params).toMatchObject({ x: 10, y: 20, direction: "down", pages: 2 });
    expect(calls[4].params).toMatchObject({ fromElementIndex: 1, toX: 5, toY: 6 });
  });

  it("never call an unverified action done", async () => {
    const { port } = recorder(() => ({ action: { path: "synthetic", actionName: "click", verified: false }, state: snapshot() } satisfies ActionResult));
    const r = await byName(computerTools({ computer: port, device }), "click").execute({ x: 1, y: 1 }, ctx);
    const said = (r.content[0] as { text: string }).text;
    expect(said).toMatch(/nothing confirms it landed/);
    expect(said).not.toMatch(/read back\./);
  });

  it("say so when the action ran but the window could not be read after", async () => {
    const { port } = recorder(() => ({ action: { path: "accessibility", actionName: "AXPress", verified: false }, stateError: "window closed" }));
    const r = await byName(computerTools({ computer: port, device }), "click").execute({ element: 1 }, ctx);
    expect((r.content[0] as { text: string }).text).toContain("window closed");
  });

  it("read text off the helper's picture, positioned in that picture", async () => {
    const { port } = recorder();
    const r = await byName(computerTools({ computer: port, device }), "read_screen_text").execute({}, ctx);
    expect((r.content[0] as { text: string }).text).toContain("Total (640, 10)");
  });

  it("mark which tools only read and which ask first", () => {
    const tools = computerTools({ computer: recorder().port, device });
    const reads = tools.filter((t) => t.readOnly).map((t) => t.name).sort();
    expect(reads).toEqual(["get_app_state", "list_apps", "list_windows", "read_screen_text", "wait"]);
    // A hover asks nothing, as ol-input's move does not.
    for (const t of tools.filter((t) => !t.readOnly && t.name !== "move")) expect(t.confirm, t.name).toBeTypeOf("function");
    expect(byName(tools, "move").confirm).toBeUndefined();
    expect(byName(tools, "click").confirm!({ app: "Notes" })).toBe("click in Notes");
  });

  it("let one driver act at a time, across sessions sharing one helper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "olcu-lock-"));
    const logFile = join(dir, "log");
    const helper = new ComputerHelper({ locate: () => ({ command: process.execPath, args: [FAKE], env: { FAKE_CU_DELAY_MS: "80", FAKE_CU_LOG: logFile } }) });
    cleanup.push(() => { helper.shutdown(); rmSync(dir, { recursive: true, force: true }); });
    const lock = new InputLock();
    const [a, b] = [computerTools({ computer: helper, device, lock }), computerTools({ computer: helper, device, lock })];
    // The fake helper answers concurrently: only the lock keeps these apart.
    await Promise.all([byName(a, "type").execute({ text: "first" }, ctx), byName(b, "type").execute({ text: "second" }, ctx)]);
    expect(readFileSync(logFile, "utf8").trim().split("\n").filter((l) => l.includes("typeText"))).toEqual(["start typeText first", "end typeText first", "start typeText second", "end typeText second"]);
  });
});

describe("the input lock", () => {
  it("drops a waiter whose turn was cancelled", async () => {
    const lock = new InputLock();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = lock.run(() => gate);
    const ac = new AbortController();
    const ran: string[] = [];
    const second = lock.run(async () => { ran.push("second"); }, ac.signal);
    ac.abort();
    release();
    await first;
    await expect(second).rejects.toThrow(/Cancelled/);
    await lock.run(async () => { ran.push("third"); });
    expect(ran).toEqual(["third"]);
  });
});
