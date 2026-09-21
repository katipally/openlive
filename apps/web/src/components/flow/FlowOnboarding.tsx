"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ExternalLink, Info, Monitor } from "lucide-react";
import type { FlowConfig } from "@openlive/flow-store";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { cn } from "@/lib/cn";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { flowBridge } from "@/lib/flow/bridge";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import type { FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import { BrainPicker } from "./BrainPicker";

// The first run: the microphone, then Accessibility, then who does the thinking.
//
// The order is the order of consequence. The microphone is what makes Flow work
// at all; Accessibility is what makes it type; screen recording is asked for
// lazily, the first time a perception tool actually runs, because asking for it
// here would be asking for something the person has not yet wanted.
//
// macOS never calls back when a grant is given. The capability poll runs at 1Hz
// while this screen is up and recovers live, so nobody is ever told to relaunch.

type Step = "permissions" | "brain";

export function FlowOnboarding({ onDone, config, brainReady, save }: {
  onDone: () => void;
  config: FlowConfig | null;
  brainReady: boolean;
  save: (patch: FlowConfigPatch) => void;
}) {
  const [step, setStep] = useState<Step>("permissions");
  const { caps, error, available, refresh } = useFlowCapabilities(step === "permissions");
  const root = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (prefersReduced()) return;
    gsap.fromTo(".ol-onb", { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: DUR.base, ease: EASE.out, stagger: 0.05 });
  }, { scope: root, dependencies: [step] });

  const perms = caps?.permissions ?? null;
  const mac = caps?.platform === "darwin";

  return (
    <div ref={root} className="flex min-h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 px-6">
        <span className="flex-1" />
        <span className="font-mono text-caption tabular-nums text-muted-foreground">Step {step === "permissions" ? 1 : 2} of 2</span>
        <div className="flex shrink-0 items-center gap-1.5" aria-hidden>
          <span className="h-1 w-6 rounded-full bg-foreground" />
          <span className={cn("h-1 w-6 rounded-full", step === "brain" ? "bg-foreground" : "bg-foreground/20")} />
        </div>
      </header>

      {step === "permissions" ? (
        <div className="flex min-h-0 flex-1 flex-wrap content-start gap-10 px-8 pb-6">
          <div className="ol-onb flex min-w-[20rem] flex-[1_1_26rem] flex-col gap-5">
            <OpenLiveOrb size={76} />
            <h1 className="max-w-[28rem] text-display font-semibold tracking-tight">
              Flow types for you. {mac ? "macOS calls that Accessibility." : "Your system calls that input access."}
            </h1>
            <p className="max-w-[28rem] text-title-sm leading-relaxed text-muted-strong">
              When you finish talking, the words go into whatever app your cursor is already in. The system will not let
              any app do that until you say so, once.
            </p>
            <ul className="flex flex-col gap-3 pt-1">
              {[
                "It puts text where your cursor is, and clicks things when you ask it to.",
                "It does not watch your typing. Flow never listens to the keyboard.",
                "Turn it off whenever you like. Flow still answers you out loud.",
              ].map((line) => (
                <li key={line} className="flex items-start gap-3">
                  <Check className="mt-0.5 size-4 shrink-0 text-success-text" strokeWidth={2.4} aria-hidden />
                  <span className="text-callout leading-relaxed">{line}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="ol-onb flex min-w-[20rem] flex-[1_1_26rem] flex-col gap-3.5">
            {!available && (
              <Card>
                <p className="text-body leading-relaxed text-muted-strong">
                  Flow needs the OpenLive desktop app: a browser tab cannot hold a key down for the whole machine.
                </p>
              </Card>
            )}

            <PermissionCard
              title="Microphone"
              granted={perms?.microphone === "granted"}
              detail={perms?.microphone === "granted"
                ? "Granted. Only open while you hold the key."
                : perms?.microphone === "denied"
                  ? "Refused. Allow OpenLive the microphone in your system settings, and this picks it up on its own."
                  : "Flow has no wake word and never listens between triggers."}
              action={perms?.microphone === "granted" ? null : {
                label: "Allow the microphone",
                run: () => void flowBridge()?.request("microphone").then(refresh),
              }}
            />

            <PermissionCard
              title={mac ? "Accessibility" : "Input access"}
              granted={!!perms?.accessibility}
              active={!perms?.accessibility}
              detail={perms?.accessibility
                ? "Granted. Flow can type where your cursor is."
                : "Waiting for you in System Settings. Checking every second."}
              note={perms?.accessibility ? "" : mac
                ? "Privacy & Security, then Accessibility, then switch OpenLive on. This window picks it up on its own, no restart."
                : "Allow OpenLive to send input. This window picks it up on its own, no restart."}
              action={perms?.accessibility ? null : {
                label: "Open System Settings",
                icon: true,
                run: () => void flowBridge()?.init().then(refresh),
              }}
              secondary={perms?.accessibility ? null : { label: "Check now", run: refresh }}
            />

            <Card>
              <div className="flex flex-wrap items-center gap-3.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-raised">
                  <Monitor className="size-4 text-muted-strong" aria-hidden />
                </span>
                <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
                  <span className="text-title-sm font-medium">
                    Screen Recording <span className="text-label font-normal text-muted-foreground">optional</span>
                  </span>
                  <span className="text-label leading-relaxed text-muted-strong">
                    Asked for later, the first time you ask Flow about something on your screen. Never before that.
                  </span>
                </div>
              </div>
            </Card>

            {error && <p className="text-label leading-relaxed text-destructive-text">{error}</p>}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-6 px-8 pb-6">
          <div className="ol-onb flex flex-col gap-2">
            <h1 className="text-display font-semibold tracking-tight">Who is doing the thinking?</h1>
            <p className="max-w-[44rem] text-title-sm leading-relaxed text-muted-strong">
              Flow is the voice and the hands. The brain behind it is yours to pick, and you can swap it any time
              without losing your settings.
            </p>
          </div>
          <div className="ol-onb openlive-scroll min-h-0 flex-1 overflow-y-auto pr-1">
            <BrainPicker config={config} save={save} />
          </div>
          <p className="ol-onb flex max-w-[48rem] items-start gap-3 text-label leading-relaxed text-muted-strong">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            Whichever you pick, the rules stay the same: safe things happen straight away, anything that touches another
            app asks you first, and anything destructive always asks.
          </p>
        </div>
      )}

      <footer className="flex h-[5.5rem] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-8">
        <button type="button" onClick={() => (step === "brain" ? setStep("permissions") : onDone())}
          className="shrink-0 rounded-full px-4 py-2.5 text-callout font-medium text-muted-strong transition hover:bg-foreground/[0.06]">
          {step === "brain" ? "Back" : "Skip for now"}
        </button>
        <span className="flex-1" />
        <span className="min-w-0 text-label text-muted-strong">
          {step === "permissions"
            ? "You can finish without it. Flow will talk, but not type."
            : brainReady ? "" : "Nothing is configured yet, so Flow has nothing to think with. You can fix that any time in settings."}
        </span>
        {step === "permissions" ? (
          <button type="button" onClick={() => setStep("brain")}
            className="flex shrink-0 items-center gap-2 rounded-full bg-foreground px-6 py-2.5 text-callout font-medium text-background transition hover:opacity-90">
            Continue <ArrowRight className="size-4" aria-hidden />
          </button>
        ) : (
          <button type="button" onClick={onDone}
            className="flex shrink-0 items-center gap-2 rounded-full bg-foreground px-6 py-2.5 text-callout font-medium text-background transition hover:opacity-90">
            Start using Flow <ArrowRight className="size-4" aria-hidden />
          </button>
        )}
      </footer>
    </div>
  );
}

const Card = ({ children, active }: { children: React.ReactNode; active?: boolean }) => (
  <div className={cn("rounded-lg bg-card p-5 shadow-[var(--shadow-card)]", active && "shadow-[var(--shadow-pop),inset_0_0_0_2px_var(--accent-soft)]")}>
    {children}
  </div>
);

function PermissionCard({ title, granted, detail, note, action, secondary, active }: {
  title: string;
  granted: boolean;
  detail: string;
  note?: string;
  active?: boolean;
  action: { label: string; run: () => void; icon?: boolean } | null;
  secondary?: { label: string; run: () => void } | null;
}) {
  return (
    <Card active={active && !granted}>
      <div className="flex flex-col gap-3.5">
        <div className="flex flex-wrap items-center gap-3.5">
          <span className={cn("grid size-9 shrink-0 place-items-center rounded-full", granted ? "bg-success/15" : "bg-arc-soft")}>
            {granted
              ? <Check className="size-4 text-success-text" strokeWidth={2.6} aria-hidden />
              : <span className="size-2.5 rounded-full bg-arc" aria-hidden />}
          </span>
          <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
            <span className="text-title-sm font-medium">{title}</span>
            <span className="text-label leading-relaxed text-muted-strong">{detail}</span>
          </div>
        </div>
        {note && (
          <p className="rounded-md bg-surface-raised px-3.5 py-3 text-label leading-relaxed text-muted-strong">{note}</p>
        )}
        {(action || secondary) && (
          <div className="flex flex-wrap items-center gap-2.5">
            {action && (
              <button type="button" onClick={action.run}
                className="flex items-center gap-2 rounded-full bg-accent px-4 py-2.5 text-callout font-medium text-accent-foreground transition hover:opacity-90">
                {action.icon && <ExternalLink className="size-4" aria-hidden />} {action.label}
              </button>
            )}
            {secondary && (
              <button type="button" onClick={secondary.run}
                className="rounded-full bg-surface-raised px-4 py-2.5 text-callout font-medium transition hover:bg-foreground/10">
                {secondary.label}
              </button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
