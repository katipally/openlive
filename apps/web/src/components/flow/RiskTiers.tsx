"use client";

import { Lock } from "lucide-react";
import { FLOW_TOOL_CATALOGUE, isLockedTier } from "@openlive/flow-store/catalogue";
import type { FlowConfig, RiskAction, RiskTier } from "@openlive/flow-store";
import type { FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import { cn } from "@/lib/cn";

// What Flow may do without asking. Three tiers the person sets, and a per-tool
// override for anything they feel differently about.
//
// Destructive is not a dropdown that happens to be disabled. It renders as a
// lock with the reason next to it, because a greyed-out control with no
// explanation reads as a bug rather than as a decision.

const TIERS: { id: RiskTier; label: string; dot: string; detail: string }[] = [
  { id: "read", label: "Reading", dot: "bg-success", detail: "Reads the screen, your selection and your clipboard, and answers." },
  { id: "insert", label: "Typing", dot: "bg-success", detail: "Puts words where your cursor is, and on your clipboard." },
  { id: "control", label: "Hands on", dot: "bg-arc", detail: "Clicking and driving another app." },
  { id: "destructive", label: "Destructive", dot: "bg-destructive-fill", detail: "Deletes, resets, sends. Always asks, no exceptions." },
];

const ACTIONS: { id: RiskAction; label: string }[] = [
  { id: "auto", label: "Run straight away" },
  { id: "ask", label: "Ask first" },
  { id: "deny", label: "Never" },
];

export function RiskTiers({ config, save }: { config: FlowConfig; save: (patch: FlowConfigPatch) => void }) {
  // A name in the file this build does not ship is still shown, so an override
  // set by hand or by a newer build is never hidden and never stuck.
  const extra = Object.keys(config.toolRisk)
    .filter((name) => !FLOW_TOOL_CATALOGUE.some((t) => t.name === name))
    .map((name) => ({ name, tier: "control" as RiskTier, summary: "Set outside this screen" }));
  const tools = [...FLOW_TOOL_CATALOGUE, ...extra];

  return (
    <div className="flex flex-col gap-5 rounded-lg bg-card p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-col gap-3">
        {TIERS.map((t) => {
          const locked = isLockedTier(t.id);
          return (
            <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className={cn("size-[7px] shrink-0 rounded-full", t.dot)} aria-hidden />
              <span className="w-[6.5rem] shrink-0 text-body font-medium">{t.label}</span>
              <span className="min-w-[12rem] flex-1 text-label leading-relaxed text-muted-strong">{t.detail}</span>
              {locked ? (
                <Locked reason="Always asks" />
              ) : (
                <label className="shrink-0">
                  <span className="sr-only">What Flow may do for {t.label}</span>
                  <select className="ol-select h-9 w-[11rem] rounded-md bg-surface-raised px-2.5 text-label text-foreground outline-none"
                    value={config.risk[t.id]}
                    onChange={(e) => save({ risk: { [t.id]: e.target.value as RiskAction } })}>
                    {ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </label>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2.5 pt-1 shadow-[inset_0_1px_0_var(--border)]">
        <span className="pt-4 text-micro font-medium uppercase tracking-[0.06em] text-muted-foreground">Per tool</span>
        {tools.map((t) => {
          const locked = isLockedTier(t.tier);
          const value = config.toolRisk[t.name] ?? "";
          return (
            <div key={t.name} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <label htmlFor={`ov-${t.name}`} className="min-w-0 flex-1 font-mono text-label">{t.name}</label>
              <span className="min-w-0 flex-[2] text-caption text-muted-strong">{t.summary}</span>
              {locked ? (
                <Locked reason="Always asks" />
              ) : (
                <select id={`ov-${t.name}`}
                  className="ol-select h-9 w-[11rem] shrink-0 rounded-md bg-surface-raised px-2.5 text-label text-foreground outline-none"
                  value={value}
                  onChange={(e) => save({ toolRisk: { ...config.toolRisk, [t.name]: e.target.value as RiskAction } })}>
                  <option value="">Same as {TIERS.find((x) => x.id === t.tier)?.label.toLowerCase()}</option>
                  {ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Locked({ reason }: { reason: string }) {
  return (
    <span className="flex w-[11rem] shrink-0 items-center gap-2 rounded-md bg-surface-raised px-2.5 py-2 text-label text-muted-strong">
      <Lock className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate" title={reason}>{reason}</span>
    </span>
  );
}
