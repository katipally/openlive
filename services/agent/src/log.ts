// One tiny scoped logger for the agent service (was ad-hoc console.* per file).
// stderr only — stdout stays clean (child agents speak JSON-RPC over stdio).
// debug is opt-in via OPENLIVE_DEBUG so routine noise never ships to users.
const err = (scope: string, ...args: unknown[]) => console.error(`[${scope}]`, ...args);

export const log = {
  error: err,
  warn: err,
  debug: (scope: string, ...args: unknown[]) => { if (process.env.OPENLIVE_DEBUG) err(scope, ...args); },
};
