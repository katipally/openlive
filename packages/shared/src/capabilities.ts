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

export interface CapabilitiesWire {
  groups: ToolGroupWire[];
  /** Connector tools loaded only when a task calls for them. */
  onDemand: { available: boolean };
  /** Where the Exa key for web search comes from, if anywhere. The key itself never leaves the agent. */
  exaKey: "saved" | "env" | null;
}
