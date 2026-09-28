import type { AgentMetaWire, AgentOptionWire } from "@openlive/shared";

// The words behind the pre-call "How it runs" row: one line that says what the
// call will run on, and which agent options are really an on/off switch. Every
// agent reports its own options over ACP, so nothing here knows an agent by name.

type Value = { id: string; name: string };

const NICE_CATEGORY: Record<string, string> = { thought_level: "Reasoning", model_config: "Model config" };
export const optLabel = (category: string, label: string) => label || NICE_CATEGORY[category] || category || "Option";

const ON = new Set(["on", "true", "enabled", "enable", "yes"]);
const OFF = new Set(["off", "false", "disabled", "disable", "no"]);
const word = (v: Value) => [v.id.trim().toLowerCase(), v.name.trim().toLowerCase()];

/** The on and off ids when an option's two values are a plain on/off pair (a
 *  "Fast mode" reported as a select), else null. */
export function switchValues(values: readonly Value[]): { on: string; off: string } | null {
  if (values.length !== 2) return null;
  const on = values.find((v) => word(v).some((w) => ON.has(w)));
  const off = values.find((v) => word(v).some((w) => OFF.has(w)));
  return on && off && on !== off ? { on: on.id, off: off.id } : null;
}

const isDefault = (v: Value) => word(v).includes("default");
const nameOf = (values: readonly Value[], id: string | null) => values.find((v) => v.id === id);

/** One option's part of the line: a switch says its name only while on, a
 *  choice says "Label Value", and a choice left on its default says nothing. */
function optionPart(o: AgentOptionWire): string {
  const sw = switchValues(o.values);
  const label = optLabel(o.category, o.label);
  if (sw) return o.currentId === sw.on ? label : "";
  const v = nameOf(o.values, o.currentId);
  return v && !isDefault(v) ? `${label} ${v.name}` : "";
}

/** "Haiku · Default · Effort Low · Fast mode": model, mode, then every option in the agent's order. */
export function agentSummary(meta: Pick<AgentMetaWire, "models" | "currentModelId" | "modes" | "currentModeId" | "options">): string {
  return [
    nameOf(meta.models, meta.currentModelId)?.name,
    nameOf(meta.modes, meta.currentModeId)?.name,
    ...meta.options.filter((o) => o.values.length > 0).map(optionPart),
  ].filter(Boolean).join(" · ");
}

/** "Anthropic · Haiku · Effort Low" for API mode. Parts not known yet are left out. */
export function apiSummary(provider: string | undefined, model: string | undefined, effort: string | undefined): string {
  return [provider, model, effort && `Effort ${effort}`].filter(Boolean).join(" · ");
}
