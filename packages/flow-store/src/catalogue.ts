import type { RiskTier } from "./config";

// The tools a settings screen may offer a per-tool override for, and the tier
// each one answers to. It lives beside the config rather than beside the tool
// implementations because the renderer that draws the switches cannot import
// the agent service, and an override is config.
//
// A tool missing from here is not hidden: the settings screen also renders any
// name already present in `config.toolRisk`, so an override set by hand or by a
// newer build always stays visible and removable.

export interface FlowToolInfo {
  name: string;
  tier: RiskTier;
  /** What it does, in the words the person would use. */
  summary: string;
}

export const FLOW_TOOL_CATALOGUE: FlowToolInfo[] = [
  { name: "insert_text", tier: "insert", summary: "Types where your cursor is" },
  { name: "clipboard_write", tier: "insert", summary: "Puts text on your clipboard" },
  { name: "read_selection", tier: "read", summary: "Reads what you have selected" },
  { name: "clipboard_read", tier: "read", summary: "Reads your clipboard" },
  { name: "get_context", tier: "read", summary: "Reads the app and window you are in" },
];

/** Destructive tools always ask, whatever the stored override says. */
export const isLockedTier = (tier: RiskTier): boolean => tier === "destructive";
