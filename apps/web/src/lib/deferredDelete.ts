"use client";

import { create } from "zustand";
import { toast, useToasts } from "./toast";

// Deletes that wait out an Undo toast. The item hides at once (lists filter on
// `keys`), the real delete runs when the toast leaves any way but Undo (timeout,
// close, swipe, a newer toast, the window going away), and Undo just shows it
// again. Keys are namespaced by the caller ("voice:<id>", "chat:<id>") so one
// store serves every list.

export const usePendingDeletes = create<{ keys: ReadonlySet<string> }>(() => ({ keys: new Set() }));
const toastOf = new Map<string, number>();

const setPending = (keys: readonly string[], on: boolean) => usePendingDeletes.setState((s) => {
  const next = new Set(s.keys);
  for (const key of keys) if (on) next.add(key); else next.delete(key);
  return { keys: next };
});

/** Hides `key` (or several under one toast) now and runs `commit` once the undo
 *  window closes. A commit that throws or resolves false brings them back and says so. */
export function deferDelete(key: string | readonly string[], text: string, commit: () => Promise<unknown>, failText = "Couldn’t delete that. It’s back in the list.") {
  const keys = typeof key === "string" ? [key] : key;
  const forget = () => { for (const k of keys) toastOf.delete(k); };
  setPending(keys, true);
  const id = toast(text, "info", {
    undo: () => { forget(); setPending(keys, false); },
    commit: async () => {
      forget();
      let ok = false;
      try { ok = (await commit()) !== false; } catch { /* reported below */ }
      setPending(keys, false);
      if (!ok) toast(failText);
    },
  });
  for (const k of keys) toastOf.set(k, id);
}

/** Drops a pending delete without running it, as if Undo was pressed. For when
 *  the person replaces the thing before its delete landed (a new key pasted). */
export function cancelDelete(key: string) {
  const id = toastOf.get(key);
  if (id !== undefined) useToasts.getState().undo(id);
}
