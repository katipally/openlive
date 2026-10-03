import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { deleteDictation, historyQuery, pendingDictationKey } from "./history";
import { usePendingDeletes } from "../deferredDelete";
import { UNDO_MS, useToasts } from "../toast";

// One dictation's delete waits out an Undo toast, as a chat's and a Flow session's do.
const undoToast = () => useToasts.getState().toasts.find((t) => t.undoable)!;
const hidden = (id: string) => usePendingDeletes.getState().keys.has(pendingDictationKey(id));

describe("deleting a dictation", () => {
  const kept = { items: [{ id: "b" }] };
  let fetch: ReturnType<typeof vi.fn>;
  let qc: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.setState({ toasts: [] });
    usePendingDeletes.setState({ keys: new Set() });
    fetch = vi.fn(async () => Response.json(kept));
    vi.stubGlobal("fetch", fetch);
    qc = new QueryClient();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("hides it at once and deletes it once the Undo toast is gone", async () => {
    deleteDictation(qc, "a");
    expect(hidden("a")).toBe(true);
    expect(undoToast().text).toBe("Dictation deleted");
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(fetch).toHaveBeenCalledWith("/api/dictate/history?id=a", { method: "DELETE", keepalive: true });
    expect(qc.getQueryData(historyQuery.queryKey)).toEqual(kept);
    expect(hidden("a")).toBe(false);
  });

  it("Undo brings it back and deletes nothing", async () => {
    deleteDictation(qc, "a");
    useToasts.getState().undo(undoToast().id);
    expect(hidden("a")).toBe(false);
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says so, and shows it again, when the delete fails", async () => {
    fetch.mockImplementation(async () => { throw new TypeError("offline"); });
    deleteDictation(qc, "a");
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(hidden("a")).toBe(false);
    expect(useToasts.getState().toasts.map((t) => t.text)).toContain("Couldn't delete that dictation. It's back in the list.");
  });
});
