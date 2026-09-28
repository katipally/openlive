import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Hono } from "hono";
import { AGENT_REGISTRY, isAgentId } from "@openlive/shared";
import { widenedPath } from "@openlive/shared/node";
import { AcpAgent } from "./acp-agent.js";
import { flowAgentCwd, PERMISSION_CANCELLED, type AgentId } from "./index.js";
import type { AgentMeta, AgentSession } from "./types.js";
import { log } from "../log.js";

// Which models a coding agent offers, and how hard it can be told to think, is
// something only that agent can say, and it only says it once an ACP session exists. So this starts one in Flow's own
// folder, keeps what `session/new` reported, and shuts it down again.
//
// Starting an agent is seconds, not milliseconds, so the answer is cached and a
// caller arriving mid-probe waits on the probe already running rather than
// starting a second copy of the same CLI.

export const agentRoutes = new Hono();

const CACHE_MS = 5 * 60_000;
const PROBE_MS = 30_000;

interface Models {
  models: { id: string; name: string }[];
  currentModelId: string | null;
  /** The agent's "how hard to think" setting, where it has one. */
  effort: { id: string; label: string; values: { id: string; name: string }[]; currentId: string | null } | null;
}

const cache = new Map<AgentId, { at: number; models: Models }>();
const inflight = new Map<AgentId, Promise<Models>>();

async function probe(id: AgentId): Promise<Models> {
  const seen: AgentMeta[] = [];
  const agent = new AcpAgent(id, async () => PERMISSION_CANCELLED, {
    cwd: flowAgentCwd(),
    onMeta: (m) => { seen.push(m); },
  });
  const ac = new AbortController();
  const bell = setTimeout(() => ac.abort(), PROBE_MS);
  try {
    await agent.start(ac.signal);
    const meta = seen.at(-1);
    const effort = meta?.options.find((o) => o.category === "thought_level") ?? null;
    return {
      models: meta?.models ?? [],
      currentModelId: meta?.currentModelId ?? null,
      effort: effort && { id: effort.id, label: effort.label, values: effort.values, currentId: effort.currentId },
    };
  } finally {
    clearTimeout(bell);
    try { await agent.dispose(); } catch { /* it is going away either way */ }
  }
}

agentRoutes.get("/models", async (c) => {
  const id = c.req.query("agent")?.trim() ?? "";
  if (!isAgentId(id)) return c.json({ error: "unknown agent" }, 400);

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return c.json(hit.models);

  let run = inflight.get(id);
  if (!run) {
    run = probe(id).finally(() => inflight.delete(id));
    inflight.set(id, run);
  }
  try {
    const models = await run;
    cache.set(id, { at: Date.now(), models });
    return c.json(models);
  } catch (e) {
    log.error("agents", `models(${id}):`, e);
    return c.json({ error: e instanceof Error ? e.message : "the agent did not start" }, 502);
  }
});

// The agent's own sessions over ACP session/list, for History. Same economics as
// the models probe: initialize only (no session is made), cached, one probe per
// agent at a time. An agent that is not on PATH is never spawned, since `npx -y`
// would download an adapter for a CLI the user doesn't have.
const LIST_CACHE_MS = 60_000;
const LIST_MAX = 60;
type Listed = { supported: boolean; sessions: AgentSession[] };
const listCache = new Map<AgentId, { at: number; listed: Listed }>();
const listInflight = new Map<AgentId, Promise<Listed>>();

async function onPath(bin: string): Promise<boolean> {
  try {
    await promisify(execFile)(process.platform === "win32" ? "where" : "which", [bin], { env: { ...process.env, PATH: widenedPath() }, timeout: 3000 });
    return true;
  } catch { return false; }
}

async function listProbe(id: AgentId): Promise<Listed> {
  if (!(await Promise.all(AGENT_REGISTRY[id].bins.map(onPath))).some(Boolean)) return { supported: false, sessions: [] };
  const agent = new AcpAgent(id, async () => PERMISSION_CANCELLED, { cwd: flowAgentCwd(), connectOnly: true });
  const ac = new AbortController();
  const bell = setTimeout(() => ac.abort(), PROBE_MS);
  try {
    await agent.start(ac.signal);
    // The same budget covers the list: an agent that never answers session/list
    // would otherwise hold this probe, and its process, open for good.
    const late = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error("the agent did not list its sessions in time"));
      if (ac.signal.aborted) fail(); else ac.signal.addEventListener("abort", fail, { once: true });
    });
    late.catch(() => {});
    const sessions = await Promise.race([agent.listSessions(LIST_MAX), late]);
    return { supported: sessions !== null, sessions: sessions ?? [] };
  } finally {
    clearTimeout(bell);
    try { await agent.dispose(); } catch { /* it is going away either way */ }
  }
}

agentRoutes.get("/sessions", async (c) => {
  const id = c.req.query("agent")?.trim() ?? "";
  if (!isAgentId(id)) return c.json({ error: "unknown agent" }, 400);
  const hit = listCache.get(id);
  if (hit && Date.now() - hit.at < LIST_CACHE_MS) return c.json(hit.listed);
  let run = listInflight.get(id);
  if (!run) {
    run = listProbe(id)
      .then((listed) => { listCache.set(id, { at: Date.now(), listed }); return listed; })
      .finally(() => listInflight.delete(id));
    listInflight.set(id, run);
  }
  try {
    return c.json(await run);
  } catch (e) {
    log.warn("agents", `sessions(${id}):`, e);
    return c.json({ error: e instanceof Error ? e.message : "the agent did not start" }, 502);
  }
});
