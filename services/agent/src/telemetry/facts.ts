import { classifyError, httpClassOf, SUPERVISED_CLASSES, type ErrorClass, type HttpClass, type TelemetryEventProps } from "@openlive/shared";
import { PERMISSION_CANCELLED } from "../agents/types.js";
import { emitEvent, emitFact, type AgentFactProps } from "./emit.js";
import { limits } from "./limits.js";
import type { ToolTally } from "../capabilities/dispatch.js";

export type Surface = "flow" | "call";

/** Which brain answered. The id is one of the closed provider or agent ids, and main checks it again. */
export type Brain = Pick<TelemetryEventProps<"brain_error">, "brain_kind" | "brain_id">;
export const brainOf = (kind: "api" | "acp", id: string): Brain => ({ brain_kind: kind, brain_id: id as Brain["brain_id"] });

// ── tool groups ─────────────────────────────────────────────────────────────
// A tool counts under its group and never under its own name: names are only
// ever looked up here, so one the model invented matches nothing.

const FLOW_TOOLS = {
  t_insert: ["insert_text"],
  t_words: ["read_selection", "clipboard_read", "clipboard_write", "get_context"],
  t_see: ["screenshot", "read_screen_text", "wait", "list_windows", "get_window", "camera_frame", "get_app_state", "list_apps"],
  t_point: ["click", "double_click", "right_click", "move", "drag", "scroll", "mouse_down", "mouse_up", "perform_action"],
  t_keys: ["type", "keypress", "set_value"],
  t_window: ["window_activate", "window_move", "window_resize", "window_minimize", "window_close"],
  t_open: ["open_app", "open_url"],
  t_shell: ["shell"],
  t_memory: ["remember"],
} as const satisfies Partial<Record<keyof AgentFactProps<"flow">, readonly string[]>>;

const CALL_TOOLS = {
  t_look: ["look"],
  t_clipboard: ["clipboard_read", "clipboard_write"],
  t_open_url: ["open_url"],
  t_files: ["list_dir", "read_file", "write_file", "edit_file"],
  t_web: ["delegate"],
  t_plan: ["update_todos"],
  t_memory: ["remember"],
} as const satisfies Partial<Record<keyof AgentFactProps<"call">, readonly string[]>>;

const invert = <G extends string>(groups: Record<G, readonly string[]>): Map<string, G> =>
  new Map((Object.entries(groups) as [G, readonly string[]][]).flatMap(([group, names]) => names.map((n): [string, G] => [n, group])));

// A tool is reachable from both surfaces, but each fact reports only the groups
// its own schema names: a call's device tools and Flow's research count nowhere
// until a group is added for them.
const GROUPS: Record<Surface, Map<string, string>> = { flow: invert(FLOW_TOOLS), call: invert(CALL_TOOLS) };

/** The group a tool counts under on this surface; nothing for a name it does not know. */
export const toolGroup = (surface: Surface, tool: string | null) => (tool ? GROUPS[surface].get(tool) : undefined);

/** Hears every dispatched call on a surface, whichever brain made it: `tool` is
 *  the resolved tool, null when the name matched none. A call's fact counts
 *  groups only; Flow's also counts calls and failures. */
export function toolTally(surface: Surface): ToolTally {
  return (tool, failed) => {
    const group = toolGroup(surface, tool);
    if (surface === "flow") emitFact("flow", { tool_calls: 1, ...(failed && { tool_errors: 1 }), ...(group && { [group]: 1 }) });
    else if (group) emitFact("call", { [group]: 1 });
  };
}

// ── permission asks ─────────────────────────────────────────────────────────

export type PermissionOutcome = "allowed_once" | "allowed_always" | "rejected" | "timeout" | "cancelled" | "auto_allowed";

/** The outcome of an answered ask. Voice fallbacks answer the canonical ids `allow` and `always`. */
export function askOutcome(options: readonly { id: string; kind?: string }[], optionId: string): PermissionOutcome {
  if (optionId === PERMISSION_CANCELLED) return "cancelled";
  const option = options.find((o) => o.id === optionId);
  const kind = option ? option.kind ?? "allow_once" : optionId === "allow" ? "allow_once" : optionId === "always" ? "allow_always" : "reject_once";
  return kind === "allow_always" ? "allowed_always" : kind.startsWith("reject") ? "rejected" : "allowed_once";
}

const PERMISSION_COUNT: Record<PermissionOutcome, "perm_allowed" | "perm_denied" | "perm_timeout" | "perm_auto" | null> = {
  allowed_once: "perm_allowed", allowed_always: "perm_allowed", rejected: "perm_denied", timeout: "perm_timeout", cancelled: null, auto_allowed: "perm_auto",
};

/** Every ask counts once, and once more under its outcome unless it was cut off before one. */
export function permissionFact(surface: Surface, outcome: PermissionOutcome): void {
  const field = PERMISSION_COUNT[outcome];
  emitFact(surface, { perm_asks: 1, ...(field && { [field]: 1 }) });
}

// ── failures ────────────────────────────────────────────────────────────────

const ERROR_DEDUPE_MS = 5 * 60_000;

/** The count always rides the session fact; the event goes out once per class and brain per 5 minutes. */
export function reportBrainError(surface: Surface, brain: Brain, cls: ErrorClass, opts: { http?: HttpClass; recovered?: boolean } = {}): void {
  emitFact(surface, { errors: 1 });
  if (!limits.window(`${cls}|${brain.brain_id ?? ""}`, ERROR_DEDUPE_MS)) return;
  emitEvent("brain_error", { surface, class: cls, ...brain, http_class: opts.http ?? "none", ...(opts.recovered !== undefined && { recovered: opts.recovered }) });
}

/**
 * A failed turn as its surface saw it, from the `error` event: the wire `code`,
 * else the class of the words. A supervised coding agent reports its own
 * incidents, with whether its restart worked, so those are left to it.
 */
export function reportTurnError(surface: Surface, brain: Brain, e: { code?: ErrorClass; message: string }): void {
  const cls = e.code ?? classifyError(e.message);
  if (SUPERVISED_CLASSES.has(cls)) return;
  reportBrainError(surface, brain, cls, { http: httpClassOf(cls) });
}

// ── activation ──────────────────────────────────────────────────────────────

/** A turn ended in an answer, the first value moment. Once a launch per surface; main keeps each step once per install. */
export function reportReply(surface: Surface): void {
  if (limits.cap(`reply|${surface}`, 1)) emitEvent("onboarding_step", { step: surface === "flow" ? "first_flow_reply" : "first_call_reply" });
  if (limits.cap("activated", 1)) emitEvent("onboarding_step", { step: "activated" });
}

// ── timing ──────────────────────────────────────────────────────────────────

/** Time to first text and total time for one turn, from the moment it was taken. */
export class TurnTimer {
  private readonly t0 = performance.now();
  private first: number | undefined;

  firstText(): void { this.first ??= performance.now() - this.t0; }

  /** Only what was measured: no first text, no `ttft_ms`; a turn that did not finish has no `turn_ms`. */
  timings(finished: boolean): { ttft_ms?: number; turn_ms?: number } {
    return {
      ...(this.first !== undefined && { ttft_ms: Math.round(this.first) }),
      ...(finished && { turn_ms: Math.round(performance.now() - this.t0) }),
    };
  }
}

// ── exceptions ──────────────────────────────────────────────────────────────

/** An exception the agent survived: the kind only, and at most 3 a launch. */
export function reportException(kind: "uncaught" | "unhandled_rejection"): void {
  if (limits.cap("main_exception", 3)) emitEvent("main_exception", { process: "agent", kind });
}
