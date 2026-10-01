import { ToolSet } from "./dispatch.js";
import { TEXT_TOOLS } from "./text.js";
import { bridgedOpenUrl, deviceTools } from "./device-tools.js";
import { ASSISTANT_TOOLS } from "./assistant.js";
import { FILE_TOOLS } from "./files.js";
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

/** OpenLive's own tools. The device family is built per session: it remembers the last picture it showed. */
const builtins: ToolProvider = (s) => [
  ...TEXT_TOOLS,
  ...(s.device ? deviceTools({ device: s.device }) : [bridgedOpenUrl]),
  ...ASSISTANT_TOOLS,
  ...FILE_TOOLS,
];

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
   * shadow a built-in. O(n log n) in the number of tools.
   */
  tools(profile: Ordering, s: Session): ToolSet {
    const rank = new Map(profile.order.map((name, i) => [name, i]));
    const seen = new Set<string>();
    const offered = this.providers.flatMap((p) => p(s)).filter((t) => {
      if (seen.has(t.name) || !(t.available?.(s) ?? true)) return false;
      seen.add(t.name);
      return true;
    });
    const at = (t: Tool, i: number) => rank.get(t.name) ?? profile.order.length + i;
    const ranked = offered.map((t, i) => ({ t, r: at(t, i) })).sort((a, b) => a.r - b.r);
    return new ToolSet(ranked.map((x) => x.t));
  }
}

/** The registry every session queries. */
export const registry = new ToolRegistry();
registry.register(builtins);
