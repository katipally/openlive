import { create } from "zustand";
import type { ModelProgress } from "./models";
import type { AgentId, AgentMeta, ElicitationWire, PermissionOption } from "./liveClient";

export type LivePhase = "off" | "connecting" | "loading" | "reconnecting" | "idle" | "listening" | "thinking" | "speaking";

export interface DeviceOpt { id: string; label: string }
export interface PendingPermission { reqId: string; question: string; options: PermissionOption[]; expiresAt?: number; toolCallId?: string }

interface LiveState {
  active: boolean;
  phase: LivePhase;
  modelsDownloaded: boolean; // on-device models present (cached/warm) → skip download
  downloading: boolean;      // model download in progress on the pre-call screen
  downloadPct: number; // 0..1 model-download progress (phase === "loading")
  downloadLoaded: number; // bytes downloaded so far (across all models)
  downloadTotal: number;  // bytes total known so far
  downloadModels: ModelProgress[]; // per-model breakdown for the download UI
  muted: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  screenStream: MediaStream | null;
  cameraStream: MediaStream | null;
  userCaption: string;
  userPartial: boolean; // true while the user caption is still interim (greyed)
  agentCaption: string;
  agentCaptionMs: number; // playback duration of the current agent chunk — paces the word-by-word caption reveal
  toolStatus: string; // active tool name while a tool is running (""), drives the live "Searching the web…" cue
  holdUntil: number | null; // mid-thought pause held: epoch-ms when it auto-sends (drives "waiting for you… tap to send")
  pttActive: boolean;       // push-to-talk currently held (space / global hotkey)
  pttEnabled: boolean;      // push-to-talk armed (opt-in via the in-call toggle; persisted)
  warming: boolean;   // true from socket-open until the agent signals warm-ready → shows "Warming up…"
  boundAgent: AgentId | null;         // coding agent this conversation talks to (null = built-in brain)
  boundCwd: string;                   // project folder for the bound agent ("" = default/home)
  agentMeta: AgentMeta | null;        // the bound agent's selectable models + modes (once connected)
  agentConnecting: boolean;           // pre-call: connecting to the bound agent to fetch its models/modes
  permission: PendingPermission | null; // a bound agent's pending permission ask (chips + spoken)
  todos: { text: string; done: boolean }[]; // the agent's working plan/checklist (ACP plan / update_todos)
  usage: { contextTokens: number; outputTokens?: number; contextSize?: number; costUsd: number } | null; // latest turn usage
  // Live output of client-hosted ACP terminals, keyed by terminalId. Tail-capped;
  // cleared on teardown. ToolCallCard reads these while a command runs.
  terminals: Record<string, TermBuf>;
  // A pending agent elicitation (login URL / input form), one at a time.
  elicitation: ElicitationWire | null;
  error?: string;
  micId?: string;
  camId?: string;
  mics: DeviceOpt[];
  cams: DeviceOpt[];
  set: (p: Partial<LiveState>) => void;
  termAppend: (terminalId: string, chunk: string, truncated?: boolean) => void;
  termExit: (terminalId: string, exitCode: number | null) => void;
  // Answer the pending permission ask — installed by useLiveSession while a
  // session is live, so the inline card buttons and the overlay share one path.
  answerPermission?: (optionId: string) => void;
  // Answer the pending elicitation (form submit / Done / Cancel) — installed
  // by useLiveSession while a session is live.
  answerElicitation?: (action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => void;
}

export interface TermBuf { output: string; truncated: boolean; exitCode?: number | null }
const TERM_CLIENT_CAP = 128 * 1024; // per-terminal tail cap — matches the persisted snapshot

// One live session at a time (single-user target). ponytail: global store, not
// keyed by chatId — add keying if multi-session live is ever needed.
export const useLiveStore = create<LiveState>((set) => ({
  active: false,
  phase: "off",
  modelsDownloaded: false,
  downloading: false,
  downloadPct: 0,
  downloadLoaded: 0,
  downloadTotal: 0,
  downloadModels: [],
  muted: false,
  pttEnabled: typeof window !== "undefined" && localStorage.getItem("openlive-ptt-enabled") === "1",
  cameraOn: false,
  screenOn: false,
  screenStream: null,
  cameraStream: null,
  userCaption: "",
  userPartial: false,
  agentCaption: "",
  agentCaptionMs: 0,
  toolStatus: "",
  holdUntil: null,
  pttActive: false,
  warming: false,
  boundAgent: null,
  boundCwd: "",
  agentMeta: null,
  agentConnecting: false,
  permission: null,
  todos: [],
  usage: null,
  terminals: {},
  elicitation: null,
  mics: [],
  cams: [],
  set: (p) => set(p),
  termAppend: (terminalId, chunk, truncated) =>
    set((s) => {
      const t = s.terminals[terminalId] ?? { output: "", truncated: false };
      let output = t.output + chunk;
      let clipped = t.truncated || !!truncated;
      if (output.length > TERM_CLIENT_CAP) { output = output.slice(-TERM_CLIENT_CAP); clipped = true; }
      return { terminals: { ...s.terminals, [terminalId]: { ...t, output, truncated: clipped } } };
    }),
  termExit: (terminalId, exitCode) =>
    set((s) => ({ terminals: { ...s.terminals, [terminalId]: { ...(s.terminals[terminalId] ?? { output: "", truncated: false }), exitCode } } })),
}));

// Dev-only: expose stores for debugging (removed before merge).
// ponytail: temporary test instrumentation
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as Record<string, unknown>).__olLive = useLiveStore;
}
