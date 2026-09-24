// API mode's workspace is the folder picked on the setup screen, exactly as a
// coding agent's is: the client binds it the moment the socket opens, racing the
// server's own restore on a brand-new chat, and the file tools and History must
// both end up with it.
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

// The db resolves its data dir at import time, so this has to be set first.
const dir = mkdtempSync(join(tmpdir(), "ol-bind-"));
process.env.OPENLIVE_DATA_DIR = dir;
const { LiveSession } = await import("./session.ts");
const { listChats } = await import("@openlive/db");

afterAll(() => {
  delete process.env.OPENLIVE_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("binds the setup screen's folder for API mode on a new chat", async () => {
  const workspace = join(dir, "project");
  mkdirSync(workspace);
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, sent: [] as Record<string, any>[] });
  (ws as any).send = (raw: string) => ws.sent.push(JSON.parse(raw));
  const session = new LiveSession(ws as never, "api-chat");

  const started = session.start();
  ws.emit("message", Buffer.from(JSON.stringify({ t: "bind", agentId: null, cwd: workspace })), false);
  await started;

  const echo = ws.sent.filter((m) => m.t === "bound_state").at(-1);
  expect(echo).toMatchObject({ agentId: null, cwd: realpathSync(workspace) });
  expect(listChats().find((c) => c.id === "api-chat")?.cwd).toBe(realpathSync(workspace));
  ws.emit("close");
});
