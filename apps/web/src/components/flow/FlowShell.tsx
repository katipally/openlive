"use client";

import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop } from "@/lib/platform";
import { flowBridge } from "@/lib/flow/bridge";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { useUi } from "@/lib/uiStore";
import { FlowHome } from "./FlowHome";
import { FlowOnboarding } from "./FlowOnboarding";

// Flow's half of the window. One home behind one header, with a session open
// over it, and a first run in front until the person has been asked for what
// Flow needs.

const ONBOARDED_KEY = "openlive-flow-onboarded";

const seen = (): boolean => { try { return localStorage.getItem(ONBOARDED_KEY) === "1"; } catch { return true; } };
const markSeen = (): void => { try { localStorage.setItem(ONBOARDED_KEY, "1"); } catch { /* private mode */ } };

/**
 * The hole the mode switch sits in.
 *
 * Electron only subtracts a no-drag element from a drag region when it is a
 * DESCENDANT of it. The switch is neither — it floats over this bar from the
 * page — so its own no-drag counts for nothing here and every click on it was
 * being swallowed as a window drag. The bar reserves the space instead.
 *
 * Window-centred rather than centred in this flex row, because that is where
 * the switch is, and this bar is padded unevenly for the traffic lights.
 */
export const SwitchHole = () => (
  <div aria-hidden className="fixed left-1/2 top-0 h-14 w-[11rem] -translate-x-1/2 [-webkit-app-region:no-drag]" />
);

export function FlowShell() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Undecided until the effect runs, so first paint never flashes the wrong one.
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  const { caps, refresh } = useFlowCapabilities();
  const { config, save } = useFlowConfig();

  useEffect(() => setOnboarding(!seen()), []);

  // Home's "Ready" is read here and handed down. Nothing announces a grant given
  // in System Settings, so coming back to the window re-reads it; the tray's
  // disarm is announced, and re-reads it too.
  useEffect(() => {
    window.addEventListener("focus", refresh);
    const offArmed = flowBridge()?.onArmed(refresh);
    return () => { window.removeEventListener("focus", refresh); offArmed?.(); };
  }, [refresh]);

  const finishOnboarding = () => { markSeen(); setOnboarding(false); refresh(); };

  if (onboarding === null) return <div className="h-dvh" />;

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
    <div className="flex h-dvh flex-col">
      {/* The centre of this bar belongs to the mode switch, which the page owns
          and draws over it at the same place in every mode. */}
      <header className={cn("relative flex h-14 shrink-0 items-center gap-3 pr-3",
        // An open session covers this bar, and a drag region under an overlay still eats its clicks.
        isMacDesktop ? "pl-[84px]" : "pl-4", isDesktop && !sessionId && "app-drag")}>
        {isDesktop && <SwitchHole />}
        <div className="flex-1" />

        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <button type="button" onClick={() => useUi.getState().openSettingsTab("flow")} aria-label="Flow settings"
            className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground [-webkit-app-region:no-drag]">
            <Settings2 className="size-[18px]" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col animate-fade-in">
        <FlowHome sessionId={sessionId} onOpen={setSessionId} caps={caps} />
      </div>
    </div>
  );
}
