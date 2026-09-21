// Node stores a timer delay in a 32-bit int. Anything larger is silently clamped
// to 1ms, which turns "archive after a day of silence" into a wakeup storm, so a
// long window is served by re-arming against a deadline instead.
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Rolling idle window: event-driven, reset on every append, never polled. */
export class IdleTimer {
  private timer: NodeJS.Timeout | null = null;
  private deadline = 0;

  constructor(private readonly delayMs: number, private readonly onExpire: () => void) {}

  /** Restart the window. Called on every append. */
  reset(): void {
    this.deadline = Date.now() + Math.max(1, this.delayMs);
    this.arm();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = 0;
  }

  get armed(): boolean { return this.timer !== null; }

  /** Milliseconds this timer actually asked Node for, which is never above the limit. */
  get pendingMs(): number { return Math.min(Math.max(1, this.deadline - Date.now()), MAX_TIMEOUT_MS); }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.pendingMs);
    // An idle window must never be the reason Electron stays alive.
    this.timer.unref?.();
  }

  private fire(): void {
    if (Date.now() < this.deadline) { this.arm(); return; } // long window, next leg
    this.stop();
    this.onExpire();
  }
}
