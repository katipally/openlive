// One driver at a time. Every action that moves the pointer, types, or changes
// what is on screen takes this lock, whichever session asked and whichever
// path carries it (the computer-use helper or ol-input), so a call and Flow, or
// two coding agents, never interleave clicks in the same app.

export class InputLock {
  private tail: Promise<unknown> = Promise.resolve();

  /** Run `fn` once every earlier holder is done, first come first served. A
   *  caller whose turn was cancelled while it waited is dropped, not run late. */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.tail.then(() => {
      if (signal?.aborted) throw new Error("Cancelled before it was this action's turn.");
      return fn();
    });
    this.tail = result.catch(() => {});
    return result;
  }
}

/** The machine's one lock. */
export const inputLock = new InputLock();
