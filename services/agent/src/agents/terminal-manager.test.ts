// Hosted terminals are the ACP feature with real processes behind it — if kill
// or release leak children, every barge-in leaves a command churning.
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { SseEvent } from "@openlive/shared";
import { TerminalManager } from "./terminal-manager.ts";

const mk = (events?: SseEvent[]) =>
  new TerminalManager({ cwd: () => process.cwd(), emit: () => (events ? async (e: SseEvent) => { events.push(e); } : null) });

// The manager runs commands through a shell on Windows (needed for .cmd shims),
// where cmd.exe mangles an inline `node -e` script's quotes and parens. Run the
// script from a file so the same capture/exit/kill behavior is tested on every OS.
const nodeScript = (code: string): { command: string; args: string[] } => {
  const file = join(mkdtempSync(join(tmpdir(), "ol-term-")), "s.cjs");
  writeFileSync(file, code);
  return { command: "node", args: [file] };
};

test("captures interleaved output and the exit code", async () => {
  const tm = mk();
  const { terminalId } = tm.create(nodeScript("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"));
  const exit = await tm.waitForExit(terminalId);
  assert.equal(exit.exitCode, 3);
  const out = tm.output(terminalId);
  assert.ok(out.output.includes("out") && out.output.includes("err"));
  assert.equal(out.truncated, false);
  assert.deepEqual(out.exitStatus, { exitCode: 3, signal: null });
  tm.disposeAll();
});

test("output cap keeps the tail and sets truncated", async () => {
  const tm = mk();
  const { terminalId } = tm.create({
    ...nodeScript("process.stdout.write('x'.repeat(5000) + 'TAIL')"),
    outputByteLimit: 2048,
  });
  await tm.waitForExit(terminalId);
  const out = tm.output(terminalId);
  assert.ok(out.truncated, "truncated flagged");
  assert.ok(out.output.length <= 2048);
  assert.ok(out.output.endsWith("TAIL"), "kept the tail");
  tm.disposeAll();
});

test("kill terminates a hanging command but keeps the buffer readable; release forgets it", async () => {
  const tm = mk();
  const { terminalId } = tm.create(nodeScript("process.stdout.write('started'); setInterval(() => {}, 1000)"));
  // Wait for output so we know it's running.
  await new Promise((r) => setTimeout(r, 300));
  tm.kill(terminalId);
  const exit = await tm.waitForExit(terminalId);
  assert.ok(exit.exitCode !== 0 || exit.signal, "did not exit cleanly");
  assert.ok(tm.output(terminalId).output.includes("started"), "buffer survives the kill");
  tm.release(terminalId);
  assert.throws(() => tm.output(terminalId), /unknown terminal/);
  tm.disposeAll();
});

test("live output streams as batched term_output events + a final term_exit", async () => {
  const events: SseEvent[] = [];
  const tm = mk(events);
  const { terminalId } = tm.create(nodeScript("process.stdout.write('hello')"));
  await tm.waitForExit(terminalId);
  await new Promise((r) => setTimeout(r, 150)); // let the final flush land
  const chunks = events.filter((e) => e.type === "term_output").map((e) => (e as { chunk: string }).chunk).join("");
  assert.ok(chunks.includes("hello"));
  assert.ok(events.some((e) => e.type === "term_exit" && (e as { exitCode?: number | null }).exitCode === 0));
  tm.disposeAll();
});
