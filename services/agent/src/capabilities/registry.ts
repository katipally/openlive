import { ToolSet } from "./dispatch.js";
import { TEXT_TOOLS } from "./text.js";
import { bridgedOpenUrl, deviceTools } from "./device-tools.js";
import { computerTools, SUPERSEDED } from "../computer/tools.js";
import { ASSISTANT_TOOLS } from "./assistant.js";
import { FILE_TOOLS } from "./files.js";
import { WORKER_TOOLS } from "./web.js";
import { saveSkill } from "../skills/tools.js";
import { CONNECTOR_SETUP_TOOLS } from "../connectors/setup.js";
import { REMINDER_TOOLS } from "../reminders/tools.js";
import { disabledGroups } from "./groups.js";
import type { OnDemandMode } from "@openlive/shared";
import { onDemandActive, onDemandMode, onDemandTools } from "./on-demand.js";
import type { DevicePort } from "./device.js";
import type { ComputerPort } from "../computer/helper.js";
import type { Session, Tool } from "./types.js";

// Every tool OpenLive has, in one place. A mode does not own tools: a profile
// orders what a session can reach, and both loops and the MCP server serve the
// same answer, so neither mode nor brain can drift from the other.

/**
 * A source of tools for one session. Called once when the session asks, so a
 * provider may hand back tools that keep state for that session alone, as the
 * device tools keep the last screenshot's geometry.
 */
export type ToolProvider = (s: Session) => Tool[];

/** How a mode orders its tools: the names it leads with, then everything else as registered. */
export interface Ordering {
  readonly order: readonly string[];
}

/** The machine's tools: the helper's where it runs, with what only ol-input does beside them. */
function machine(s: Session): Tool[] {
  if (!s.device) return [bridgedOpenUrl];
  if (!s.computer) return deviceTools({ device: s.device });
  return [...computerTools({ computer: s.computer, device: s.device }), ...deviceTools({ device: s.device, omit: SUPERSEDED })];
}

/** OpenLive's own tools. The machine's are built per session: they remember the last picture they showed. */
const builtins: ToolProvider = (s) => [
  ...TEXT_TOOLS,
  ...machine(s),
  ...ASSISTANT_TOOLS,
  ...REMINDER_TOOLS,
  ...FILE_TOOLS,
  saveSkill,
  ...CONNECTOR_SETUP_TOOLS,
];

/**
 * Every built-in tool any session could get, for Settings to list: a session
 * with the machine and the helper, whose ports are never called because
 * nothing here runs. The research worker's tools are reached through
 * `delegate`, so they are listed beside it.
 */
export const builtinCatalog = (): Tool[] =>
  [...builtins({ device: {} as DevicePort, computer: {} as ComputerPort }), ...WORKER_TOOLS];

export class ToolRegistry {
  private readonly providers: ToolProvider[] = [];

  /** Add a source of tools. Returns how to take it away again, for one that can come and go. */
  register(provider: ToolProvider): () => void {
    this.providers.push(provider);
    return () => { const i = this.providers.indexOf(provider); if (i >= 0) this.providers.splice(i, 1); };
  }

  /**
   * The tools this session can run, in the order its mode leads with. A name
   * offered twice keeps its first registration, so a later provider can never
   * shadow a built-in. A group switched off in Settings is left out, for
   * every brain and the MCP server alike. Connector tools past the on-demand
   * threshold are held back behind find_tools and use_tool, decided here once
   * for the session's whole life. O(n log n) in the number of tools.
   */
  tools(profile: Ordering, s: Session, mode: OnDemandMode = onDemandMode()): ToolSet {
    const rank = new Map(profile.order.map((name, i) => [name, i]));
    const seen = new Set<string>();
    const off = disabledGroups();
    const offered = this.providers.flatMap((p) => p(s)).filter((t) => {
      if (seen.has(t.name) || (t.group && off.has(t.group)) || !(t.available?.(s) ?? true)) return false;
      seen.add(t.name);
      return true;
    });
    const at = (t: Tool, i: number) => rank.get(t.name) ?? profile.order.length + i;
    const ranked = offered.map((t, i) => ({ t, r: at(t, i) })).sort((a, b) => a.r - b.r);
    const all = ranked.map((x) => x.t);
    const held = all.filter((t) => t.connector);
    if (!onDemandActive(mode, held)) return new ToolSet(all);
    return new ToolSet([...all.filter((t) => !t.connector), ...onDemandTools(held)], held);
  }
}

/** The registry every session queries. */
export const registry = new ToolRegistry();
registry.register(builtins);
