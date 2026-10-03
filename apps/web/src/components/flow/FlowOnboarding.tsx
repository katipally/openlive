"use client";

import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { FlowConfig } from "@openlive/flow-store";
import { cn } from "@/lib/cn";
import { desktopPlatform, isDesktop, isMacDesktop, isNonMacDesktop } from "@/lib/platform";
import { keyName, liveKeys } from "@/lib/dictate/hotkey";
import { Button, linkClass } from "@/components/ui";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import type { FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import { flowOnboardingOpen } from "@/lib/settingChanges";
import { telemetry } from "@/lib/telemetry";
import { SkipSetup } from "@/components/SkipSetup";
import { AccessRows } from "./FlowSettings";
import { FlowCanvas } from "./FlowCanvas";
import { ModeStart, SwitchHole, modeCopy } from "./ModeSwitch";

// The first run, and only Flow's: what it needs from the machine. Who answers
// is the default, picked in Welcome and Settings > Models. Everything finer
// lives in Settings. Flow asks for anything skipped the first time it needs it.

/** The only keys the key listener acts on, with this person's own. */
function listensTo(config: FlowConfig | null): string {
  if (!config) return "Never listens to the keyboard beyond the keys that open Flow and Dictate, and push to talk's.";
  const k = liveKeys(config.talk);
  const name = (b: string) => keyName(b, desktopPlatform);
  const keys = [`${name(k.flow)} for Flow`, ...(config.dictate.enabled ? [`${name(k.dictate)} for Dictate`] : []), ...(config.talk.mode === "ptt" ? [`${name(k.ptt)} to talk`] : [])];
  return `Never listens to the keyboard beyond ${keys.length > 1 ? `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}` : keys[0]}.`;
}

export function FlowOnboarding({ onDone, config, save }: {
  onDone: () => void;
  config: FlowConfig | null;
  save: (patch: FlowConfigPatch) => void;
}) {
  useEffect(() => {
    telemetry.track("onboarding_step", { step: "flow_onboarding_shown" });
    flowOnboardingOpen(true);
    return () => flowOnboardingOpen(false);
  }, []);
  const finish = (how: "flow_onboarding_done" | "flow_onboarding_skipped") => { telemetry.track("onboarding_step", { step: how }); onDone(); };
  // Skipped, setup never comes back on its own, so Skip asks first, as Welcome's does.
  const [asking, setAsking] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={cn("flex h-14 shrink-0 items-center gap-3",
        isMacDesktop ? "pl-traffic-lights" : "pl-4", isNonMacDesktop ? "pr-window-controls" : "pr-3", isDesktop && "app-drag")}>
        {/* Stops short of the mode switch, which floats over the middle of this bar. */}
        <span className="min-w-0 flex-1 text-body font-semibold">
          <span className={cn("block truncate", isMacDesktop
            ? "max-w-[calc(50vw_-_var(--mode-switch-w,0px)/2_-_var(--spacing-traffic-lights)_-_var(--spacing)*3)]"
            : "max-w-[calc(50vw_-_var(--mode-switch-w,0px)/2_-_var(--spacing)*7)]")}>Set up Flow</span>
        </span>
        <SkipSetup asking={asking} onAsk={() => setAsking(true)} onKeep={() => setAsking(false)} onSkip={() => finish("flow_onboarding_skipped")} className="[-webkit-app-region:no-drag]" />
        {isDesktop && <SwitchHole />}
      </header>

      <FlowCanvas>
        <div className="flex flex-col gap-3">
          <OpenLiveOrb size={48} pulse />
          <h1 className="text-title-lg font-semibold tracking-tight">{modeCopy("flow").tagline}</h1>
          <p className="text-body leading-relaxed text-muted-strong">
            {modeCopy("flow").body} <ModeStart mode="flow" on /> It needs these first:
          </p>
        </div>
        <AccessRows config={config} save={save} askedFrom="onboarding" />
        <details className="group">
          <summary className={cn("cursor-pointer list-none text-label [&::-webkit-details-marker]:hidden", linkClass)}>
            What OpenLive never does
          </summary>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-label text-muted-strong">
            <li>{listensTo(config)}</li>
            <li>Mic opens only while Flow or Dictate is open. No wake word.</li>
            <li>No audio is kept.</li>
            <li>Nothing leaves this machine except what your API key&rsquo;s model or coding agent needs to answer.</li>
          </ul>
        </details>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <Button variant="primary" size="lg" onClick={() => finish("flow_onboarding_done")}>
            Start using Flow
            <ArrowRight aria-hidden />
          </Button>
        </div>
      </FlowCanvas>
    </div>
  );
}
