"use client";

import { Check, ShieldCheck } from "lucide-react";
import type { FlowConfig } from "@openlive/flow-store";
import { cn } from "@/lib/cn";
import { dateLabel } from "@/lib/flow/format";
import type { FlowConfigPatch } from "@/lib/flow/useFlowConfig";

// The one permission Flow ever takes, and the way back out of it. It is asked
// on the first run and shown for the rest of the app's life in Flow's settings,
// so it is one component: two screens describing the same switch in two
// different sentences is how a promise about permissions stops being believed.
//
// It is separate from the system grants beside it because it is not the
// system's to give. macOS can say Flow is allowed to type; only the person can
// say Flow is allowed to type on their behalf without being asked again.

export function ConsentCard({ config, save, tone = "settings" }: {
  config: FlowConfig | null;
  save: (patch: FlowConfigPatch) => void;
  /** The first run leads with this card and explains it; settings reminds. */
  tone?: "onboarding" | "settings";
}) {
  const granted = !!config?.consent.granted;
  const at = config?.consent.at ?? "";
  const set = (on: boolean) => save({ consent: on ? { granted: true, at: new Date().toISOString() } : { granted: false, at: "" } });

  return (
    <div className={cn("flex flex-col gap-3.5 rounded-lg bg-card p-5 shadow-[var(--shadow-card)] transition-shadow duration-300",
      tone === "onboarding" && !granted && "shadow-[var(--shadow-pop),inset_0_0_0_2px_var(--accent-soft)]")}>
      <div className="flex flex-wrap items-center gap-3.5">
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-full transition-colors duration-300",
          granted ? "bg-success/15" : "bg-surface-raised")}>
          {granted
            ? <Check className="size-4 text-success-text" strokeWidth={2.6} aria-hidden />
            : <ShieldCheck className="size-4 text-muted-strong" aria-hidden />}
        </span>
        <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
          <span className="text-title-sm font-medium">
            {granted ? "Flow may act on this machine" : "Flow will ask before it acts"}
          </span>
          <span className="text-label leading-relaxed text-muted-strong">
            {granted
              ? `Given ${dateLabel(at)}. It types where your cursor is, clicks, drives apps and runs what you ask for, without asking again.`
              : "Say yes once and Flow stops asking. Until then, the next thing it is asked to do it will ask about out loud, and a yes there gives it this for good."}
          </span>
        </div>
        <button type="button" onClick={() => set(!granted)}
          className={cn("shrink-0 rounded-full px-4 py-2.5 text-callout font-medium transition active:scale-[0.98]",
            granted ? "bg-surface-raised hover:bg-foreground/10" : "bg-accent text-accent-foreground shadow-[var(--shadow-xs)] hover:opacity-90")}>
          {granted ? "Take it back" : "Yes, Flow may act"}
        </button>
      </div>
      <p className={cn("text-label leading-relaxed text-muted-strong",
        tone === "onboarding" && "rounded-md bg-surface-raised px-3.5 py-3")}>
        Flow only ever does what you just asked it for, and everything it did is in the transcript, with what it saw.
        Taking this back never breaks a conversation in progress.
      </p>
    </div>
  );
}
