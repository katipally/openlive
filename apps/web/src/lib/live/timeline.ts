import type { Part } from "@/lib/chatStore";

// How an assistant turn lays out in the Activity timeline: spoken text as it
// was said, quiet work (reasoning, reads, searches, commands) folded into
// collapsible groups, and the steps worth seeing at a glance (edits, a lone
// tool) standing on their own. Pure, so the grouping is unit-tested.

export type ToolPart = Extract<Part, { kind: "tool" } | { kind: "acp_tool" }>;
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "work"; parts: Part[]; startedAt?: number; endedAt?: number }
  | { kind: "step"; part: ToolPart };

// Edits change the user's files: never folded away where they can't be seen.
const STANDALONE = new Set(["edit", "delete", "move"]);

/** One pass over the parts, O(parts). `endedAt` is when the turn finished, the
 *  end of a trailing group; a group followed by another part ends where it starts. */
export function segmentTurn(parts: Part[], endedAt?: number): Segment[] {
  const out: Segment[] = [];
  let work: Part[] = [];
  const flush = (next?: number) => {
    if (!work.length) return;
    const only = work[0]!;
    if (work.length === 1 && only.kind !== "reasoning" && only.kind !== "text") out.push({ kind: "step", part: only });
    else out.push({ kind: "work", parts: work, startedAt: work[0]!.at, endedAt: next });
    work = [];
  };
  for (const p of parts) {
    if (p.kind === "text") { flush(p.at); out.push({ kind: "text", text: p.text }); continue; }
    if (p.kind === "acp_tool" && STANDALONE.has(p.call.kind)) { flush(p.at); out.push({ kind: "step", part: p }); continue; }
    work.push(p);
  }
  flush(endedAt);
  return out;
}

// Past-tense summaries per tool-call kind, so a finished group says what it
// actually did ("Read 14 files") instead of a generic "Worked on it".
const KIND_PAST: Record<string, (n: number) => string> = {
  read: (n) => `Read ${n} file${n === 1 ? "" : "s"}`,
  edit: (n) => `Edited ${n} file${n === 1 ? "" : "s"}`,
  delete: (n) => `Deleted ${n} file${n === 1 ? "" : "s"}`,
  move: (n) => `Moved ${n} file${n === 1 ? "" : "s"}`,
  search: (n) => `Searched ${n} time${n === 1 ? "" : "s"}`,
  execute: (n) => `Ran ${n} command${n === 1 ? "" : "s"}`,
  fetch: (n) => `Fetched ${n} page${n === 1 ? "" : "s"}`,
  other: (n) => `Ran ${n} step${n === 1 ? "" : "s"}`,
};
// Built-in assistant tools have no ACP kind: bucket them into the same categories.
function builtinKind(tool: string): string {
  if (tool === "web_search") return "search";
  if (tool === "fetch_url" || tool === "open_url") return "fetch";
  if (tool === "look" || tool === "clipboard_read") return "read";
  return "other";
}

/** Label a finished group by its dominant action. `multiKind`: other kinds ran
 *  too, so the total step count is worth showing beside it. */
export function summarizeWork(tools: ToolPart[]): { label: string; multiKind: boolean } {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const kind = t.kind === "acp_tool" ? t.call.kind : builtinKind(t.tool);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (counts.size === 0) return { label: "Worked on it", multiKind: false };
  let top = "other", topN = 0;
  for (const [k, n] of counts) if (n > topN) { top = k; topN = n; }
  return { label: (KIND_PAST[top] ?? KIND_PAST.other!)(topN), multiKind: counts.size > 1 };
}

/** "0.4s", "12s", "3m 5s": how long a group of work took. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${Math.max(0.1, Math.round(ms / 100) / 10)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
