import { vi } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test scaffolding for the telemetry modules: a temp userData dir, a fake clock,
// and a recording `post` that stands in for the network. Nothing here can reach a host.
const require = createRequire(import.meta.url);
const { createTelemetry } = require("./index.cjs");

export const DAY_1 = new Date(2026, 8, 29, 12, 0, 0);
export const DAY_2 = new Date(2026, 8, 30, 12, 0, 0);

export const tmpDir = () => mkdtempSync(join(tmpdir(), "openlive-telemetry-"));
export const CONFIG = { endpoint: "https://ingest.example.test", clientId: "11111111-2222-4333-8444-555555555555", origin: "https://app.example.test" };

export type Sent = { url: string; headers: Record<string, string>; body: string; json: { type: string; payload: Record<string, any> } };
export const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
export const readLines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
export const modeOf = (file: string) => statSync(file).mode & 0o777;

let idCounter = 0;
export function rig(over: Record<string, unknown> = {}) {
  const dir = (over.userDataDir as string) ?? tmpDir();
  const sent: Sent[] = [];
  const respond = { status: 200, retryAfter: undefined as string | undefined, fail: false };
  const post = vi.fn(async (req: Omit<Sent, "json">) => {
    sent.push({ ...req, json: JSON.parse(req.body) });
    if (respond.fail) throw new Error("offline");
    return { status: respond.status, retryAfter: respond.retryAfter };
  });
  const deps = {
    userDataDir: dir,
    config: CONFIG,
    isPackaged: true,
    env: {},
    argv: [],
    appVersion: "1.2.3",
    platform: "darwin",
    arch: "arm64",
    archTranslated: false,
    osMajor: "15",
    post,
    random: () => 0.5,
    randomId: () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`,
    sleep: async () => {},
    ...over,
  };
  const telemetry = createTelemetry(deps);
  const file = (name: string) => join(dir, name);
  return {
    dir,
    telemetry,
    sent,
    respond,
    post,
    queue: () => readLines(file("telemetry-queue.jsonl")),
    state: () => readJson(file("telemetry.json")),
    names: () => sent.filter((s) => s.json.type === "track").map((s) => s.json.payload.name as string),
    file,
    /** A second run of the app over the same userData. */
    again: (more: Record<string, unknown> = {}) => rig({ ...over, userDataDir: dir, ...more }),
    touch: (name: string, body = "{}") => {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(file(name), body);
    },
  };
}

type Channel = { handleRendererMessage(msg: unknown): void; handleAgentMessage(msg: unknown): void };
/** The renderer and agent messages main hands to telemetry, as calls. */
export const notice = (t: Channel) => t.handleRendererMessage({ t: "notice" });
export const count = (t: Channel, key: string) => t.handleRendererMessage({ t: "count", key });
export const answer = (t: Channel, a: Record<string, unknown>) => t.handleRendererMessage({ t: "feedback", ...a });
export const fact = (t: Channel, scope: string, props: unknown) =>
  scope === "agent_flow" || scope === "agent_call"
    ? t.handleAgentMessage({ openlive: "telemetry", v: 1, kind: "fact", scope: scope.slice(6), props })
    : t.handleRendererMessage({ t: "fact", scope, props });

export const flush = (ms = 200_000) => vi.advanceTimersByTimeAsync(ms);
