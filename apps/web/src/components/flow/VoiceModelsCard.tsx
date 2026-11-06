"use client";

import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { modelsFailed, modelsOffer } from "@/lib/flow/failure";
import type { FlowVoiceSetup } from "@/lib/flow/useVoiceSetup";
import { planModels } from "@/lib/live/weights";

// The voice models as a step of Flow's setup: what, how big and where, with
// Download as the yes. It says nothing until the cache and the voice the agent
// runs have been read, and nothing once they are in.

export function VoiceModelsCard({ setup }: { setup: FlowVoiceSetup }) {
  const { step, plan, pct, blocked, start } = setup;
  if (step === "reading" || step === "ready") return null;
  const offer = modelsOffer(plan && plan.missing.length ? planModels(plan) : ["voice"], plan?.bytes ?? null);
  const text = step === "downloading" ? { title: "Downloading the voice models", detail: "It keeps going if you leave this screen. Flow listens as soon as they're in." }
    : step === "offline" || step === "failed" ? modelsFailed(step === "failed") : offer;
  return (
    <div role="group" aria-label="Voice models" className="flex flex-col gap-2 rounded-lg bg-card px-4 py-3 text-left shadow-card">
      <span className="break-words text-body font-medium">{text.title}</span>
      <span className="break-words text-label text-muted-strong">{text.detail}</span>
      {step === "downloading" && (
        <div role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} className="h-1.5 w-full overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${Math.round(pct * 100)}%` }} />
        </div>
      )}
      {step !== "offline" && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" onClick={start} disabled={step === "downloading" || blocked}>
            {step === "downloading" ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Download aria-hidden />}
            {step === "downloading" ? `Downloading ${Math.round(pct * 100)}%` : step === "failed" ? "Try again" : "Download"}
          </Button>
          {blocked && <span className="text-caption text-muted-foreground">After your call ends.</span>}
        </div>
      )}
    </div>
  );
}
