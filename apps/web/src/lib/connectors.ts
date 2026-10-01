// Connectors settings, the pure half: how a status reads, how an edit becomes
// the PATCH the agent takes, and which import candidates start checked. No
// React, no DOM, so it tests on its own.

import type { ConnectorImportSource, ConnectorPatch, ConnectorStatus, ConnectorToolWire, ConnectorTransportWire, ConnectorWire } from "@openlive/shared";

export const STATUS: Record<ConnectorStatus, { text: string; dot: "success" | "arc" | "accent" | "muted" | "danger" }> = {
  connected: { text: "Connected", dot: "success" },
  connecting: { text: "Connecting", dot: "accent" },
  disconnected: { text: "Not connected", dot: "muted" },
  needs_auth: { text: "Sign in needed", dot: "arc" },
  needs_consent: { text: "Needs your OK", dot: "arc" },
  error: { text: "Error", dot: "danger" },
  disabled: { text: "Off", dot: "muted" },
};

/** The one line that says what a connector runs or reaches. */
export const transportLine = (t: ConnectorTransportWire) =>
  t.type === "http" ? t.url : [t.command, ...t.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(" ");

/** How long to wait before looking again while a sign-in is open in the
 *  browser: quick at first, slower as it drags on, and done after five minutes. */
export function signInPollMs(elapsedMs: number): number | false {
  if (elapsedMs >= 5 * 60_000) return false;
  return elapsedMs < 30_000 ? 2000 : elapsedMs < 120_000 ? 5000 : 10_000;
}

/** One bulk switch over the tools in view: the names it changes and its label,
 *  which says when a filter narrows it to the tools shown. */
export function bulkTools(shown: readonly ConnectorToolWire[], filtered: boolean, on: boolean): { names: string[]; label: string } {
  const names = shown.filter((t) => t.enabled !== on).map((t) => t.name);
  const state = on ? "on" : "off";
  return { names, label: filtered ? `Turn the ${shown.length} shown ${state}` : `Turn all ${state}` };
}

/** The next look while several sign-ins are open: the soonest any one of them
 *  wants, or false once every one has given up. O(sign-ins). */
export function signInsPollMs(sinces: Iterable<number>, now: number): number | false {
  let next: number | false = false;
  for (const since of sinces) {
    const ms = signInPollMs(now - since);
    if (ms !== false && (next === false || ms < next)) next = ms;
  }
  return next;
}

/** A key and value being edited. `secret` only matters for env; headers are all secret. */
export interface KeyRow { key: string; value: string; secret: boolean }

/**
 * A write-only map's change. A row named like a saved secret with no value
 * keeps it; a value replaces it; a saved name with no row is removed (null).
 * A new name needs a value. O(rows + saved).
 */
export function secretPatch(saved: readonly string[], rows: readonly KeyRow[]): { patch: Record<string, string | null>; missing: string[] } {
  const had = new Set(saved);
  const patch: Record<string, string | null> = {};
  const missing: string[] = [];
  for (const r of rows) {
    if (r.value) patch[r.key] = r.value;
    else if (!had.has(r.key)) missing.push(r.key);
  }
  const kept = new Set(rows.map((r) => r.key));
  for (const k of saved) if (!kept.has(k)) patch[k] = null;
  return { patch, missing };
}

export interface EditDraft {
  name: string;
  url: string;
  clientMetadataUrl: string;
  command: string;
  /** One argument per line, so an argument may hold spaces. */
  args: string;
  cwd: string;
  /** Env for stdio, headers for http. */
  rows: KeyRow[];
}

export function draftOf(c: ConnectorWire): EditDraft {
  const t = c.transport;
  const base = { name: c.name, clientMetadataUrl: c.clientMetadataUrl ?? "", url: "", command: "", args: "", cwd: "" };
  if (t.type === "http") return { ...base, url: t.url, rows: t.headers.map((key) => ({ key, value: "", secret: true })) };
  return {
    ...base, command: t.command, args: t.args.join("\n"), cwd: t.cwd ?? "",
    rows: [
      ...Object.entries(t.env).map(([key, value]) => ({ key, value, secret: false })),
      ...t.secretEnv.map((key) => ({ key, value: "", secret: true })),
    ],
  };
}

const isWebUrl = (s: string) => /^https?:\/\//i.test(s) && URL.canParse(s);

/** The PATCH for an edit, or the first thing that stops it. */
export function editPatch(c: ConnectorWire, d: EditDraft): { patch: ConnectorPatch } | { error: string } {
  const t = c.transport;
  const rows = d.rows.map((r) => ({ ...r, key: r.key.trim() })).filter((r) => r.key || r.value);
  const what = t.type === "http" ? "header" : "variable";
  if (rows.some((r) => !r.key)) return { error: `Every ${what} needs a name.` };
  const keys = new Set<string>();
  for (const r of rows) {
    if (keys.has(r.key)) return { error: `${r.key} is listed twice.` };
    keys.add(r.key);
  }
  const meta = d.clientMetadataUrl.trim();
  if (meta && !isWebUrl(meta)) return { error: "The client metadata URL must be a full https:// address." };
  const patch: ConnectorPatch = {};
  if (d.name.trim() && d.name.trim() !== c.name) patch.name = d.name.trim();
  if (meta !== (c.clientMetadataUrl ?? "")) patch.clientMetadataUrl = meta || null;

  if (t.type === "http") {
    const url = d.url.trim();
    if (!isWebUrl(url)) return { error: "Enter a full URL, like https://example.com/mcp." };
    if (url !== t.url) patch.url = url;
    const { patch: headers, missing } = secretPatch(t.headers, rows);
    if (missing.length) return { error: `Enter a value for ${missing.join(", ")}.` };
    if (Object.keys(headers).length) patch.headers = headers;
    return { patch };
  }

  const command = d.command.trim();
  if (!command) return { error: "Enter the command to run." };
  const args = d.args.split("\n").map((a) => a.trim()).filter(Boolean);
  if (command !== t.command) patch.command = command;
  if (JSON.stringify(args) !== JSON.stringify(t.args)) patch.args = args;
  const cwd = d.cwd.trim();
  if (cwd !== (t.cwd ?? "")) patch.cwd = cwd || null;
  // A secret made plain has no value to carry over: it was never sent here.
  const unsealed = rows.find((r) => !r.secret && !r.value && t.secretEnv.includes(r.key));
  if (unsealed) return { error: `Enter a value for ${unsealed.key} to keep it as a plain variable.` };
  const env = Object.fromEntries(rows.filter((r) => !r.secret).map((r) => [r.key, r.value]));
  if (JSON.stringify(env) !== JSON.stringify(t.env)) patch.env = env;
  const { patch: secretEnv, missing } = secretPatch(t.secretEnv, rows.filter((r) => r.secret));
  if (missing.length) return { error: `Enter a value for ${missing.join(", ")}.` };
  if (Object.keys(secretEnv).length) patch.secretEnv = secretEnv;
  return { patch };
}

/** One import candidate, as a key a Set can hold. */
export const pickKey = (source: string, name: string) => `${source}\n${name}`;

/** What starts checked: every server found, except a duplicate. */
export const initialPicks = (sources: readonly ConnectorImportSource[]) =>
  new Set(sources.flatMap((s) => s.servers.filter((v) => !v.duplicateOf).map((v) => pickKey(s.source, v.name))));

/** The commit body for what is checked, in the order the preview lists it. */
export const pickedItems = (sources: readonly ConnectorImportSource[], picks: ReadonlySet<string>) =>
  sources.flatMap((s) => s.servers.filter((v) => picks.has(pickKey(s.source, v.name))).map((v) => ({ source: s.source, name: v.name })));
