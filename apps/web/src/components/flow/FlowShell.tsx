"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop } from "@/lib/platform";
import { flowBridge } from "@/lib/flow/bridge";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { FLOW_ONBOARDED_DONE, flowOnboardingStep } from "@/lib/flow/onboarding";
import { useOnboarding } from "@/lib/prefs";
import { FlowHome } from "./FlowHome";
import { FlowOnboarding } from "./FlowOnboarding";
import { SwitchHole } from "./ModeSwitch";

// Flow's half of the window. One home behind one header, with a session open
// over it, and a first run in front until the person has been asked for what
// Flow needs.

const firstStep = (): 1 | 2 | null => flowOnboardingStep(useOnboarding.getState().flowOnboarded);
const markSeen = (): void => { useOnboarding.setState({ flowOnboarded: FLOW_ONBOARDED_DONE }); };

export function FlowShell() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  // The step the first run opens at, null once done, and undecided until the
  // effect runs, so first paint never flashes the wrong one.
  const [onboarding, setOnboarding] = useState<1 | 2 | null | undefined>(undefined);
  const { caps, refresh } = useFlowCapabilities();
  const { config, save } = useFlowConfig();

  useEffect(() => setOnboarding(firstStep()), []);

  // Home's "Ready" is read here and handed down. Nothing announces a grant given
  // in System Settings, so coming back to the window re-reads it; Flow's off
  // switch is announced, and re-reads it too.
  useEffect(() => {
    window.addEventListener("focus", refresh);
    const offArmed = flowBridge()?.onArmed(refresh);
    return () => { window.removeEventListener("focus", refresh); offArmed?.(); };
  }, [refresh]);

  const finishOnboarding = () => { markSeen(); setOnboarding(null); refresh(); };

  if (onboarding === undefined) return <div className="h-dvh" />;

  if (onboarding) {
    return (
      <div className="flex h-dvh flex-col">
        <div className="flex min-h-0 flex-1 flex-col animate-fade-in">
          <FlowOnboarding from={onboarding} onDone={finishOnboarding} config={config} save={save} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      {/* The centre of this bar belongs to the mode switch, which the page owns
          and draws over it at the same place in every mode. */}
      <header className={cn("relative flex h-14 shrink-0 items-center gap-3 pr-3",
        // An open session covers this bar, and a drag region under an overlay still eats its clicks.
        isMacDesktop ? "pl-traffic-lights" : "pl-4", isDesktop && !sessionId && "app-drag")}>
        {isDesktop && <SwitchHole />}
      </header>

      <div className="flex min-h-0 flex-1 flex-col animate-fade-in">
        <FlowHome sessionId={sessionId} onOpen={setSessionId} caps={caps} onRetry={refresh} />
      </div>
    </div>
  );
}
