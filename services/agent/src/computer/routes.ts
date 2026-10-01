import { Hono } from "hono";
import { z } from "zod";
import { computer, type ComputerHelper, type Grant } from "./helper.js";

// The helper's own grants, for the Access settings. Reading them never prompts;
// asking for one is the only call that may, and only because the user pressed Allow.

export interface ComputerStatus {
  /** False where there is no helper to grant anything to: ol-input's tools serve instead. */
  available: boolean;
  grants: Grant[];
  /** Why the grants could not be read, when they could not. */
  error?: string;
}

const request = z.object({ id: z.enum(["accessibility", "screenRecording"]) });

export function computerRoutes(helper: Pick<ComputerHelper, "available" | "call"> = computer): Hono {
  const routes = new Hono();

  const status = async (): Promise<ComputerStatus> => {
    if (!helper.available()) return { available: false, grants: [] };
    try {
      return { available: true, ...(await helper.call<{ grants: Grant[] }>("permissions")) };
    } catch (e) {
      return { available: true, grants: [], error: e instanceof Error ? e.message : String(e) };
    }
  };

  routes.get("/permissions", async (c) => c.json(await status()));

  routes.post("/permissions/request", async (c) => {
    const body = request.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "id must be accessibility or screenRecording" }, 400);
    if (!helper.available()) return c.json({ error: "There is no computer-use helper on this machine." }, 409);
    try {
      return c.json({ available: true, ...(await helper.call<{ grants: Grant[] }>("requestPermission", { id: body.data.id })) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  return routes;
}
