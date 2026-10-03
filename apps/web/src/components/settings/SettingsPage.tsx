"use client";

import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { animate, motion, stagger } from "motion/react";
import { ChevronLeft, Settings2, SlidersHorizontal, Waves, AudioWaveform, Cpu, Bot, MessageSquare, Info, Search, Link2, ShieldCheck, Blocks, Brain, Mic } from "lucide-react";
import { useUi } from "@/lib/uiStore";
import { featureUsed } from "@/lib/featureUse";
import { useAppVersion } from "@/lib/useAppVersion";
import { GeneralSettings } from "./GeneralSettings";
import { ModelsSettings } from "./ModelsSettings";
import { VoiceSettings } from "./VoiceSettings";
import { PipelineSettings } from "./PipelineSettings";
import { ChatSettings } from "./ChatSettings";
import { DictateSettings } from "./DictateSettings";
import { SettingsNav, type SettingsGo } from "./nav";
import { Chip, Input, Tooltip, groupLabel } from "@/components/ui";
import { AgentsRecheck, AgentsSettings } from "./AgentsSettings";
import { CapabilitiesSettings } from "./CapabilitiesSettings";
import { MemoryClearAll, MemorySettings } from "./MemorySettings";
import { AboutSettings } from "./AboutSettings";
import { PrivacySettings } from "./PrivacySettings";
import { FlowSettings } from "@/components/flow/FlowSettings";
import { modeCopy } from "@/components/flow/ModeSwitch";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { animateAll, EXIT, FADE, GENTLE, SMOOTH, useMotionTokens } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { desktopPlatform, isDesktop, isMacDesktop, isNonMacDesktop, MOD } from "@/lib/platform";
import { SpotlightTour } from "@/components/SpotlightTour";
import { capabilityTab, resolveSettingsTab, searchSettings, type SettingsEntry, type SettingsTabId } from "@/lib/settingsSearch";

// `group` names the run of the nav a section belongs to; a heading opens each
// run. `desc` is the page's own line when it says more than `sub`.
export const SECTIONS = [
  { id: "general", label: "General", sub: "Look, how you talk, keys", desc: "Look, startup, how you talk and typing.", icon: Settings2, Comp: GeneralSettings },
  { id: "flow", label: "Flow", sub: "Trigger, who answers", desc: modeCopy("flow").tagline, icon: Waves, Comp: FlowSettings, group: "Modes" },
  { id: "dictate", label: "Dictate", sub: "Cleanup, words, edits", desc: modeCopy("dictate").tagline, icon: Mic, Comp: DictateSettings, group: "Modes" },
  { id: "chat", label: "Chat", sub: "Narration", desc: modeCopy("chat").tagline, icon: MessageSquare, Comp: ChatSettings, group: "Modes" },
  { id: "models", label: "Models", sub: "Who answers, API key", desc: "Who answers you, and the model your own key runs.", icon: SlidersHorizontal, Comp: ModelsSettings, group: "Intelligence", shared: true },
  { id: "agents", label: "Agents", sub: "Install, sign in", desc: "Coding agents that can think for Chat, Flow and Dictate.", icon: Bot, Comp: AgentsSettings, Action: AgentsRecheck, group: "Intelligence", shared: true, wide: true },
  { id: "capabilities", label: "Capabilities", sub: "Tools, skills, connectors", desc: "What whoever answers can use, your API key's model and coding agents alike.", icon: Blocks, Comp: CapabilitiesSettings, group: "Intelligence", shared: true, wide: true },
  { id: "memory", label: "Memory", sub: "Facts about you", desc: "Facts carried into every conversation, whoever answers.", icon: Brain, Comp: MemorySettings, Action: MemoryClearAll, group: "Intelligence", shared: true, wide: true },
  { id: "voice", label: "Voice", sub: "Language, voice, pace", desc: "How OpenLive hears and speaks, in every mode.", icon: AudioWaveform, Comp: VoiceSettings, group: "Voice", shared: true },
  { id: "engine", label: "Speech engine", sub: "VAD · STT · TTS", desc: "Your whole voice pipeline runs on-device. Nothing here leaves your machine.", icon: Cpu, Comp: PipelineSettings, group: "Voice", shared: true },
  { id: "privacy", label: "Privacy", sub: "Anonymous usage", desc: "What OpenLive shares about its own use.", icon: ShieldCheck, Comp: PrivacySettings, group: "App", desktop: true },
  { id: "about", label: "About", sub: "Version, links", desc: "Version, your data and links.", icon: Info, Comp: AboutSettings, group: "App" },
] as const satisfies readonly Sec[];
type TabId = (typeof SECTIONS)[number]["id"];
interface Sec {
  id: SettingsTabId; label: string; sub: string; icon: typeof Info; Comp: () => React.ReactNode;
  group?: "Modes" | "Intelligence" | "Voice" | "App"; desc?: string; shared?: boolean;
  /** The one action beside the page's title. */
  Action?: () => React.ReactNode;
  /** Cards side by side: a wider column than the reading width. */
  wide?: boolean;
  /** Needs the desktop shell: left out of a browser tab. */
  desktop?: boolean;
}
/** The tabs this window offers. */
export const shownSections = () => SECTIONS.filter((s: Sec) => !s.desktop || isDesktop);
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
  const body = useRef<HTMLDivElement>(null);
  const firstPaint = useRef(true);
  // Open in the first render only when ui.json reopened it at launch: that one
  // appears already in place, with no enter to replay over the page it covers.
  const restored = useRef(openStore);
  const lastTab = useRef<TabId>(tab);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [jump, setJump] = useState<Pick<SettingsEntry, "anchor" | "reveal"> | null>(null);
  const [searching, setSearching] = useState(false);
  // Narrow windows fold the nav to an icon rail; searching unfolds it, since a
  // result list needs the words.
  const rail = !searching && !query && "@max-3xl/settings:sr-only";
  const listId = useId();
  const navMark = useId();
  const t = useMotionTokens();
  const results = useMemo(() => searchSettings(query, tabLabel, isDesktop, undefined, desktopPlatform), [query]);
  const current = results[Math.min(active, results.length - 1)];

  // Store open → show. (Close is driven through requestClose so the exit animates;
  // a close from outside, like a palette command, hides without one.)
  useEffect(() => setVisible(openStore), [openStore]);
  useEffect(() => { if (!openStore) restored.current = false; }, [openStore]);
  useEffect(() => { if (visible) featureUsed(`n_settings_tab_${tab}`); }, [visible, tab]);
  // Remembered, so a relaunch reopens this tab (uiStore's `settings` field).
  useEffect(() => { if (openStore) useUi.setState({ settingsShown: tab }); }, [openStore, tab]);
  // Closing with the search focused hides the input without a blur event, so
  // `searching` has to be reset here or the rail stays unfolded next time.
  useEffect(() => { if (!visible) { setQuery(""); setActive(0); setSearching(false); } }, [visible]);
  // Honor a deep-link (e.g. "Sessions →" opens straight to Agents), then clear it.
  // Ids of merged tabs ("pipeline", "voices") resolve to the tab that holds them
  // now; "connectors" and "skills" also pick their Capabilities subtab.
  useEffect(() => {
    const want = resolveSettingsTab(wantTab);
    if (!openStore || !want) return;
    const sub = capabilityTab(wantTab);
    if (sub) useUi.getState().setCapabilitiesTab(sub);
    setTab(want);
    const at = useUi.getState().settingsJump;
    if (at) setJump(at);
    useUi.setState({ settingsTab: null, settingsJump: null });
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
    let raf = 0, tries = 0, revealed = !jump.reveal;
    const find = () => {
      const tab = revealed ? null : document.getElementById(jump.reveal!);
      if (tab) { tab.click(); revealed = true; }
      const el = revealed && document.getElementById(jump.anchor);
      if (!el) { if (++tries < 60) raf = requestAnimationFrame(find); return; }
      // Stage tabs inside the speech engine: open the one the result names.
      if (el.hasAttribute("data-reveal")) el.click();
      // A row folded under Advanced: unfold it (and every fold around it).
      for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
      el.scrollIntoView({ block: "center", behavior: t.reduce ? "auto" : "smooth" });
      el.classList.add("ol-set-hit");
      setTimeout(() => el.classList.remove("ol-set-hit"), HIT_MS);
    };
    raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
  }, [jump]);

  const go = (e: SettingsEntry) => {
    setTab(e.tab);
    setJump({ anchor: e.anchor, reveal: e.reveal });
    setQuery("");
    setActive(0);
  };
  const goTo: SettingsGo = (t, anchor, reveal) => {
    setTab(t);
    if (anchor) setJump({ anchor, reveal });
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

  // Enter: fade the surface, stagger the nav, rise the content pane. Opacity only
  // on the page: a visibility-hidden dialog cannot take the focus the trap moves
  // into it on open.
  useLayoutEffect(() => {
    const el = root.current;
    if (!visible || !el) return;
    firstPaint.current = true;
    if (restored.current) return;
    const runs = t.reduce ? [animate(el, { opacity: [0, 1] }, t.fade)] : [
      animate(el, { opacity: [0, 1] }, FADE),
      animateAll(el, ".ol-set-navitem", { opacity: [0, 1], x: [-10, 0] }, { ...SMOOTH, delay: stagger(0.045, { startDelay: 0.1 }) }),
      animateAll(el, ".ol-set-pane", { opacity: [0, 1], y: [14, 0] }, { ...GENTLE, delay: 0.1 }),
    ];
    return () => runs.forEach((r) => r?.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- plays each time the page opens
  }, [visible]);

  // A new section slides in from the side of the nav it came from: up from below
  // when it sits lower in the list, down from above when higher. Skips the very
  // first paint, which the enter timeline already revealed. Before paint, so the
  // old section never shows in the new one's place.
  useLayoutEffect(() => {
    const from = lastTab.current;
    lastTab.current = tab;
    const el = body.current;
    if (!visible || !el) return;
    if (firstPaint.current) { firstPaint.current = false; return; }
    if (from === tab) return;
    const order = (t: TabId) => SECTIONS.findIndex((s) => s.id === t);
    const dir = order(tab) > order(from) ? 1 : -1;
    const run = t.reduce
      ? animate(el, { opacity: [0, 1] }, t.fade)
      : animate(el, { opacity: [0, 1], y: [dir * 14, 0] }, { ...SMOOTH, opacity: FADE });
    return () => run.stop();
  }, [tab, visible]);

  // Exit = the entrance in reverse: the pane sinks back, the nav slides back out
  // tail-first, the surface fades.
  const requestClose = async () => {
    const el = root.current;
    // The page under a glass Settings comes back first, so the fade-out shows it.
    el?.removeAttribute("data-covering");
    if (el && !t.reduce) await Promise.all([
      animateAll(el, ".ol-set-pane", { opacity: 0, y: 14 }, EXIT),
      animateAll(el, ".ol-set-navitem", { opacity: 0, x: -10 }, { ...EXIT, delay: stagger(0.03, { from: "last" }) }),
      animate(el, { opacity: 0 }, { ...EXIT, delay: 0.05 }),
    ]);
    setVisible(false); closeStore();
  };

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

  // Until the effect shows it, a restored Settings' bare surface covers the home.
  if (!visible) return restored.current && openStore ? <div data-covering="settings" className="fixed inset-0 z-settings bg-background" /> : null;
  const Active: Sec = SECTIONS.find((s) => s.id === tab)!;

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label="Settings"
      data-covering="settings" className="fixed inset-0 z-settings flex flex-col bg-background text-left">
      {/* header: drag region (frameless window), clear of the traffic lights on
          macOS and the window controls on Windows/Linux. */}
      <header className={cn("relative flex h-14 shrink-0 items-center gap-3",
        isMacDesktop ? "pl-traffic-lights" : "pl-4", isNonMacDesktop ? "pr-window-controls" : "pr-3",
        isDesktop && "[-webkit-app-region:drag]")}>
        <span className="flex min-w-0 items-baseline gap-2 text-title-sm font-semibold">
          Settings
          {appVersion && <span className="text-caption font-normal text-muted-foreground">v{appVersion}</span>}
        </span>
      </header>

      <div className="@container/settings flex min-h-0 flex-1">
        {/* side nav: the way back first, then the sections. Esc and ⌘[ go back too
            (focus trap + history). */}
        <motion.nav layoutScroll aria-label="Settings sections" data-tour="settings-nav"
          className={cn("w-[236px] shrink-0 space-y-1 overflow-y-auto overscroll-contain p-3", rail && "@max-3xl/settings:w-auto @max-3xl/settings:p-2")}>
          <Tooltip label={`Back to ${origin}`} keys="Esc" truncated className="sticky top-0 z-10 mb-2 flex w-full">
            <button type="button" onClick={requestClose} aria-label={`Back to ${origin}`}
              className="flex w-full items-center gap-2 rounded-xl bg-background px-3 py-2 text-left text-body font-medium text-muted-foreground transition hover:bg-foreground/[0.04] hover:text-foreground">
              <ChevronLeft className="size-4 shrink-0" aria-hidden />
              <span data-truncates className={cn("min-w-0 flex-1 truncate", rail)}>Back to {origin}</span>
              <kbd aria-hidden className={cn("shrink-0 rounded-md border border-border px-1.5 font-mono text-micro text-faint", rail && "@max-3xl/settings:hidden")}>esc</kbd>
            </button>
          </Tooltip>
          <Input ref={searchRef} type="search" icon={<Search />} value={query} placeholder="Search settings" aria-label="Search settings"
            data-tour="settings-search"
            onFocus={() => setSearching(true)} onBlur={() => setSearching(false)}
            onChange={(e) => { if (!query && e.target.value) featureUsed("n_settings_search"); setQuery(e.target.value); setActive(0); }} onKeyDown={onSearchKey}
            role="combobox" aria-expanded={!!query.trim()} aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={current ? `${listId}-${results.indexOf(current)}` : undefined}
            autoComplete="off" spellCheck={false}
            className={cn("mb-2", rail && "@max-3xl/settings:[&_input]:w-0 @max-3xl/settings:[&_input]:flex-none")} />
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
          ) : shownSections().map((s: Sec, i, shown: readonly Sec[]) => {
            const on = s.id === tab;
            return (
              <Fragment key={s.id}>
                {/* Keyed off the run, not the first section of it: a run whose first
                    section is desktop-only still gets its heading in a browser. */}
                {s.group && s.group !== shown[i - 1]?.group && (
                  <p className={cn("px-3 pb-1 pt-4", groupLabel, rail && "@max-3xl/settings:px-2 @max-3xl/settings:py-2")}>
                    <span className={cn("block", rail)}>{s.group}</span>
                    {rail && <span aria-hidden className="mx-auto hidden h-px w-6 bg-border @max-3xl/settings:block" />}
                  </p>
                )}
                <Tooltip label={`${s.label} · ${s.sub}`} truncated className="flex w-full">
                  <button onClick={() => setTab(s.id)} aria-current={on ? "page" : undefined}
                    className={cn("ol-set-navitem group relative isolate flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition",
                      !on && "hover:bg-foreground/[0.04]")}>
                    {/* One selection mark that glides to the chosen section. */}
                    {on && <motion.span layoutId={navMark} transition={t.smooth} aria-hidden className="absolute inset-0 -z-10 rounded-xl bg-foreground/[0.07]" />}
                    <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg border transition",
                      on ? "border-transparent bg-accent text-accent-foreground" : "border-border text-muted-foreground group-hover:text-foreground")}>
                      <s.icon className="size-4" />
                    </span>
                    <span data-truncates className={cn("min-w-0", rail)}>
                      <span className={cn("flex flex-wrap items-center gap-x-1.5 text-body font-medium", on ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
                        {s.label}
                      </span>
                      <span className="block truncate text-caption text-faint">{s.sub}</span>
                    </span>
                  </button>
                </Tooltip>
              </Fragment>
            );
          })}
        </motion.nav>

        {/* content — centered readable column */}
        <main className="openlive-scroll ol-set-pane min-h-0 flex-1 overflow-y-auto">
          {/* A narrow reading column that stays fluid: it fills a small window
              and stops growing past a comfortable line length. */}
          <div ref={body} className={cn("mx-auto w-full px-10 pb-12 pt-14 @max-3xl/settings:px-5 @max-3xl/settings:pt-8", Active.wide ? "max-w-[47.5rem]" : "max-w-[35rem]")}>
            <div className="mb-10 flex flex-wrap items-start gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1 basis-56">
                <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-title-lg font-semibold tracking-tight text-foreground">
                  {Active.label}
                  {Active.shared && (
                    <Tooltip label="Used by Chat, Flow and Dictate">
                      <Chip className="bg-accent-soft font-normal text-link-foreground"><Link2 aria-hidden /> Shared</Chip>
                    </Tooltip>
                  )}
                </h1>
                <Tooltip label={Active.desc ?? Active.sub} truncated className="mt-1.5 flex min-w-0 max-w-full">
                  <span className="min-w-0 truncate text-body text-muted-foreground">{Active.desc ?? Active.sub}</span>
                </Tooltip>
              </div>
              {Active.Action && <Active.Action />}
            </div>
            <SettingsNav.Provider value={goTo}>
              <Active.Comp />
            </SettingsNav.Provider>
          </div>
        </main>
      </div>

      <SpotlightTour id="settings" steps={[
        { target: "settings-nav", title: "Set once, used everywhere", body: "Modes keeps what Flow, Dictate and Chat each need for themselves. Intelligence and Voice are set once and every mode uses them." },
        { target: "settings-search", title: "Search any setting", body: `Type what you are after and jump straight to it. ${MOD === "⌘" ? "⌘F" : "Ctrl+F"} gets you here from anywhere in Settings.` },
      ]} />
    </div>
  );
}
