"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { FlowConfig } from "@openlive/flow-store";
import { cn } from "@/lib/cn";
import { CONTROL, isDesktop, isMacDesktop, isNonMacDesktop } from "@/lib/platform";
import { Button, linkClass } from "@/components/ui";
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
      <header className={cn("flex h-14 shrink-0 items-center gap-3",
        isMacDesktop ? "pl-traffic-lights" : "pl-4", isNonMacDesktop ? "pr-window-controls" : "pr-3", isDesktop && "app-drag")}>
        <span className="min-w-0 flex-1 truncate text-body font-semibold">{`Set up Flow · ${step} of 2`}</span>
        <Button variant="ghost" size="sm" onClick={onDone} className="[-webkit-app-region:no-drag]">Skip</Button>
      </header>

      <FlowCanvas>
        {step === 1 ? (
          <>
            <div className="flex flex-col gap-3">
              <OpenLiveOrb size={48} pulse />
              <h1 className="text-title-lg font-semibold tracking-tight">Talk to any app</h1>
              <p className="text-body leading-relaxed text-muted-strong">
                {`Tap ${CONTROL} ${CONTROL} anywhere. Flow types, acts, and answers out loud. It needs these first:`}
              </p>
            </div>
            <AccessRows config={config} save={save} />
            <details className="group">
              <summary className={cn("cursor-pointer list-none text-label [&::-webkit-details-marker]:hidden", linkClass)}>
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
            <Button variant="ghost" size="lg" onClick={() => setStep(1)}>
              <ArrowLeft aria-hidden /> Back
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="primary" size="lg" onClick={() => (step === 1 ? setStep(2) : onDone())}>
            {step === 1 ? "Continue" : "Start using Flow"}
            <ArrowRight aria-hidden />
          </Button>
        </div>
      </FlowCanvas>
    </div>
  );
}
