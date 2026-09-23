"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronLeft, Settings2, SlidersHorizontal, Waves, AudioWaveform, Bot, Info, Search } from "lucide-react";
import { useUi } from "@/lib/uiStore";
import { useAppVersion } from "@/lib/useAppVersion";
import { GeneralSettings } from "./GeneralSettings";
import { ModelsSettings } from "./ModelsSettings";
import { VoiceSettings } from "./VoiceSettings";
import { AgentsSettings } from "./AgentsSettings";
import { AboutSettings } from "./AboutSettings";
import { FlowSettings } from "@/components/flow/FlowSettings";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop, isWinDesktop, MOD } from "@/lib/platform";
import { SpotlightTour } from "@/components/SpotlightTour";
import { resolveSettingsTab, searchSettings, type SettingsEntry, type SettingsTabId } from "@/lib/settingsSearch";

export const SECTIONS = [
  { id: "general", label: "General", sub: "Appearance, speech & startup", icon: Settings2, Comp: GeneralSettings },
  { id: "models", label: "Models", sub: "API mode · BYOK", icon: SlidersHorizontal, Comp: ModelsSettings },
  { id: "flow", label: "Flow", sub: "Trigger, voice & typing", icon: Waves, Comp: FlowSettings },
  { id: "voice", label: "Voice", sub: "Speed, engine, your voices", icon: AudioWaveform, Comp: VoiceSettings },
  { id: "agents", label: "Agents", sub: "Install, sign in & visibility", icon: Bot, Comp: AgentsSettings },
  { id: "about", label: "About", sub: "Version & links", icon: Info, Comp: AboutSettings },
] as const;
type TabId = (typeof SECTIONS)[number]["id"];
const tabLabel = (t: SettingsTabId) => SECTIONS.find((s) => s.id === t)!.label;
const HIT_MS = 1600;

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
  const origin = useUi((s) => s.settingsOrigin);
  const [visible, setVisible] = useState(false);
  const [tab, setTab] = useState<TabId>("general");
  const root = useRef<HTMLDivElement>(null);
  const firstPaint = useRef(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [jump, setJump] = useState<{ anchor: string } | null>(null);
  const [searching, setSearching] = useState(false);
  // Narrow windows fold the nav to an icon rail; searching unfolds it, since a
  // result list needs the words.
  const rail = !searching && !query && "@max-3xl/settings:sr-only";
  const listId = useId();
  const results = useMemo(() => searchSettings(query, tabLabel, isDesktop), [query]);
  const current = results[Math.min(active, results.length - 1)];

  // Store open → show. (Close is driven through requestClose so the exit animates;
  // a close from outside, like a palette command, hides without one.)
  useEffect(() => setVisible(openStore), [openStore]);
  // Closing with the search focused hides the input without a blur event, so
  // `searching` has to be reset here or the rail stays unfolded next time.
  useEffect(() => { if (!visible) { setQuery(""); setActive(0); setSearching(false); } }, [visible]);
  // Honor a deep-link (e.g. "Sessions →" opens straight to Agents), then clear it.
  // Ids of merged tabs ("pipeline", "voices") resolve to the tab that holds them now.
  useEffect(() => {
    const want = resolveSettingsTab(wantTab);
    if (openStore && want) { setTab(want); useUi.setState({ settingsTab: null }); }
  }, [openStore, wantTab]);

  // ⌘F / Ctrl+F while Settings is up goes to its search, not the page's find.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible]);

  // A picked search result: once its tab has rendered, bring the row into view and
  // flash it. Rows can arrive late (a tab still fetching its settings), so look for
  // a short while; a row that never shows (e.g. voices before the engine is
  // installed) just leaves the tab at its top.
  useEffect(() => {
    if (!jump) return;
    let raf = 0, tries = 0;
    const find = () => {
      const el = document.getElementById(jump.anchor);
      if (!el) { if (++tries < 60) raf = requestAnimationFrame(find); return; }
      // Stage tabs inside the speech engine: open the one the result names.
      if (el.hasAttribute("data-reveal")) el.click();
      el.scrollIntoView({ block: "center", behavior: prefersReduced() ? "auto" : "smooth" });
      el.classList.add("ol-set-hit");
      setTimeout(() => el.classList.remove("ol-set-hit"), HIT_MS);
    };
    raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
  }, [jump]);

  const go = (e: SettingsEntry) => {
    setTab(e.tab);
    setJump({ anchor: e.anchor });
    setQuery("");
    setActive(0);
  };
  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const n = results.length;
    if (e.key === "ArrowDown" && n) { e.preventDefault(); setActive((i) => (Math.min(i, n - 1) + 1) % n); }
    else if (e.key === "ArrowUp" && n) { e.preventDefault(); setActive((i) => (Math.min(i, n - 1) - 1 + n) % n); }
    else if (e.key === "Enter" && current) { e.preventDefault(); go(current); }
    // A query to clear claims Esc; an empty box lets it close Settings as usual.
    else if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); setActive(0); }
  };

  // Enter: fade the surface, stagger the nav, rise the content pane.
  const { contextSafe } = useGSAP(() => {
    if (!visible) return;
    firstPaint.current = true;
    // Opacity, not autoAlpha: a visibility-hidden dialog cannot take the focus the
    // trap moves into it on open.
    if (prefersReduced()) { gsap.fromTo(root.current, { opacity: 0 }, { opacity: 1, duration: 0.12 }); return; }
    gsap.timeline()
      .fromTo(root.current, { opacity: 0 }, { opacity: 1, duration: DUR.base, ease: EASE.soft })
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
      className="fixed inset-0 z-[var(--z-settings)] flex flex-col bg-background text-left">
      {/* header: drag region (frameless window), clear of the traffic lights on
          macOS and the window controls on Windows/Linux. */}
      <header className={cn("relative flex h-14 shrink-0 items-center gap-3",
        isMacDesktop ? "pl-[84px]" : "pl-4", isWinDesktop ? "pr-[140px]" : "pr-3",
        isDesktop && "[-webkit-app-region:drag]")}>
        <span className="flex min-w-0 items-baseline gap-2 text-title-sm font-semibold">
          Settings
          {appVersion && <span className="text-caption font-normal text-muted-foreground">v{appVersion}</span>}
        </span>
      </header>

      <div className="@container/settings flex min-h-0 flex-1">
        {/* side nav: the way back first, then the sections. Esc and ⌘[ go back too
            (focus trap + history). */}
        <nav aria-label="Settings sections" data-tour="settings-nav"
          className={cn("w-[236px] shrink-0 space-y-1 overflow-y-auto p-3", rail && "@max-3xl/settings:w-auto @max-3xl/settings:p-2")}>
          <button type="button" onClick={requestClose} title={`Back to ${origin} (Esc)`} aria-label={`Back to ${origin}`}
            className="sticky top-0 z-10 mb-2 flex w-full items-center gap-2 rounded-xl bg-background px-3 py-2 text-left text-body font-medium text-muted-foreground transition hover:bg-foreground/[0.04] hover:text-foreground">
            <ChevronLeft className="size-4 shrink-0" aria-hidden />
            <span className={cn("min-w-0 flex-1 truncate", rail)}>Back to {origin}</span>
            <kbd aria-hidden className={cn("shrink-0 rounded-md border border-border px-1.5 font-mono text-micro text-faint", rail && "@max-3xl/settings:hidden")}>esc</kbd>
          </button>
          <label data-tour="settings-search" title="Search settings"
            className="mb-2 flex cursor-text items-center gap-2 rounded-xl border border-border bg-card px-3 transition focus-within:border-border-heavy">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input ref={searchRef} type="search" value={query} placeholder="Search settings" aria-label="Search settings"
              onFocus={() => setSearching(true)} onBlur={() => setSearching(false)}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onSearchKey}
              role="combobox" aria-expanded={!!query.trim()} aria-controls={listId} aria-autocomplete="list"
              aria-activedescendant={current ? `${listId}-${results.indexOf(current)}` : undefined}
              autoComplete="off" spellCheck={false}
              className={cn("h-9 min-w-0 flex-1 bg-transparent text-label text-foreground outline-none placeholder:text-faint", rail && "@max-3xl/settings:w-0 @max-3xl/settings:flex-none")} />
          </label>
          {query.trim() ? (
            results.length ? (
              <div id={listId} role="listbox" aria-label="Matching settings">
                {results.map((r, i) => {
                  const on = r === current;
                  return (
                    <div key={`${r.tab}-${r.label}`} id={`${listId}-${i}`} role="option" aria-selected={on}
                      onMouseMove={() => { if (!on) setActive(i); }} onMouseDown={(e) => e.preventDefault()} onClick={() => go(r)}
                      className={cn("flex cursor-default flex-col rounded-xl px-3 py-2 text-left transition", on ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]")}>
                      <span className="break-words text-body font-medium text-foreground">{r.label}</span>
                      <span className="text-caption text-faint">{tabLabel(r.tab)}</span>
                    </div>
                  );
                })}
              </div>
            ) : <p id={listId} role="status" className="px-3 py-2 text-label text-muted-foreground">No matches</p>
          ) : SECTIONS.map((s) => {
            const on = s.id === tab;
            return (
              <button key={s.id} onClick={() => setTab(s.id)} aria-current={on ? "page" : undefined} title={s.label}
                className={cn("ol-set-navitem group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition",
                  on ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]")}>
                <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg border transition",
                  on ? "border-transparent bg-accent text-accent-foreground" : "border-border text-muted-foreground group-hover:text-foreground")}>
                  <s.icon className="size-4" />
                </span>
                <span className={cn("min-w-0", rail)}>
                  <span className={cn("block text-body font-medium", on ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>{s.label}</span>
                  <span className="block truncate text-caption text-faint">{s.sub}</span>
                </span>
              </button>
            );
          })}
        </nav>

        {/* content — centered readable column */}
        <main className="openlive-scroll ol-set-pane min-h-0 flex-1 overflow-y-auto">
          <div className="ol-set-body mx-auto w-full max-w-2xl px-8 py-9 @max-3xl/settings:px-5 @max-3xl/settings:py-6">
            <div className="mb-6">
              <h1 className="text-title-lg font-semibold tracking-tight text-foreground">{Active.label}</h1>
              <p className="mt-1 text-body text-muted-foreground">{Active.sub}</p>
            </div>
            <Active.Comp />
          </div>
        </main>
      </div>

      <SpotlightTour id="settings" steps={[
        { target: "settings-nav", title: "Six focused tabs", body: "General (appearance, style & speech), Models for API mode (BYOK), Flow's trigger, voice & typing, Voice for speed, the on-device engine and your cloned voices, agent install & sign-in under Agents, and About." },
        { target: "settings-search", title: "Search any setting", body: `Type what you are after and jump straight to it. ${MOD === "⌘" ? "⌘F" : "Ctrl+F"} gets you here from anywhere in Settings.` },
      ]} />
    </div>
  );
}
