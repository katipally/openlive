import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelDelete, deferDelete, usePendingDeletes } from "./deferredDelete";
import { UNDO_MS, useToasts } from "./toast";

const pending = () => usePendingDeletes.getState().keys;
const undoToast = () => useToasts.getState().toasts.find((t) => t.undoable)!;

describe("deferred delete", () => {
  beforeEach(() => { vi.useFakeTimers(); useToasts.setState({ toasts: [] }); usePendingDeletes.setState({ keys: new Set() }); });
  afterEach(() => vi.useRealTimers());

  it("hides at once and commits when the undo window runs out", async () => {
    const commit = vi.fn(async () => {});
    deferDelete("voice:1", "Deleted", commit);
    expect(pending().has("voice:1")).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(commit).toHaveBeenCalledOnce();
    expect(pending().has("voice:1")).toBe(false);
  });

  it("Undo shows it again and never commits", async () => {
    const commit = vi.fn(async () => {});
    deferDelete("chat:1", "Deleted", commit);
    useToasts.getState().undo(undoToast().id);
    expect(pending().has("chat:1")).toBe(false);
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2);
    expect(commit).not.toHaveBeenCalled();
  });

  it("closing the toast commits right away", async () => {
    const commit = vi.fn(async () => {});
    deferDelete("key:1", "Removed", commit);
    useToasts.getState().dismiss(undoToast().id);
    await vi.advanceTimersByTimeAsync(0);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("cancelDelete behaves like Undo", async () => {
    const commit = vi.fn(async () => {});
    deferDelete("key:2", "Removed", commit);
    cancelDelete("key:2");
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2);
    expect(commit).not.toHaveBeenCalled();
    expect(pending().size).toBe(0);
  });

  it("a failed commit brings the item back and reports it", async () => {
    deferDelete("voice:2", "Deleted", async () => false, "It is back");
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(pending().has("voice:2")).toBe(false);
    expect(useToasts.getState().toasts.some((t) => t.text === "It is back" && t.kind === "error")).toBe(true);
  });

  it("a newer toast pushing one out commits it", async () => {
    const commits = [vi.fn(async () => {}), vi.fn(async () => {}), vi.fn(async () => {}), vi.fn(async () => {})];
    commits.forEach((c, i) => deferDelete(`chat:${i}`, `Deleted ${i}`, c));
    await vi.advanceTimersByTimeAsync(0);
    expect(commits[0]).toHaveBeenCalledOnce();
    expect(commits[3]).not.toHaveBeenCalled();
  });
});
