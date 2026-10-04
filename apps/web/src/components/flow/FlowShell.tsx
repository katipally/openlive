"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop } from "@/lib/platform";
import { flowBridge } from "@/lib/flow/bridge";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { FLOW_ONBOARDED_DONE, flowOnboardingDue } from "@/lib/flow/onboarding";
import { useOnboarding } from "@/lib/prefs";
import { coverConcepts } from "@/components/SpotlightTour";
import { FlowHome } from "./FlowHome";
import { FlowOnboarding } from "./FlowOnboarding";
import { SwitchHole } from "./ModeSwitch";

// Flow's half of the window. One home behind one header, with a session open
// over it, and a first run in front until the person has been asked for what
// Flow needs.

const markSeen = (): void => { useOnboarding.setState({ flowOnboarded: FLOW_ONBOARDED_DONE }); };

export function FlowShell() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Whether the first run shows, undecided until the effect runs, so first
  // paint never flashes the wrong screen.
  const [onboarding, setOnboarding] = useState<boolean | undefined>(undefined);
  const { caps, refresh } = useFlowCapabilities();
  const { config, save } = useFlowConfig();

  // Read again when it changes: Welcome can finish it, and Show me around again starts it over.
  const flag = useOnboarding((s) => s.flowOnboarded);
  useEffect(() => setOnboarding(flowOnboardingDue(flag)), [flag]);

  // Home's "Ready" is read here and handed down. Nothing announces a grant given
  // in System Settings, so coming back to the window re-reads it; Flow's off
  // switch is announced, and re-reads it too.
  useEffect(() => {
    window.addEventListener("focus", refresh);
    const offArmed = flowBridge()?.onArmed(refresh);
    return () => { window.removeEventListener("focus", refresh); offArmed?.(); };
  }, [refresh]);

  // It showed how Flow opens, so Flow's tour right after it skips the switch.
  const finishOnboarding = () => { markSeen(); coverConcepts("flowPower"); setOnboarding(false); refresh(); };

  if (onboarding === undefined) return <div className="h-dvh" />;

  if (onboarding) {
    return (
      <div className="flex h-dvh flex-col">
        <div className="flex min-h-0 flex-1 flex-col animate-fade-in">
          <FlowOnboarding onDone={finishOnboarding} config={config} save={save} />
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-dvh flex-col">
      {/* The centre of this bar belongs to the mode switch, which the page owns
          and draws over it at the same place in every mode. The bar floats over
          the page, so what scrolls passes behind the switch instead of ending
          at the bar. */}
      <header className={cn("absolute inset-x-0 top-0 flex h-14 items-center gap-3 pr-3",
        // An open session covers this bar, and a drag region under an overlay still eats its clicks.
        isMacDesktop ? "pl-traffic-lights" : "pl-4", isDesktop && !sessionId && "app-drag", !isDesktop && "pointer-events-none")}>
        {isDesktop && <SwitchHole />}
      </header>

      <div className="flex min-h-0 flex-1 flex-col animate-fade-in">
        <FlowHome sessionId={sessionId} onOpen={setSessionId} caps={caps} onRetry={refresh} />
      </div>
    </div>
  );
}
