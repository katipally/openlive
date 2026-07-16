"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Settings2, SlidersHorizontal, AudioWaveform, Bot, Info } from "lucide-react";
import { useUi } from "@/lib/uiStore";
import { useAppVersion } from "@/lib/useAppVersion";
import { GeneralSettings } from "./GeneralSettings";
import { ModelsSettings } from "./ModelsSettings";
import { PipelineSettings } from "./PipelineSettings";
import { AgentsSettings } from "./AgentsSettings";
import { AboutSettings } from "./AboutSettings";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop } from "@/lib/platform";

const SECTIONS = [
  { id: "general", label: "General", sub: "Appearance, input & startup", icon: Settings2, Comp: GeneralSettings },
  { id: "models", label: "Models", sub: "Provider, model & vision", icon: SlidersHorizontal, Comp: ModelsSettings },
  { id: "pipeline", label: "Pipeline", sub: "On-device speech pipeline", icon: AudioWaveform, Comp: PipelineSettings },
  { id: "agents", label: "Agents", sub: "Install, sign in & visibility", icon: Bot, Comp: AgentsSettings },
  { id: "about", label: "About", sub: "Version & links", icon: Info, Comp: AboutSettings },
] as const;
type TabId = (typeof SECTIONS)[number]["id"];

// Full-screen Settings — macOS-style side nav + a centered content column. Kept
// mounted as an overlay (z above the live call) so opening it MID-CALL never
// unmounts the call: the session keeps running, we just cover it. GSAP drives the
// enter/exit and the content cross-fade; a soft #settings history entry makes the
// browser Back button (and ⌘[) close it, so it reads like its own route.
export function SettingsPage() {
  const appVersion = useAppVersion();
  const openStore = useUi((s) => s.settingsOpen);
  const closeStore = useUi((s) => s.closeSettings);
  const wantTab = useUi((s) => s.settingsTab);
  const [visible, setVisible] = useState(false);
  const [tab, setTab] = useState<TabId>("models");
  const root = useRef<HTMLDivElement>(null);
  const firstPaint = useRef(true);

  // Store open → show. (Close is driven through requestClose so the exit animates.)
  useEffect(() => { if (openStore) setVisible(true); }, [openStore]);
  // Honor a deep-link (e.g. "Sessions →" opens straight to Agents), then clear it.
  useEffect(() => {
    if (openStore && wantTab && SECTIONS.some((s) => s.id === wantTab)) { setTab(wantTab as TabId); useUi.setState({ settingsTab: null }); }
  }, [openStore, wantTab]);

  // Enter: fade the surface, stagger the nav, rise the content pane.
  const { contextSafe } = useGSAP(() => {
    if (!visible) return;
    firstPaint.current = true;
    if (prefersReduced()) { gsap.fromTo(root.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.12 }); return; }
    gsap.timeline()
      .fromTo(root.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.base, ease: EASE.soft })
      .fromTo(".ol-set-navitem", { autoAlpha: 0, x: -10 }, { autoAlpha: 1, x: 0, stagger: 0.045, duration: DUR.base, ease: EASE.out }, "-=0.08")
      .fromTo(".ol-set-pane", { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: DUR.slow, ease: EASE.snappy }, "<");
  }, { scope: root, dependencies: [visible] });

  // Cross-fade the content on section change (skip the very first paint — the
  // enter timeline already revealed it).
  useGSAP(() => {
    if (!visible) return;
    if (firstPaint.current) { firstPaint.current = false; return; }
    gsap.fromTo(".ol-set-body", { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: DUR.base, ease: EASE.out });
  }, { scope: root, dependencies: [tab] });

  // Exit = the entrance played in reverse: pane sinks back, nav slides back out
  // (tail-first), surface fades — same offsets as the enter, just quicker.
  const requestClose = contextSafe(() => {
    const el = root.current;
    const done = () => { setVisible(false); closeStore(); };
    if (!el || prefersReduced()) { done(); return; }
    gsap.timeline({ onComplete: done })
      .to(".ol-set-pane", { autoAlpha: 0, y: 14, duration: DUR.base, ease: EASE.soft }, 0)
      .to(".ol-set-navitem", { autoAlpha: 0, x: -10, stagger: { each: 0.03, from: "end" }, duration: DUR.fast, ease: EASE.soft }, 0)
      .to(el, { autoAlpha: 0, duration: DUR.base, ease: EASE.soft }, 0.05);
  });

  useFocusTrap(root, visible, requestClose);

  // Soft route: push a #settings history entry while open so Back closes it.
  useEffect(() => {
    if (!visible) return;
    window.history.pushState({ ol: "settings" }, "", "#settings");
    const onPop = () => { setVisible(false); closeStore(); };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (window.history.state?.ol === "settings") window.history.back();
    };
  }, [visible, closeStore]);

  if (!visible) return null;
  const Active = SECTIONS.find((s) => s.id === tab)!;

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label="Settings"
      className="fixed inset-0 z-[60] flex flex-col bg-background text-left">
      {/* header — drag region (frameless window) + back; clears the traffic lights */}
      <header className={cn("relative flex h-14 shrink-0 items-center gap-3 pr-4",
        isMacDesktop ? "pl-[84px]" : "pl-4", isDesktop && "[-webkit-app-region:drag]")}>
        <button onClick={requestClose} aria-label="Back" title="Back"
          className={cn("grid size-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground", isDesktop && "[-webkit-app-region:no-drag]")}>
          <ArrowLeft className="size-5" />
        </button>
        <span className="flex items-baseline gap-2 text-[15px] font-semibold">
          Settings
          {appVersion && <span className="text-[11px] font-normal text-muted-foreground">v{appVersion}</span>}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* side nav */}
        <nav aria-label="Settings sections" className="w-[236px] shrink-0 space-y-1 overflow-y-auto p-3">
          {SECTIONS.map((s) => {
            const on = s.id === tab;
            return (
              <button key={s.id} onClick={() => setTab(s.id)} aria-current={on ? "page" : undefined}
                className={cn("ol-set-navitem group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition",
                  on ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]")}>
                <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg border transition",
                  on ? "border-transparent bg-accent text-accent-foreground" : "border-border text-muted-foreground group-hover:text-foreground")}>
                  <s.icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className={cn("block text-[13px] font-medium", on ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>{s.label}</span>
                  <span className="block truncate text-[11px] text-faint">{s.sub}</span>
                </span>
              </button>
            );
          })}
        </nav>

        {/* content — centered readable column */}
        <main className="openlive-scroll ol-set-pane min-h-0 flex-1 overflow-y-auto">
          <div className="ol-set-body mx-auto w-full max-w-2xl px-8 py-9">
            <div className="mb-6">
              <h1 className="text-[20px] font-semibold tracking-tight text-foreground">{Active.label}</h1>
              <p className="mt-1 text-[13px] text-muted-foreground">{Active.sub}</p>
            </div>
            <Active.Comp />
          </div>
        </main>
      </div>
    </div>
  );
}
