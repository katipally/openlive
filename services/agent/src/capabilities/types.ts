import type { FlowContentWire, FlowContextWire, SseEvent } from "@openlive/shared";
import type { DevicePort } from "./device.js";
import type { ComputerPort } from "../computer/helper.js";
import type { ElicitationAnswer, ElicitationAsk } from "../agents/index.js";

// One tool shape for every surface. Chat's loop, Flow's loop and the MCP server
// a coding agent reaches all run the same `Tool` through the same dispatch.

/** A turn's UI events: tool chips, the checklist. */
export type Emit = (e: SseEvent) => Promise<void> | void;

export type TextPart = Extract<FlowContentWire, { type: "text" }>;
export type ImagePart = Extract<FlowContentWire, { type: "image" }>;

/** What the app in front is and what is selected in it. The wire schema is the source of truth. */
export type FlowContext = FlowContextWire;

export interface ToolResult<D = unknown> {
  /** Bounded, model-facing. */
  content: (TextPart | ImagePart)[];
  /** Rich, UI-facing. Same return value, no second channel. */
  details: D;
  /** The tool believes the turn is finished. A batch ends the run only if every call agrees. */
  terminate?: boolean;
}

/**
 * Forward-only text insertion into whatever app the user is in.
 *
 * `commit` takes the WHOLE text known so far, not a chunk, and inserts only
 * what has not been inserted yet for this call id. Text that diverges from what
 * was already committed is dropped: the model does not get to rewrite words
 * already sitting in the user's document. Must not throw.
 */
export interface InsertionSink {
  commit(id: string, text: string): Promise<void>;
  end(id: string): Promise<void>;
  /**
   * End a call whose tool never ran. What it already typed becomes the baseline
   * for the next call, so the model's retry under a fresh id continues the
   * user's document instead of typing the same sentence a second time.
   */
  abandon(id: string): Promise<void>;
  /** How much of this call's text has already reached the user's app. */
  committed(id: string): string;
}

/** Reads and writes the system clipboard. Implementations must not throw for an empty clipboard. */
export interface ClipboardPort {
  read(): Promise<string>;
  /** Resolves to how it went, in a sentence, where the platform says. */
  write(text: string): Promise<string | void>;
}

/**
 * Captures the free metadata around a turn. Must not throw: return null instead.
 */
export interface ContextProvider {
  capture(signal: AbortSignal): Promise<FlowContext | null>;
}

/** The camera or screen a call is sharing live. */
export interface LiveShare {
  showing(): "camera" | "screen" | null;
  /** One fresh frame, or null when none came back in time. */
  frame(): Promise<{ data: string; mime: string } | null>;
}

/**
 * What one session can reach. A tool is offered only where what it needs is
 * here, so one registry serves a call and Flow, whichever brain drives them.
 */
export interface Session {
  /** The app in front, captured once a turn. */
  foreground?: ContextProvider;
  /** Typing at the user's cursor, in whatever app they are in. */
  insert?: InsertionSink;
  clipboard?: ClipboardPort;
  /** Perception and control of the machine, through the ol-input addon. */
  device?: DevicePort;
  /** The computer-use helper, where it runs. Supersedes ol-input's pointer, keyboard and screenshot tools. */
  computer?: ComputerPort;
  /** Opening a page in the default browser, for a session without the device. */
  openUrl?: (url: string) => Promise<string>;
  share?: LiveShare;
  /** The project folder. Read per call, because the user can change it mid-session. */
  workspace?: () => string;
  emit?: Emit;
  /** Ask the person something a tool's server needs mid-call: a page to visit or a form. */
  elicit?: (req: ElicitationAsk) => Promise<ElicitationAnswer>;
}

export interface ToolCtx extends Session {
  signal: AbortSignal;
  /** The metadata captured for this turn, or null when nothing could be read. */
  context: FlowContext | null;
  /** The call id the model used, so a tool can address its own insertion stream. */
  callId: string;
}

export interface Tool<P = any, D = any> {
  name: string;
  description: string;
  /** JSON Schema. One object goes to the provider, to disk and over MCP unchanged. */
  parameters: Record<string, unknown>;
  /** Lines contributed to the system prompt when this tool is available. */
  promptGuidelines?: string[];
  /** It only reads. Said over MCP, so Codex runs it without asking first. */
  readOnly?: boolean;
  /** It changes something the user may want to stop first. Finishes the
   *  sentence "OpenLive wants to …" for a policy that asks per action. */
  confirm?: (args: P) => string;
  /** Cheap checks dispatch runs before asking for approval, so nobody is asked
   *  to approve a call that would fail anyway. Throws to refuse, as `execute` does. */
  precheck?: (args: P, ctx: ToolCtx) => Promise<void> | void;
  /** Whether a session can run it at all. Omitted: every session. */
  available?: (s: Session) => boolean;
  execute(args: P, ctx: ToolCtx): Promise<ToolResult<D>>;
}

/** May this call run? Must not throw; a throw is treated as a block. */
export type Approve = (
  req: { tool: Tool; args: unknown },
  signal: AbortSignal,
) => Promise<{ block: true; reason: string } | { block?: false }>;
