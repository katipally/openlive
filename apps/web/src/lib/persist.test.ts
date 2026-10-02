import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let persist: typeof import("./persist");
beforeEach(async () => {
  vi.resetModules();
  persist = await import("./persist");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("changed", () => {
  it("names only what differs, and null for what went", () => {
    expect(persist.changed({ a: 1, b: [1], c: "x" }, { a: 1, b: [2], c: undefined, d: true })).toEqual({ b: [2], c: null, d: true });
    expect(persist.changed({ a: { x: 1 } }, { a: { x: 1 } })).toBeNull();
  });
  it("treats null and missing as the same nothing", () => {
    expect(persist.changed({}, { a: null })).toBeNull();
    expect(persist.changed(undefined, { a: null, b: undefined })).toBeNull();
  });
});

describe("layer", () => {
  it("lays fields over, removes nulls, leaves other groups", () => {
    expect(persist.layer({ ui: { a: 1, b: 2 }, v: { x: 1 } }, { ui: { b: null, c: 3 } })).toEqual({ ui: { a: 1, c: 3 }, v: { x: 1 } });
  });
});

describe("persisted", () => {
  const make = () => persist.persisted<{ n: number; label: string; open: boolean }>("t", () => ({ n: 0, label: "a", open: false }), {
    partialize: (s) => ({ n: s.n, label: s.label }),
    clean: (f) => ({ ...(typeof f.n === "number" ? { n: f.n } : {}), ...(typeof f.label === "string" ? { label: f.label } : {}) }),
  });

  it("is seeded before render, a bad field falling back alone, and serves that as the server snapshot", () => {
    const s = make();
    persist.seedPersisted({ t: { n: 5, label: 42 } });
    expect(s.getState()).toMatchObject({ n: 5, label: "a", open: false });
    s.setState({ n: 6 });
    expect(s.getInitialState().n).toBe(5);
  });

  it("a later seed starts from the defaults, as each server request must", () => {
    const s = make();
    persist.seedPersisted({ t: { n: 5, label: "b" } });
    s.setState({ open: true });
    persist.seedPersisted({ t: { n: 7 } });
    expect(s.getState()).toMatchObject({ n: 7, label: "a", open: false });
  });

  it("hydrates a store made after the seed straight away", () => {
    persist.seedPersisted({ t: { n: 9 } });
    const s = make();
    expect(s.getState().n).toBe(9);
    expect(s.getInitialState().n).toBe(9);
  });

  it("coalesces changes into one per-field patch, and sends nothing for state it does not keep", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("addEventListener", () => {});
    vi.stubGlobal("document", { addEventListener: () => {} });
    vi.resetModules();
    persist = await import("./persist");
    const fetch = vi.fn(async (..._: unknown[]) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const s = make();
    persist.seedPersisted({ t: { n: 1, label: "a" } });
    s.setState({ open: true });
    s.setState({ n: 2 });
    s.setState({ n: 3, label: undefined as unknown as string });
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ t: { n: 3, label: null } });
    expect(persist.savedGroup("t")).toEqual({ n: 3 });
  });

  it("keeps a failed write and sends it again, newer edits on top", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("addEventListener", () => {});
    vi.stubGlobal("document", { addEventListener: () => {} });
    vi.resetModules();
    persist = await import("./persist");
    const fetch = vi.fn(async (..._: unknown[]) => { throw new TypeError("offline"); });
    vi.stubGlobal("fetch", fetch);
    const s = make();
    persist.seedPersisted({});
    s.setState({ n: 1, label: "b" });
    await vi.advanceTimersByTimeAsync(300);
    fetch.mockImplementation(async () => new Response(null, { status: 204 }));
    s.setState({ n: 2 });
    await vi.runAllTimersAsync();
    const last = fetch.mock.calls.at(-1)![1] as RequestInit;
    expect(JSON.parse(last.body as string)).toEqual({ t: { n: 2, label: "b" } });
  });
});
