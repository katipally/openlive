import { afterEach, describe, expect, it, vi } from "vitest";

// React Query runs no intervals where there is no window; this is the renderer's case.
vi.hoisted(() => { (globalThis as { window?: unknown }).window ??= globalThis; });

const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
const { watchWindowShown, windowShown } = await import("./windowShown");

/** Main's side of the bridge: one listener, told what main would send. */
function bridge() {
  let cb: ((shown: boolean) => void) | null = null;
  return {
    subscribe: (f: (shown: boolean) => void) => { cb = f; return () => { cb = null; }; },
    tell: (shown: boolean) => cb?.(shown),
  };
}

/** A query polled every second, counting its fetches, with an observer to keep it active. */
function polled(qc: InstanceType<typeof QueryClient>, every: number | false = 1000) {
  let fetches = 0;
  const observer = new QueryObserver(qc, { queryKey: ["polled", every], queryFn: async () => ++fetches, refetchInterval: every, staleTime: Infinity });
  const stop = observer.subscribe(() => {});
  return { fetches: () => fetches, stop };
}

const stops: Array<() => void> = [];
afterEach(() => { for (const f of stops.splice(0)) f(); vi.useRealTimers(); });

describe("watchWindowShown", () => {
  it("pauses an interval while the window is hidden, and refetches once as it comes back", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const main = bridge();
    stops.push(watchWindowShown(qc, main.subscribe));
    const q = polled(qc);
    stops.push(q.stop);
    await vi.advanceTimersByTimeAsync(3000);
    const before = q.fetches();
    expect(before).toBeGreaterThanOrEqual(3);

    main.tell(false);
    expect(windowShown()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(q.fetches()).toBe(before);

    main.tell(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(q.fetches()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(q.fetches()).toBe(before + 2);
  });

  it("leaves a query that does not poll alone when the window comes back", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const main = bridge();
    stops.push(watchWindowShown(qc, main.subscribe));
    const q = polled(qc, false);
    stops.push(q.stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(q.fetches()).toBe(1);
    main.tell(false);
    main.tell(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(q.fetches()).toBe(1);
  });

  it("counts as shown with no bridge, and again once stopped", () => {
    const qc = new QueryClient();
    expect(windowShown()).toBe(true);
    watchWindowShown(qc)();
    const main = bridge();
    const stop = watchWindowShown(qc, main.subscribe);
    main.tell(false);
    expect(windowShown()).toBe(false);
    stop();
    expect(windowShown()).toBe(true);
  });
});
