"use strict";
// When a crashed server comes back. Pure, so the schedule tests without Electron.

// Waits before the 1st..6th restart in a row. A cold start on a busy disk can take
// longer than the old fixed half second, and a real fault is not fixed by retrying fast.
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];
// A server that ran this long was healthy, so its next crash starts the count over.
const STABLE_MS = 60000;

/** Wait before the next restart in ms, or null when the budget is spent. Mutates `budget.count`. */
function nextRestartDelay(budget, uptimeMs) {
  if (uptimeMs >= STABLE_MS) budget.count = 0;
  budget.count += 1;
  return budget.count > BACKOFF_MS.length ? null : BACKOFF_MS[budget.count - 1];
}

module.exports = { nextRestartDelay };
