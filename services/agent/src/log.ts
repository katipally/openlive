import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

// One tiny scoped logger for the agent service (was ad-hoc console.* per file).
// stderr only — stdout stays clean (child agents speak JSON-RPC over stdio).
// debug is opt-in via OPENLIVE_DEBUG so routine noise never ships to users.
const err = (scope: string, ...args: unknown[]) => console.error(`[${scope}]`, ...args);

export const log = {
  error: err,
  warn: err,
  debug: (scope: string, ...args: unknown[]) => { if (process.env.OPENLIVE_DEBUG) err(scope, ...args); },
};

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Old files kept beside agent.log: agent.log.1 is the newest. */
export const LOG_KEEP = 2;

/**
 * Everything the agent writes to stderr also goes to `<dir>/agent.log`, each
 * line stamped with the time, and the file rotates past LOG_MAX_BYTES. Called
 * once, by the server. A log that cannot be written never stops the agent.
 */
export function teeStderr(dir: string): void {
  const file = join(dir, "agent.log");
  let size = 0;
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); size = statSync(file).size; } catch { /* no log yet */ }
  let lineStart = true;
  const write = process.stderr.write.bind(process.stderr) as (...a: unknown[]) => boolean;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    try {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const ts = `${new Date().toISOString()} `;
      const line = Buffer.from((lineStart ? ts : "") + text.replace(/\n(?=[^])/g, `\n${ts}`));
      lineStart = text.endsWith("\n");
      if (size + line.length > LOG_MAX_BYTES) {
        size = 0;
        for (let n = LOG_KEEP; n >= 1; n--) try { renameSync(n > 1 ? `${file}.${n - 1}` : file, `${file}.${n}`); } catch { /* not there yet */ }
      }
      appendFileSync(file, line, { mode: 0o600 });
      size += line.length;
    } catch { /* the log is a copy; stderr still has it */ }
    return write(chunk, ...rest);
  }) as typeof process.stderr.write;
}
