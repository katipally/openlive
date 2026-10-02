import { create, type StateCreator, type StoreApi } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";

// Zustand stores whose state lives in <home>/state/ui.json (packages/db/src/ui-state.ts),
// one group of fields per store. The root layout reads the file on the server
// and seeds every store before the first render (seedPersisted), so the first
// HTML already shows the saved mode, server and client agree on it, and a sync
// read anywhere is always current. Writes go out as a per-field patch, coalesced
// over FLUSH_MS, so two windows saving different fields never undo each other;
// a BroadcastChannel tells the other windows.

export type Fields = Record<string, unknown>;
export type Saved = Record<string, Fields>;

const FLUSH_MS = 250;
const RETRY_MS = [1000, 4000, 15000];
/** fetch's keepalive refuses a bigger body; a bigger last write goes without it. */
const KEEPALIVE_MAX = 60_000;
const CHANNEL = "openlive-ui-state";
const browser = typeof window !== "undefined";

/** What this page knows is saved or on its way, per group: seeded from the file, then kept current. */
let saved: Saved = {};
let seeded = false;
let pending: Saved = {};
let timer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
let channel: BroadcastChannel | null = null;
/** True while seedPersisted runs: the file is laid over the defaults, not over what is in memory. */
let seeding = false;

interface Entry { rehydrate: () => void; first: () => void; live: boolean }
const stores = new Map<string, Entry>();

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** `into` with `patch` laid over it: newer fields win, null removes. O(fields). */
export function layer(into: Saved, patch: Saved): Saved {
  const out = { ...into };
  for (const [g, f] of Object.entries(patch)) {
    const next = { ...out[g] };
    for (const [k, v] of Object.entries(f)) { if (v === null) delete next[k]; else next[k] = v; }
    out[g] = next;
  }
  return out;
}

const absent = (v: unknown) => v === undefined || v === null;

/** Patches stacked, newer fields winning; a null stays, since it is a removal still to send. O(fields). */
const stack = (older: Saved, newer: Saved): Saved =>
  Object.fromEntries([...new Set([...Object.keys(older), ...Object.keys(newer)])].map((g) => [g, { ...older[g], ...newer[g] }]));

/** The fields of `next` that differ from `prev`, with null for one `next` no
 *  longer holds (undefined and null both mean none). O(fields x size). */
export function changed(prev: Fields | undefined, next: Fields): Fields | null {
  const out: Fields = {};
  for (const [k, v] of Object.entries(next)) if (!absent(v) && !same(prev?.[k], v)) out[k] = v;
  for (const k of Object.keys(prev ?? {})) if (absent(next[k])) out[k] = null;
  return Object.keys(out).length ? out : null;
}

async function send(patch: Saved, keepalive = false): Promise<boolean> {
  try {
    const body = JSON.stringify(patch);
    const r = await fetch("/api/ui-state", {
      method: "PATCH", headers: { "content-type": "application/json" }, body,
      keepalive: keepalive && body.length < KEEPALIVE_MAX,
    });
    // A patch the server refuses outright will never land; retrying it would only block the ones after it.
    return r.ok || (r.status >= 400 && r.status < 500);
  } catch { return false; }
}

async function flush(keepalive = false): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  const batch = pending;
  if (!Object.keys(batch).length) return;
  pending = {};
  if (await send(batch, keepalive)) { failures = 0; return; }
  // Offline or the server restarting: keep the fields, newer edits on top, and try again.
  pending = stack(batch, pending);
  timer = setTimeout(() => void flush(), RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
}

function queue(group: string, fields: Fields): void {
  saved = layer(saved, { [group]: fields });
  if (!browser) return;
  pending = stack(pending, { [group]: fields });
  channel?.postMessage({ group, fields });
  timer ??= setTimeout(() => void flush(), FLUSH_MS);
}

const storage: PersistStorage<Fields> = {
  getItem: (name) => (saved[name] ? { state: saved[name], version: 0 } : null),
  setItem: (name, { state }) => {
    const diff = changed(saved[name], state);
    if (diff) queue(name, diff);
  },
  removeItem: () => {},
};

/**
 * A zustand store whose `partialize`d fields persist under `group`. `clean`
 * turns saved fields (anything a file can hold) into valid state, dropping a
 * bad field on its own so it falls back to its default. `live: false` keeps
 * another window's saves out of this one's state: right for what a window is
 * showing, which is each window's own until the last one closes.
 */
export function persisted<T extends object>(
  group: string,
  init: StateCreator<T, [["zustand/persist", unknown]], []>,
  { partialize, clean, live = true }: { partialize: (s: T) => Fields; clean: (saved: Fields) => Partial<T>; live?: boolean },
) {
  let inner: StoreApi<T> | undefined;
  let first: T | undefined;
  let defaults: T | undefined;
  const store = create<T>()(persist((set, get, api) => {
    inner = api as unknown as StoreApi<T>;
    return init(set, get, api);
  }, {
    name: group,
    storage: storage as unknown as PersistStorage<T>,
    partialize: (s) => partialize(s) as unknown as T,
    // On the server these stores outlive a request, so a seed starts from the
    // defaults: a field the file no longer has must not keep the last request's value.
    merge: (fromFile, current) => ({ ...(seeding && defaults ? defaults : current), ...clean((fromFile ?? {}) as Fields) }),
    skipHydration: !seeded,
  }));
  // React renders the server's HTML and hydrates the client's from this: the
  // state as seeded, the same on both sides. persist would answer the defaults.
  if (seeded) first = store.getState();
  defaults = inner!.getInitialState();
  // The hook carries a copy of the store's methods; both must answer the same.
  inner!.getInitialState = store.getInitialState = () => first ?? defaults!;
  stores.set(group, { rehydrate: () => void store.persist.rehydrate(), first: () => { first = store.getState(); }, live });
  return store;
}

function onMessage(e: MessageEvent<{ group?: unknown; fields?: unknown }>) {
  const { group, fields } = e.data ?? {};
  if (typeof group !== "string" || !fields || typeof fields !== "object") return;
  saved = layer(saved, { [group]: fields as Fields });
  const store = stores.get(group);
  if (store?.live) store.rehydrate();
}

/**
 * Seed every store from the file, before anything renders. Idempotent: a
 * second call with the same groups changes nothing. On the server this runs
 * per request, so each render shows the file as it is now.
 */
export function seedPersisted(groups: Saved): void {
  saved = { ...groups };
  seeded = true;
  seeding = true;
  try { for (const e of stores.values()) { e.rehydrate(); e.first(); } }
  finally { seeding = false; }
  if (!browser || channel) return;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = onMessage;
  } catch { /* no BroadcastChannel: each window keeps its own copy until it reloads */ }
  const leave = () => void flush(true);
  addEventListener("pagehide", leave);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") leave(); });
}

/** What the file holds for a group right now, as this page knows it. */
export const savedGroup = (group: string): Fields => saved[group] ?? {};

/**
 * Lay fields saved somewhere else (the old localStorage keys) into their
 * stores and send them at once. Resolves true once the file has them.
 */
export async function adopt(patch: Saved): Promise<boolean> {
  if (!Object.keys(patch).length) return true;
  saved = layer(saved, patch);
  for (const [group, fields] of Object.entries(patch)) {
    stores.get(group)?.rehydrate();
    channel?.postMessage({ group, fields });
  }
  return send(patch);
}
