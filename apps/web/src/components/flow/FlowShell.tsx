"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Settings2, X } from "lucide-react";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop } from "@/lib/platform";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { ModeSwitch } from "./ModeSwitch";
import { FlowHome } from "./FlowHome";
import { FlowSettings } from "./FlowSettings";
import { FlowHistory } from "./FlowHistory";
import { FlowOnboarding } from "./FlowOnboarding";

// Flow's half of the window. Three surfaces behind one header, and a first run
// in front of all of them until the person has been asked for what Flow needs.

export type FlowView = "home" | "settings" | "history";

const ONBOARDED_KEY = "openlive-flow-onboarded";

const seen = (): boolean => { try { return localStorage.getItem(ONBOARDED_KEY) === "1"; } catch { return true; } };
const markSeen = (): void => { try { localStorage.setItem(ONBOARDED_KEY, "1"); } catch { /* private mode */ } };

export function FlowShell() {
  const [view, setView] = useState<FlowView>("home");
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Undecided until the effect runs, so first paint never flashes the wrong one.
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  const { caps, refresh } = useFlowCapabilities();
  const { config, brainReady, save } = useFlowConfig();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => setOnboarding(!seen()), []);

  const finishOnboarding = () => { markSeen(); setOnboarding(false); refresh(); };

  const open = (next: FlowView, id: string | null = null) => { setView(next); setSessionId(id); };

  // One cross-fade per surface change. Transforms and opacity only.
  useGSAP(() => {
    if (prefersReduced()) return;
    gsap.fromTo(".ol-flow-view", { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: DUR.base, ease: EASE.out });
  }, { scope: root, dependencies: [view, sessionId, onboarding] });

  if (onboarding === null) return <div className="min-h-dvh" />;

  if (onboarding) {
    return (
      <div ref={root} className="ol-flow-view flex min-h-dvh flex-col">
        <FlowOnboarding onDone={finishOnboarding} config={config} brainReady={brainReady} save={save} />
      </div>
    );
  }

  const armed = !caps ? null : caps.armed && !!caps.permissions?.accessibility && !caps.hookError;

  return (
    <div ref={root} className="flex min-h-dvh flex-col">
      <header className={cn("flex h-14 shrink-0 items-center gap-3 pr-3",
        isMacDesktop ? "pl-[84px]" : "pl-4", isDesktop && "app-drag")}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {view === "home" ? (
            <>
              <OpenLiveOrb size={22} />
              <span className="truncate text-body font-semibold">OpenLive</span>
            </>
          ) : (
            <button type="button" onClick={() => open("home")} aria-label="Back to Flow"
              className="flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-body text-muted-foreground transition hover:text-foreground">
              <ArrowLeft className="size-4 shrink-0" />
              <span className="truncate">Flow</span>
            </button>
          )}
        </div>

        <ModeSwitch className="shrink-0" />

        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          {armed !== null && (
            <span className="flex shrink-0 items-center gap-2 rounded-full bg-card px-2.5 py-1 shadow-[var(--shadow-xs)]">
              <span className={cn("size-1.5 rounded-full", armed ? "bg-success" : "bg-muted-foreground")} />
              <span className="text-caption text-muted-strong">{armed ? "Armed" : "Off"}</span>
            </span>
          )}
          {view === "settings" ? (
            <button type="button" onClick={() => open("home")} aria-label="Close Flow settings"
              className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
              <X className="size-5" />
            </button>
          ) : (
            <button type="button" onClick={() => open("settings")} aria-label="Flow settings"
              className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
              <Settings2 className="size-[18px]" />
            </button>
          )}
        </div>
      </header>

      <div className="ol-flow-view flex min-h-0 flex-1 flex-col">
        {view === "home" && <FlowHome onOpen={open} />}
        {view === "settings" && <FlowSettings />}
        {view === "history" && <FlowHistory sessionId={sessionId} onSelect={(id) => open("history", id)} />}
      </div>
    </div>
  );
}
