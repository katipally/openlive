import { Hono } from "hono";
import { isAgentId } from "@openlive/shared";
import { AcpAgent } from "./acp-agent.js";
import { flowAgentCwd, PERMISSION_CANCELLED, type AgentId } from "./index.js";
import type { AgentMeta } from "./types.js";
import { log } from "../log.js";

// Which models a coding agent offers is something only that agent can say, and
// it only says it once an ACP session exists. So this starts one in Flow's own
// folder, keeps what `session/new` reported, and shuts it down again.
//
// Starting an agent is seconds, not milliseconds, so the answer is cached and a
// caller arriving mid-probe waits on the probe already running rather than
// starting a second copy of the same CLI.

export const agentRoutes = new Hono();

const CACHE_MS = 5 * 60_000;
const PROBE_MS = 30_000;

interface Models { models: { id: string; name: string }[]; currentModelId: string | null }

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
    return { models: meta?.models ?? [], currentModelId: meta?.currentModelId ?? null };
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
