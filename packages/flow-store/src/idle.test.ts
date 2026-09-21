import { expect, test, vi } from "vitest";
import { IdleTimer, MAX_TIMEOUT_MS } from "./idle";

test("a window past Node's 32-bit limit is clamped and re-armed, not fired at once", () => {
  vi.useFakeTimers();
  try {
    let fired = 0;
    const timer = new IdleTimer(MAX_TIMEOUT_MS * 3, () => { fired++; });
    timer.reset();
    expect(timer.pendingMs).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
    vi.advanceTimersByTime(MAX_TIMEOUT_MS);
    expect(fired).toBe(0); // first leg only
    expect(timer.armed).toBe(true);
    vi.advanceTimersByTime(MAX_TIMEOUT_MS * 2);
    expect(fired).toBe(1);
    expect(timer.armed).toBe(false);
    timer.stop();
  } finally { vi.useRealTimers(); }
});

test("reset pushes the deadline out, stop cancels", () => {
  vi.useFakeTimers();
  try {
    let fired = 0;
    const timer = new IdleTimer(1000, () => { fired++; });
    timer.reset();
    vi.advanceTimersByTime(900);
    timer.reset();
    vi.advanceTimersByTime(900);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(200);
    expect(fired).toBe(1);

    timer.reset();
    timer.stop();
    vi.advanceTimersByTime(5000);
    expect(fired).toBe(1);
  } finally { vi.useRealTimers(); }
});
