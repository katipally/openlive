"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { FlowConfig } from "@openlive/flow-store";
import { cn } from "@/lib/cn";
import { CONTROL, isDesktop, isMacDesktop } from "@/lib/platform";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import type { FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import { BrainPicker } from "./BrainPicker";
import { AccessRows } from "./FlowSettings";
import { FlowCanvas } from "./FlowCanvas";

// The first run, and only Flow's: what it needs from the machine, then who does
// the thinking. Everything finer lives in Settings. "Skip" finishes from either
// step; Flow asks for anything missing the first time it needs it.

export function FlowOnboarding({ onDone, config, save }: {
  onDone: () => void;
  config: FlowConfig | null;
  save: (patch: FlowConfigPatch) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={cn("flex h-14 shrink-0 items-center gap-3 pr-3",
        isMacDesktop ? "pl-[84px]" : "pl-4", isDesktop && "app-drag")}>
        <span className="min-w-0 flex-1 truncate text-body font-semibold">{`Set up Flow · ${step} of 2`}</span>
        <button type="button" onClick={onDone}
          className="shrink-0 rounded-full px-3 py-1.5 text-label font-medium text-muted-strong transition hover:bg-foreground/[0.06] hover:text-foreground [-webkit-app-region:no-drag]">
          Skip
        </button>
      </header>

      <FlowCanvas>
        {step === 1 ? (
          <>
            <div className="flex flex-col gap-3">
              <OpenLiveOrb size={48} />
              <h1 className="text-title-lg font-semibold tracking-tight">Talk to any app</h1>
              <p className="text-body leading-relaxed text-muted-strong">
                {`Tap ${CONTROL} ${CONTROL} anywhere. Flow types, acts, and answers out loud. It needs these first:`}
              </p>
            </div>
            <AccessRows config={config} save={save} />
            <details className="group">
              <summary className="cursor-pointer list-none text-label font-medium text-link-foreground hover:underline [&::-webkit-details-marker]:hidden">
                What Flow never does
              </summary>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-label text-muted-strong">
                <li>{`Never listens to the keyboard beyond ${CONTROL}.`}</li>
                <li>Mic opens only on the gesture. No wake word.</li>
                <li>No audio is kept.</li>
                <li>Nothing leaves this machine except what the brain needs.</li>
              </ul>
            </details>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <h1 className="text-title-lg font-semibold tracking-tight">Who does the thinking?</h1>
              <p className="text-body text-muted-strong">Change it any time in Settings.</p>
            </div>
            <BrainPicker config={config} save={save} />
          </>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {step === 2 && (
            <button type="button" onClick={() => setStep(1)}
              className="flex shrink-0 items-center gap-2 rounded-full px-4 py-2.5 text-callout font-medium text-muted-strong transition hover:bg-foreground/[0.06] hover:text-foreground">
              <ArrowLeft className="size-4" aria-hidden /> Back
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={() => (step === 1 ? setStep(2) : onDone())}
            className="flex shrink-0 items-center gap-2 rounded-full bg-foreground px-6 py-2.5 text-callout font-medium text-background shadow-[var(--shadow-card)] transition hover:opacity-90">
            {step === 1 ? "Continue" : "Start using Flow"}
            <ArrowRight className="size-4" aria-hidden />
          </button>
        </div>
      </FlowCanvas>
    </div>
  );
}
