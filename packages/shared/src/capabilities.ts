// What the agent's /capabilities routes send: OpenLive's own tools, in the
// groups Settings turns on and off, and the built-in web search's key.

/** One built-in tool, as Settings lists it. */
export interface BuiltinToolWire {
  name: string;
  /** Its first sentence. */
  description: string;
  /** It asks before it changes something. */
  asksFirst: boolean;
}

export interface ToolGroupWire {
  id: string;
  name: string;
  /** A lucide icon name, for the web to map. */
  icon: string;
  description: string;
  /** What a session needs before these tools show up, as "Needs a folder". */
  needs?: string;
  enabled: boolean;
  tools: BuiltinToolWire[];
}

export type OnDemandMode = "auto" | "on" | "off";

/** How connector tools reach a session: each its own tool, or found on demand
 *  behind two. Decided when a session starts, for the whole session. */
export interface OnDemandWire {
  available: boolean;
  mode: OnDemandMode;
  /** Whether the next session would hold them back, as the mode and the count stand now. */
  active: boolean;
  /** Connector tools that are on. */
  toolCount: number;
  /** Past either, `auto` holds them back. */
  threshold: { tools: number; tokens: number };
}

export interface CapabilitiesWire {
  groups: ToolGroupWire[];
  /** Connector tools loaded only when a task calls for them. */
  onDemand: OnDemandWire;
  /** Where the Exa key for web search comes from, if anywhere. The key itself never leaves the agent. */
  exaKey: "saved" | "env" | null;
}
