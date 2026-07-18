import type { Message } from "@openlive/harness";
import { agentLabel } from "@openlive/shared";
import type { Emit } from "../tools.js";
import type { Agent, AgentId, AskPermission, TurnInput } from "./types.js";
import { log } from "../log.js";

// Reliability wrapper every agent runs inside. External agents are child processes
// that can hang, crash, or flood — the live session must NEVER be left stuck
// listening. Guarantees per turn: output starts within a deadline, output that
// stalls mid-turn gets cut, a crashed agent is rebuilt once (with its history),
// and every failure ends as a SPOKEN one-liner + error event — no silent fallback
// (that masks breakage; the message names the fix).
export type SupervisorTimeouts = { startMs: number; firstOutputMs: number; stallMs: number };
const DEFAULTS: SupervisorTimeouts = { startMs: 15_000, firstOutputMs: 30_000, stallMs: 60_000 };

// Restart-seed history caps: 40 entries ≈ 2× the session's own HISTORY_TURNS
// rehydrate window; 4KB per entry keeps a pasted wall of text from pinning memory.
const MAX_HISTORY = 40;
const MAX_ENTRY_CHARS = 4096;
export const clipHistoryText = (t: string): string => (t.length > MAX_ENTRY_CHARS ? `${t.slice(0, MAX_ENTRY_CHARS)}…` : t);

export class AgentSupervisor implements Agent {
  readonly id: AgentId;
  private agent: Agent;
  private history: Message[] = [];
  private restartAttempted = false; // one restart per incident (the guard)
  private restarted = false;        // the last restart actually SUCCEEDED (drives the spoken line)
  private disposed = false;         // once torn down, never recycle a new child (orphan-proof)
  private awaitingUser = false;     // a permission ask is pending — the watchdog must not count this as a stall
  private lastActivity = 0;         // updated on output AND when a permission ask settles
  private ask: AskPermission;
  private t: SupervisorTimeouts;

  constructor(private factory: (ask: AskPermission) => Agent, askPermission: AskPermission, timeouts?: Partial<SupervisorTimeouts>) {
    // The agent asks the user for permission through us, so we can PAUSE the stall
    // watchdog while the user is deciding (they get 120s; the watchdog fires at 30–60s
    // of silence — without this it would abort + restart mid-decision).
    this.ask = async (q, o, toolCallId) => {
      this.awaitingUser = true;
      try { return await askPermission(q, o, toolCallId); }
      finally { this.awaitingUser = false; this.lastActivity = Date.now(); }
    };
    this.agent = factory(this.ask);
    this.id = this.agent.id;
    this.t = { ...DEFAULTS, ...timeouts };
  }

  async start(signal: AbortSignal): Promise<void> {
    await this.withStartTimeout(this.agent.start(signal));
  }

  seed(history: Message[]) {
    this.history = [...history];
    this.agent.seed(history);
  }

  async dispose(): Promise<void> { this.disposed = true; await this.agent.dispose(); }

  async setModel(modelId: string): Promise<void> { await this.agent.setModel?.(modelId); }
  async setMode(modeId: string): Promise<void> { await this.agent.setMode?.(modeId); }
  async setOption(optionId: string, valueId: string): Promise<void> { await this.agent.setOption?.(optionId, valueId); }

  async runTurn(input: TurnInput, emit: Emit, signal: AbortSignal): Promise<void> {
    // Child controller so a watchdog timeout can cut the agent without the
    // session's signal (which also gates late emits) looking like a barge-in.
    const ac = new AbortController();
    const onAbort = () => ac.abort((signal as AbortSignal & { reason?: unknown }).reason);
    signal.addEventListener("abort", onAbort, { once: true });

    this.lastActivity = Date.now();
    let sawOutput = false;
    let timedOut = false;
    let spoken = ""; // assistant text this turn, for history-on-restart
    const guarded: Emit = (e) => {
      // A watchdog cut (or barge-in) aborts `ac`; an agent that ignores its cancel
      // signal and emits late must be silenced here, or its ghost text is spoken
      // over dead air / the next turn (the session's own signal isn't aborted).
      if (ac.signal.aborted) return;
      this.lastActivity = Date.now();
      if (e.type === "text_delta") { sawOutput = true; spoken += e.text; }
      else if (e.type === "tool_start" || e.type === "acp_tool_call" || e.type === "reasoning_delta") sawOutput = true;
      return emit(e);
    };
    const watchdog = setInterval(() => {
      if (this.awaitingUser) { this.lastActivity = Date.now(); return; } // waiting on the user, not stalled
      const limit = sawOutput ? this.t.stallMs : this.t.firstOutputMs;
      if (Date.now() - this.lastActivity > limit) { timedOut = true; ac.abort(); }
    }, 250);

    try {
      // Race the turn against the abort: a truly hung agent can ignore its cancel
      // signal and never settle its promise — the session must never inherit that
      // hang. The orphaned promise is swallowed (.catch) and the agent recycled below.
      const turn = this.agent.runTurn(input, guarded, ac.signal);
      turn.catch(() => {});
      await Promise.race([
        turn,
        new Promise<never>((_, reject) => ac.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
      ]);
      if (timedOut) throw new Error(sawOutput ? "stopped mid-answer" : "didn't start answering");
      // A clean turn means the (possibly restarted) agent is healthy again — refresh
      // the restart budget so a LATER, unrelated failure still gets its one restart.
      this.restartAttempted = false;
      this.history.push({ role: "user", text: clipHistoryText(input.text) });
      if (spoken.trim()) this.history.push({ role: "assistant", text: clipHistoryText(spoken.trim()) });
      // History only exists to re-seed a restarted child — keep it bounded or a
      // long call accumulates every turn's full text in memory forever.
      if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    } catch (e: any) {
      if (signal.aborted) return; // barge-in / session end — not a failure
      const detail = timedOut
        ? (sawOutput ? "stopped mid-answer" : "didn't start answering")
        : `crashed (${String(e?.message ?? e)})`;
      log.error(`agent:${this.id}`, e);
      await this.recycle();
      // A recovery NOTICE — not part of the agent's answer. Emit it as an error so the
      // client speaks it out-of-band (engine.say) and shows a banner, instead of a
      // text_delta that gets concatenated into — and persisted as — the agent's reply.
      await emit({ type: "error", message: `${agentLabel(this.id)} ${timedOut ? detail : "stopped responding"}. ${this.restarted ? "I've restarted it — say that again." : "Check that it's installed and signed in."}` });
    } finally {
      clearInterval(watchdog);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Rebuild the agent once per incident, carrying the text history forward. Sets
   *  `restarted` only when the new child actually becomes ready, so the spoken
   *  "I've restarted it" line is truthful (a crash-loop says "check it's installed"). */
  private async recycle(): Promise<void> {
    if (this.restartAttempted || this.disposed) return;
    this.restartAttempted = true;
    this.restarted = false;
    try { await this.agent.dispose(); } catch { /* already dead */ }
    if (this.disposed) return; // session torn down mid-recycle — don't spawn an orphan
    try {
      const next = this.factory(this.ask);
      next.seed(this.history);
      const ac = new AbortController();
      await this.withStartTimeout(next.start(ac.signal)).catch((e) => { ac.abort(); throw e; });
      if (this.disposed) { await next.dispose().catch(() => {}); return; } // disposed while starting
      this.agent = next;
      this.restarted = true;
    } catch (e) {
      log.error(`agent:${this.id}`, "restart failed:", e);
    }
  }

  private withStartTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`agent "${this.id}" didn't become ready within ${this.t.startMs / 1000}s`)), this.t.startMs);
      p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
  }
}
