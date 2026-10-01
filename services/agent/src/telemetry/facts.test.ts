import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_CANCELLED } from "../agents/types.ts";
import {
  askOutcome, callToolFact, callToolGroup, flowToolFact, flowToolGroup, permissionFact, reportBrainError, reportException, reportReply, reportTurnError, TurnTimer,
  type PermissionOutcome,
} from "./facts.ts";
import { limits } from "./limits.ts";

type Sent = { kind: string; scope?: string; name?: string; props: Record<string, unknown> };
let sent: Sent[] = [];
beforeEach(() => {
  sent = [];
  limits.clear();
  (process as unknown as { parentPort?: unknown }).parentPort = { postMessage: (m: Sent) => sent.push(m) };
});
afterEach(() => { delete (process as unknown as { parentPort?: unknown }).parentPort; vi.useRealTimers(); });

const facts = (scope: string) => sent.filter((m) => m.kind === "fact" && m.scope === scope).map((m) => m.props);
const events = (name: string) => sent.filter((m) => m.kind === "event" && m.name === name).map((m) => m.props);

describe("Flow tool groups", () => {
  it("puts every tool Flow has under one group", () => {
    const groups: Record<string, string> = {
      insert_text: "t_insert", read_selection: "t_words", clipboard_read: "t_words", clipboard_write: "t_words", get_context: "t_words",
      screenshot: "t_see", read_screen_text: "t_see", wait: "t_see", list_windows: "t_see", get_window: "t_see", camera_frame: "t_see",
      click: "t_point", double_click: "t_point", right_click: "t_point", move: "t_point", drag: "t_point", scroll: "t_point", mouse_down: "t_point", mouse_up: "t_point",
      type: "t_keys", keypress: "t_keys",
      window_activate: "t_window", window_move: "t_window", window_resize: "t_window", window_minimize: "t_window", window_close: "t_window",
      open_app: "t_open", open_url: "t_open", shell: "t_shell", remember: "t_memory",
    };
    for (const [tool, group] of Object.entries(groups)) expect(flowToolGroup(tool), tool).toBe(group);
  });

  it("counts a tool no group holds as a call and nothing else", () => {
    for (const invented of ["send_email", "Screenshot", "click ", "constructor", "__proto__", "toString", "hasOwnProperty", ""]) {
      sent = [];
      flowToolFact(invented, false);
      expect(facts("flow"), invented).toEqual([{ tool_calls: 1 }]);
    }
    sent = [];
    flowToolFact(null, true);
    expect(facts("flow")).toEqual([{ tool_calls: 1, tool_errors: 1 }]);
  });

  it("counts a call once under its group, and a failure beside it", () => {
    flowToolFact("camera_frame", false);
    flowToolFact("shell", true);
    expect(facts("flow")).toEqual([{ tool_calls: 1, t_see: 1 }, { tool_calls: 1, tool_errors: 1, t_shell: 1 }]);
  });
});

describe("call tool groups", () => {
  it("covers the tools both brains have, and the built-in brain's own", () => {
    expect(["look", "clipboard_read", "clipboard_write", "open_url", "remember", "delegate", "update_todos", "list_dir", "read_file", "write_file", "edit_file"].map(callToolGroup))
      .toEqual(["t_look", "t_clipboard", "t_clipboard", "t_open_url", "t_memory", "t_web", "t_plan", "t_files", "t_files", "t_files", "t_files"]);
  });

  it("says nothing for a tool it does not know, since a call has no total to add it to", () => {
    for (const unknown of ["screenshot", "Bash", "constructor", null]) callToolFact(unknown);
    expect(sent).toEqual([]);
  });

  it("sends one group at a time", () => {
    callToolFact("clipboard_write");
    expect(facts("call")).toEqual([{ t_clipboard: 1 }]);
  });
});

describe("permission asks", () => {
  const options = [
    { id: "once", kind: "allow_once" }, { id: "always", kind: "allow_always" }, { id: "no", kind: "reject_once" }, { id: "never", kind: "reject_always" }, { id: "plain" },
  ];

  it("reads the outcome from the option the person picked", () => {
    expect(askOutcome(options, "once")).toBe("allowed_once");
    expect(askOutcome(options, "always")).toBe("allowed_always");
    expect(askOutcome(options, "no")).toBe("rejected");
    expect(askOutcome(options, "never")).toBe("rejected");
    expect(askOutcome(options, "plain")).toBe("allowed_once");
    expect(askOutcome(options, PERMISSION_CANCELLED)).toBe("cancelled");
  });

  it("takes the canonical ids a voice answer may use", () => {
    expect(askOutcome([], "allow")).toBe("allowed_once");
    expect(askOutcome([], "always")).toBe("allowed_always");
    expect(askOutcome([], "deny")).toBe("rejected");
  });

  it("folds every outcome into the counts a session carries", () => {
    const outcomes: PermissionOutcome[] = ["allowed_once", "allowed_always", "rejected", "timeout", "cancelled", "auto_allowed"];
    for (const o of outcomes) permissionFact("flow", o);
    expect(facts("flow")).toEqual([
      { perm_asks: 1, perm_allowed: 1 }, { perm_asks: 1, perm_allowed: 1 }, { perm_asks: 1, perm_denied: 1 },
      { perm_asks: 1, perm_timeout: 1 }, { perm_asks: 1 }, { perm_asks: 1, perm_auto: 1 },
    ]);
  });

  it("goes to the surface that asked", () => {
    permissionFact("call", "timeout");
    expect(facts("call")).toEqual([{ perm_asks: 1, perm_timeout: 1 }]);
    expect(facts("flow")).toEqual([]);
  });
});

describe("brain errors", () => {
  const brain = { brain_kind: "acp", brain_id: "codex" } as const;

  it("sends one event per class and brain in five minutes, and counts every failure", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    reportBrainError("flow", brain, "agent_stalled");
    reportBrainError("flow", brain, "agent_stalled");
    reportBrainError("flow", { ...brain, brain_id: "cursor" }, "agent_stalled");
    reportBrainError("flow", brain, "agent_crashed");
    expect(events("brain_error").map((p) => [p.class, p.brain_id])).toEqual([["agent_stalled", "codex"], ["agent_stalled", "cursor"], ["agent_crashed", "codex"]]);
    expect(facts("flow")).toEqual([{ errors: 1 }, { errors: 1 }, { errors: 1 }, { errors: 1 }]);

    vi.setSystemTime(1_000_000 + 4 * 60_000);
    reportBrainError("flow", brain, "agent_stalled");
    expect(events("brain_error")).toHaveLength(3);
    vi.setSystemTime(1_000_000 + 5 * 60_000);
    reportBrainError("flow", brain, "agent_stalled");
    expect(events("brain_error")).toHaveLength(4);
  });

  it("carries what the schema asks for and nothing of the message", () => {
    reportBrainError("call", { brain_kind: "api", brain_id: "openai" }, "auth", { http: "4xx" });
    expect(events("brain_error")).toEqual([{ surface: "call", brain_kind: "api", brain_id: "openai", class: "auth", http_class: "4xx" }]);
    reportBrainError("call", brain, "agent_crashed", { recovered: true });
    expect(events("brain_error")[1]).toMatchObject({ class: "agent_crashed", recovered: true, http_class: "none" });
  });

  it("reads the class from the wire code, else from the words, with the HTTP family of the class beside it", () => {
    reportTurnError("call", { brain_kind: "api", brain_id: "openai" }, { message: "HTTP 503: down" });
    reportTurnError("call", { brain_kind: "api", brain_id: "anthropic" }, { code: "quota", message: "Anthropic: API quota exhausted" });
    expect(events("brain_error").map((p) => [p.class, p.http_class])).toEqual([["server_error", "5xx"], ["quota", "4xx"]]);
  });

  it("leaves a supervised agent's own incidents to its supervisor", () => {
    for (const code of ["agent_no_output", "agent_stalled", "agent_crashed"] as const) reportTurnError("flow", brain, { code, message: "x" });
    expect(sent).toEqual([]);
    reportTurnError("flow", brain, { code: "agent_refused", message: "x" });
    expect(events("brain_error")).toMatchObject([{ class: "agent_refused", http_class: "none" }]);
  });

  it("still counts when settings could not name the brain", () => {
    reportBrainError("flow", {}, "other");
    reportBrainError("flow", {}, "other");
    expect(events("brain_error")).toEqual([{ surface: "flow", class: "other", http_class: "none" }]);
    expect(facts("flow")).toHaveLength(2);
  });
});

describe("exceptions", () => {
  it("send at most three a launch, whichever kind", () => {
    for (const kind of ["uncaught", "unhandled_rejection", "uncaught", "uncaught", "unhandled_rejection"] as const) reportException(kind);
    expect(events("main_exception")).toEqual([
      { process: "agent", kind: "uncaught" }, { process: "agent", kind: "unhandled_rejection" }, { process: "agent", kind: "uncaught" },
    ]);
  });
});

describe("first answered turn", () => {
  const steps = () => events("onboarding_step").map((p) => p.step);

  it("marks the surface once, and activation once, however many turns answer", () => {
    reportReply("flow");
    reportReply("flow");
    reportReply("call");
    reportReply("call");
    expect(steps()).toEqual(["first_flow_reply", "activated", "first_call_reply"]);
  });

  it("starts over with each launch", () => {
    reportReply("call");
    limits.clear();
    reportReply("call");
    expect(steps()).toEqual(["first_call_reply", "activated", "first_call_reply", "activated"]);
  });
});

describe("TurnTimer", () => {
  it("measures the first text and the whole turn from when it was taken", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const t = new TurnTimer();
    vi.advanceTimersByTime(400);
    t.firstText();
    vi.advanceTimersByTime(600);
    t.firstText();
    expect(t.timings(true)).toEqual({ ttft_ms: 400, turn_ms: 1000 });
  });

  it("omits what was not measured: no text, no ttft; unfinished, no turn time", () => {
    vi.useFakeTimers();
    const t = new TurnTimer();
    vi.advanceTimersByTime(250);
    expect(t.timings(true)).toEqual({ turn_ms: 250 });
    expect(t.timings(false)).toEqual({});
    t.firstText();
    expect(t.timings(false)).toEqual({ ttft_ms: 250 });
  });
});
