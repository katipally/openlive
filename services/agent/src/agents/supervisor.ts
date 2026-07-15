import type { Message } from "@openlive/harness";
import type { Emit } from "../tools.js";
import type { Agent, AgentId, TurnInput } from "./types.js";

// Reliability wrapper every agent runs inside. External agents are child processes
// that can hang, crash, or flood — the live session must NEVER be left stuck
// listening. Guarantees per turn: output starts within a deadline, output that
// stalls mid-turn gets cut, a crashed agent is rebuilt once (with its history),
// and every failure ends as a SPOKEN one-liner + error event — no silent fallback
// (that masks breakage; the message names the fix).
export type SupervisorTimeouts = { startMs: number; firstOutputMs: number; stallMs: number };
const DEFAULTS: SupervisorTimeouts = { startMs: 15_000, firstOutputMs: 30_000, stallMs: 60_000 };

const LABEL: Record<AgentId, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" };

export class AgentSupervisor implements Agent {
  readonly id: AgentId;
  private agent: Agent;
  private history: Message[] = [];
  private restarted = false; // restart-once-then-fail
  private t: SupervisorTimeouts;

  constructor(private factory: () => Agent, timeouts?: Partial<SupervisorTimeouts>) {
    this.agent = factory();
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

  async dispose(): Promise<void> { await this.agent.dispose(); }

  health() { return this.agent.health?.() ?? { ok: true }; }

  async setModel(modelId: string): Promise<void> { await this.agent.setModel?.(modelId); }
  async setMode(modeId: string): Promise<void> { await this.agent.setMode?.(modeId); }

  async runTurn(input: TurnInput, emit: Emit, signal: AbortSignal): Promise<void> {
    // Child controller so a watchdog timeout can cut the agent without the
    // session's signal (which also gates late emits) looking like a barge-in.
    const ac = new AbortController();
    const onAbort = () => ac.abort((signal as AbortSignal & { reason?: unknown }).reason);
    signal.addEventListener("abort", onAbort, { once: true });

    let last = Date.now();
    let sawOutput = false;
    let timedOut = false;
    let spoken = ""; // assistant text this turn, for history-on-restart
    const guarded: Emit = (e) => {
      // A watchdog cut (or barge-in) aborts `ac`; an agent that ignores its cancel
      // signal and emits late must be silenced here, or its ghost text is spoken
      // over dead air / the next turn (the session's own signal isn't aborted).
      if (ac.signal.aborted) return;
      last = Date.now();
      if (e.type === "text_delta") { sawOutput = true; spoken += e.text; }
      else if (e.type === "tool_start" || e.type === "reasoning_delta") sawOutput = true;
      return emit(e);
    };
    const watchdog = setInterval(() => {
      const limit = sawOutput ? this.t.stallMs : this.t.firstOutputMs;
      if (Date.now() - last > limit) { timedOut = true; ac.abort(); }
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
      this.restarted = false;
      this.history.push({ role: "user", text: input.text });
      if (spoken.trim()) this.history.push({ role: "assistant", text: spoken.trim() });
    } catch (e: any) {
      if (signal.aborted) return; // barge-in / session end — not a failure
      const detail = timedOut
        ? (sawOutput ? "stopped mid-answer" : "didn't start answering")
        : `crashed (${String(e?.message ?? e)})`;
      console.error(`[agent:${this.id}]`, e);
      await this.recycle();
      await emit({ type: "text_delta", text: `Sorry — ${LABEL[this.id]} ${timedOut ? detail : "stopped responding"}. ${this.restarted ? "I've restarted it — try again." : "Check that it's installed and signed in."}` });
      await emit({ type: "error", message: `Agent "${this.id}" ${detail}` });
    } finally {
      clearInterval(watchdog);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Rebuild the agent once per incident, carrying the text history forward. Awaited
   *  so the "I've restarted it — try again" line is truthful. */
  private async recycle(): Promise<void> {
    if (this.restarted) return;
    this.restarted = true;
    try { await this.agent.dispose(); } catch { /* already dead */ }
    try {
      this.agent = this.factory();
      this.agent.seed(this.history);
      const ac = new AbortController();
      await this.withStartTimeout(this.agent.start(ac.signal)).catch((e) => { ac.abort(); throw e; });
    } catch (e) {
      console.error(`[agent:${this.id}] restart failed:`, e);
    }
  }

  private withStartTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`agent "${this.id}" didn't become ready within ${this.t.startMs / 1000}s`)), this.t.startMs);
      p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
  }
}
