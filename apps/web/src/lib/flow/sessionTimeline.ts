import type { Part } from "../chatStore";
import { segmentTurn, type Segment } from "../live/timeline";
import { toolSummary } from "@openlive/shared";
import { agentToolLabel, toolMeta } from "../live/toolMeta";
import type { FlowSessionEntry } from "./sessions";

// A Flow session's log, read as the in-call Activity timeline reads a turn: what
// you said, what was said back, and the tools between, each call and its result
// one row. Runs of tools fold through the same segmentTurn the call uses, so a
// session reads the same in both places. Pure and O(entries).

export type ToolStatus = "running" | "done" | "failed" | "stopped" | "declined" | "unanswered";

export interface FlowTool {
  id: string;
  /** The raw tool name, for its icon or connector monogram. */
  name: string;
  label: string;
  status: ToolStatus;
  /** Only the arguments that say something; absent when there were none. */
  args?: [string, string][];
  ms?: number;
  /** Basenames of the captures still on disk. */
  shots: string[];
}

export type FlowItem =
  | { kind: "user"; id: string; text: string; at: string }
  | { kind: "reply"; id: string; text: string; spoken: boolean; at: string }
  | { kind: "tools"; id: string; segments: Segment[] }
  | { kind: "app"; id: string; app: string; window: string; at: string }
  | { kind: "stop"; id: string; at: string };

export interface FlowTimeline {
  items: FlowItem[];
  tools: Map<string, FlowTool>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const time = (iso: string) => new Date(iso).getTime();

function labelOf(e: FlowSessionEntry): string {
  if (str(e.kind)) return agentToolLabel(str(e.kind), str(e.target));
  const gist = e.args && typeof e.args === "object" ? toolSummary(str(e.name), e.args as Record<string, unknown>) : undefined;
  return gist ? `${toolMeta(str(e.name)).label} · ${gist}` : toolMeta(str(e.name)).label;
}

function statusOf(e: FlowSessionEntry): ToolStatus {
  if (e.isError !== true) return "done";
  return e.cancelled === true ? "stopped" : e.declined === true ? "declined" : e.unanswered === true ? "unanswered" : "failed";
}

/** Arguments as label and value, skipping the empty ones: a call with nothing to
 *  say shows no details at all rather than "{}". */
function argsOf(v: unknown): [string, string][] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: [string, string][] = [];
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === undefined || x === null || x === "" || (typeof x === "object" && !Object.keys(x).length)) continue;
    out.push([k.replace(/_/g, " "), typeof x === "string" ? x : JSON.stringify(x)]);
  }
  return out.length ? out : undefined;
}

/** An entry names its captures by relative path; the transcript needs the
 *  basename, and only the ones whose file is still on disk. */
function shotsOf(e: FlowSessionEntry, onDisk: Set<string>): string[] {
  const raw = Array.isArray(e.assets) ? e.assets : [e.asset, (e.details as { asset?: string } | undefined)?.asset];
  const names = raw.map((v) => str(v).split("/").pop() ?? "").filter((n) => n && onDisk.has(n));
  return [...new Set(names)];
}

export function flowTimeline(entries: FlowSessionEntry[], assets: { name: string }[]): FlowTimeline {
  const onDisk = new Set(assets.map((a) => a.name));
  const items: FlowItem[] = [];
  const tools = new Map<string, FlowTool>();
  const started = new Map<string, number>();
  const rows = new Map<string, Extract<Part, { kind: "tool" }>>();
  let run: Part[] = [];
  let app = "";
  const flush = (next?: string) => {
    if (!run.length) return;
    items.push({ kind: "tools", id: `tools-${items.length}`, segments: segmentTurn(run, next ? time(next) : undefined) });
    run = [];
  };

  for (const e of entries) {
    if (e.type === "tool_call" || e.type === "tool_result") {
      const id = str(e.callId) || e.id;
      const known = tools.get(id);
      const t: FlowTool = known ?? { id, name: str(e.name), label: str(e.name) ? labelOf(e) : "A tool", status: "running", shots: [] };
      if (e.type === "tool_call") {
        if (t.name) t.label = labelOf(e);
        t.args = argsOf(e.args);
        started.set(id, time(e.timestamp));
      } else {
        t.status = statusOf(e);
        t.shots = shotsOf(e, onDisk);
        const from = started.get(id);
        t.ms = typeof e.durationMs === "number" ? e.durationMs : from !== undefined ? time(e.timestamp) - from : undefined;
      }
      if (!known) {
        tools.set(id, t);
        const row = { kind: "tool" as const, id, tool: t.name, done: false, at: time(e.timestamp) };
        rows.set(id, row);
        run.push(row);
      }
      // Kept current, so a folded group's summary and failed count read the final state.
      const row = rows.get(id)!;
      row.done = t.status !== "running";
      if (t.status === "failed") row.detail = "error";
      continue;
    }
    if (e.type === "message") {
      const text = str(e.text) || str(e.content);
      if (!text.trim()) continue;
      flush(e.timestamp);
      items.push(e.role === "user"
        ? { kind: "user", id: e.id, text, at: e.timestamp }
        : { kind: "reply", id: e.id, text, spoken: e.quiet !== true, at: e.timestamp });
      continue;
    }
    if (e.type === "context") {
      const c = (e.context ?? {}) as { app?: string; windowTitle?: string };
      const now = str(c.app);
      // The app is noted when it changes, not after every turn.
      if (!now || now === app) continue;
      app = now;
      flush(e.timestamp);
      items.push({ kind: "app", id: e.id, app: now, window: str(c.windowTitle), at: e.timestamp });
      continue;
    }
    if (e.type === "cancel") {
      flush(e.timestamp);
      items.push({ kind: "stop", id: e.id, at: e.timestamp });
    }
  }
  flush();
  return { items, tools };
}

/** Whether `item` opens a new turn, so it sits a turn apart from `prev` rather
 *  than a beat: you speaking, the reply to you, or the app in front changing.
 *  An app change and what you said in it read as one turn. */
export function startsTurn(prev: FlowItem, item: FlowItem): boolean {
  if (item.kind === "app") return true;
  if (item.kind === "user") return prev.kind !== "app";
  return prev.kind === "user";
}

const STATUS_WORD: Record<ToolStatus, string> = {
  running: "never finished", done: "done", failed: "failed", stopped: "stopped", declined: "declined", unanswered: "no answer",
};
export const statusWord = (s: ToolStatus) => STATUS_WORD[s];

/** The plain-text copy, so a pasted transcript reads like the screen. */
export function timelineText({ items, tools }: FlowTimeline, stamp: (iso: string) => string): string {
  const lines: string[] = [];
  for (const it of items) {
    if (it.kind === "user") lines.push(`${stamp(it.at)}  You: ${it.text}`);
    else if (it.kind === "reply") lines.push(`${stamp(it.at)}  Flow: ${it.text}`);
    else if (it.kind === "app") lines.push(`${stamp(it.at)}  In front: ${[it.app, it.window].filter(Boolean).join(" · ")}`);
    else if (it.kind === "stop") lines.push(`${stamp(it.at)}  You stopped it`);
    else for (const s of it.segments) for (const p of s.kind === "work" ? s.parts : s.kind === "step" ? [s.part] : []) {
      const t = p.kind === "tool" && p.id ? tools.get(p.id) : undefined;
      if (!t) continue;
      const shots = t.shots.length ? ` (${t.shots.length === 1 ? "1 capture" : `${t.shots.length} captures`})` : "";
      lines.push(`  ${t.label}: ${statusWord(t.status)}${shots}`);
    }
  }
  return lines.join("\n");
}
