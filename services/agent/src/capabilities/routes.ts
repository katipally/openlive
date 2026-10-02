import { Hono, type Context } from "hono";
import { z } from "zod";
import { getSetting, setSetting } from "@openlive/db";
import type { CapabilitiesWire } from "@openlive/shared";
import { builtinCatalog, unavailableTools } from "./registry.js";
import { disabledGroups, GROUPS, groupTools, setGroupEnabled, type ToolGroupId } from "./groups.js";
import { AUTO_THRESHOLD, onDemandActive, onDemandMode, setOnDemandMode } from "./on-demand.js";
import { listedConnectorTools } from "../connectors/tools.js";

// The /capabilities REST surface, behind the agent's shared-secret gate: the
// built-in tool groups Settings lists and switches, how connector tools load,
// and the write-only Exa key.

export const capabilityRoutes = new Hono();

function onDemand(): CapabilitiesWire["onDemand"] {
  const mode = onDemandMode();
  const tools = listedConnectorTools();
  return { available: true, mode, active: onDemandActive(mode, tools), toolCount: tools.length, threshold: AUTO_THRESHOLD };
}

const wire = (): CapabilitiesWire => ({
  groups: groupTools(builtinCatalog(), disabledGroups(), unavailableTools()),
  onDemand: onDemand(),
  exaKey: getSetting("exa_api_key") ? "saved" : process.env.EXA_API_KEY?.trim() ? "env" : null,
});

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
  try { const r = schema.safeParse(await c.req.json()); return r.success ? r.data : null; }
  catch { return null; }
}

capabilityRoutes.get("/", (c) => c.json(wire()));

capabilityRoutes.post("/groups/:id/enabled", async (c) => {
  const id = c.req.param("id");
  if (!Object.hasOwn(GROUPS, id)) return c.json({ error: "not found" }, 404);
  const b = await body(c, z.object({ enabled: z.boolean() }));
  if (!b) return c.json({ error: "Send enabled: true or false." }, 400);
  await setGroupEnabled(id as ToolGroupId, b.enabled);
  return c.json(wire());
});

capabilityRoutes.post("/on-demand", async (c) => {
  const b = await body(c, z.object({ mode: z.enum(["auto", "on", "off"]) }));
  if (!b) return c.json({ error: "Send mode: auto, on or off." }, 400);
  await setOnDemandMode(b.mode);
  return c.json(wire());
});

// Empty clears it. Never read back: the reply only says whether one is saved.
capabilityRoutes.post("/exa-key", async (c) => {
  const b = await body(c, z.object({ key: z.string().max(200) }));
  if (!b) return c.json({ error: "Send key as a string." }, 400);
  await setSetting("exa_api_key", b.key.trim());
  return c.json(wire());
});
