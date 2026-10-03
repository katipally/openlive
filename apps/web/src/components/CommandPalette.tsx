"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { Search, Plus, Keyboard, SunMoon, History, LifeBuoy, Power, Play, Mic, Compass, type LucideIcon } from "lucide-react";
import { MODE_LABEL, useUi, type AppMode } from "@/lib/uiStore";
import { flowBridge } from "@/lib/flow/bridge";
import { keysListen, useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { useLiveStore } from "@/lib/live/liveStore";
import { isTextTarget } from "@/lib/live/keyTargets";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { filterCommands, type Command } from "@/lib/commandPalette";
import { featureUsed } from "@/lib/featureUse";
import { isDesktop, MOD } from "@/lib/platform";
import { reportProblem } from "@/lib/reportProblem";
import { useBrainId } from "@/lib/useBrainId";
import { cn } from "@/lib/cn";
import { useMotionTokens } from "@/lib/motion";
import { shownSections } from "@/components/settings/SettingsPage";
import { MODE_COUNTER, MODES } from "@/components/flow/ModeSwitch";
import { Keycap, groupLabel, sidePanel } from "@/components/ui";

type PaletteCommand = Command & { icon: LucideIcon };

/** Focus Flow's or Dictate's History search once its home has slid in. Held
 *  for a second: the palette's focus trap hands focus back as it closes. */
function focusHistorySearch(mode: "flow" | "dictate") {
  let frames = 0;
  const hold = () => {
    const el = document.querySelector<HTMLInputElement>(`[data-history-search="${mode}"]`);
    if (el && document.activeElement !== el) el.focus();
    if (++frames < 60) requestAnimationFrame(hold);
  };
  requestAnimationFrame(hold);
}

/** A permission or question prompt is up, or a dialog higher on the z ladder
 *  than the palette: that surface owns the keyboard, so ⌘K and ? stay quiet. */
function blocked(): boolean {
  const { permission, elicitation } = useLiveStore.getState();
  if (permission || elicitation) return true;
  const floor = Number(getComputedStyle(document.documentElement).getPropertyValue("--z-palette"));
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
    .some((d) => Number(getComputedStyle(d).zIndex) > floor);
}

// ⌘K / Ctrl+K anywhere in the main window, over chat, the lobby, a call, Flow
// and Settings. Mounted by the main page only, so the Flow windows never get it.
export function CommandPalette({ onNewChat }: { onNewChat: () => void }) {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);

  // The two global keys live here: ⌘K toggles this palette, ? toggles the sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.altKey || blocked()) return;
      const ui = useUi.getState();
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
      } else if (e.key === "?" && !e.metaKey && !e.ctrlKey && !isTextTarget(e.target as HTMLElement | null)) {
        e.preventDefault();
        ui.setShortcutsOpen(!ui.shortcutsOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <AnimatePresence>{open && <Palette key="palette" onNewChat={onNewChat} onClose={() => setOpen(false)} />}</AnimatePresence>;
}

// Mounted per open, so the query and highlight start fresh every time.
function Palette({ onNewChat, onClose }: { onNewChat: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { resolvedTheme, setTheme } = useTheme();
  const mode = useUi((s) => s.mode);
  const liveOpen = useUi((s) => s.liveOpen);
  const inCall = useLiveStore((s) => s.active);
  const brainId = useBrainId();
  // The tray's verbs: Flow and Dictate exist only in the desktop app.
  const { caps } = useFlowCapabilities();
  const { config, save } = useFlowConfig();
  // A new function each render: held so the list is not rebuilt for it.
  const saveFlow = useRef(save);
  saveFlow.current = save;
  const { smooth, snappy, fade, exit: leave } = useMotionTokens();
  const highlightId = useId();
  // Let go of focus as the exit starts, not when it ends: a command that opens
  // something (Settings) takes focus in the same commit.
  const present = useIsPresent();
  useFocusTrap(ref, present, onClose);

  const commands = useMemo<PaletteCommand[]>(() => {
    const ui = useUi.getState();
    // Actions that change what the window shows would land behind Settings.
    const leaveSettings = () => ui.closeSettings();
    const chatShown = mode === "chat" || liveOpen;
    const out: PaletteCommand[] = [];
    // A new conversation remounts the dock, which would drop a live call.
    if (!inCall) out.push({ id: "new", label: "New call", group: "Actions", icon: Plus, keywords: "new chat conversation talk openlive lobby start",
      run: () => { leaveSettings(); onNewChat(); } });
    // The tray's Flow and Dictate items, in the tray's words.
    const flow = flowBridge();
    if (isDesktop && flow && caps && !caps.addonError) {
      if (flow.start && caps.armed && keysListen(caps)) out.push({ id: "flow-start", label: "Start Flow", group: "Actions", icon: Play, keywords: "open flow summon orb ask",
        run: () => flow.start?.() });
      out.push({ id: "flow-power", label: caps.armed ? "Turn Flow off" : "Turn Flow on", group: "Actions", icon: Power, keywords: "flow enable disable switch key",
        run: () => flow.setArmed(!caps.armed) });
    }
    if (isDesktop && config) {
      const on = config.dictate.enabled;
      out.push({ id: "dictate-power", label: on ? "Turn Dictate off" : "Turn Dictate on", group: "Actions", icon: Power, keywords: "dictate dictation voice typing enable disable switch",
        run: () => saveFlow.current({ dictate: { enabled: !on } }) });
      const ptt = config.talk.mode === "ptt";
      out.push({ id: "talk", label: `How you talk: ${ptt ? "Hands-free" : "Push to talk"}`, group: "Actions", icon: Mic, keywords: "hands-free push to talk ptt hold mode listen",
        hint: ptt ? "Now push to talk" : "Now hands-free", run: () => saveFlow.current({ talk: { mode: ptt ? "handsFree" : "ptt" } }) });
    }
    out.push({ id: "shortcuts", label: "Show shortcuts", group: "Actions", icon: Keyboard, keywords: "keyboard keys help", keys: ["?"],
      run: () => ui.setShortcutsOpen(true) });
    out.push({ id: "theme", label: "Toggle theme", group: "Actions", icon: SunMoon, keywords: "dark light appearance",
      hint: resolvedTheme === "dark" ? "Now dark" : "Now light", run: () => setTheme(resolvedTheme === "dark" ? "light" : "dark") });
    // Each mode's History. The switch is hidden while the lobby or a call is up,
    // so only Chat's, whose drawer opens over them, stays.
    for (const m of ["chat", "flow", "dictate"] as const satisfies readonly AppMode[]) {
      if (liveOpen && m !== "chat") continue;
      out.push({ id: `history-${m}`, label: `Open ${MODE_LABEL[m]} history`, group: "Actions", icon: History, keywords: "history past sessions conversations dictations resume search",
        run: () => { leaveSettings(); if (!chatShown || m !== "chat") ui.setMode(m); if (m === "chat") ui.setHistoryOpen(true); else focusHistorySearch(m); } });
    }
    out.push({ id: "tours", label: "Show me around again", group: "Actions", icon: Compass, keywords: "tour welcome setup first run onboarding replay help",
      hint: "Asks first", run: () => ui.openSettingsTab("about", { anchor: "set-about-tours" }) });
    out.push({ id: "report", label: "Report a problem", group: "Actions", icon: LifeBuoy, keywords: "bug issue github feedback broken help",
      hint: "Opens a GitHub issue", run: () => void reportProblem(brainId) });
    for (const s of shownSections()) out.push({ id: `settings-${s.id}`, label: s.label, group: "Settings", icon: s.icon, keywords: s.sub, hint: s.sub,
      run: () => ui.openSettingsTab(s.id) });
    return out;
  }, [mode, liveOpen, inCall, resolvedTheme, setTheme, onNewChat, brainId, caps, config]);

  const groups = useMemo(() => filterCommands(commands, query), [commands, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.items) as PaletteCommand[], [groups]);
  const current = flat[Math.min(active, flat.length - 1)];
  const optionId = (c: Command) => `${listId}-${c.id}`;

  useEffect(() => {
    if (current) document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // Close first: the trap hands focus back before the command opens whatever it opens.
  const run = (c: Command) => { featureUsed("n_palette_run"); onClose(); c.run(); };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const n = flat.length;
    if (e.key === "ArrowDown" && n) { e.preventDefault(); setActive((i) => (Math.min(i, n - 1) + 1) % n); }
    else if (e.key === "ArrowUp" && n) { e.preventDefault(); setActive((i) => (Math.min(i, n - 1) - 1 + n) % n); }
    else if (e.key === "Enter" && current) { e.preventDefault(); run(current); }
  };

  return (
    // Esc is claimed here, ahead of Settings' own document-level trap, so closing
    // the palette over Settings leaves Settings open.
    <motion.div ref={ref} role="dialog" aria-modal="true" aria-label="Command palette"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: leave }} transition={fade}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className={cn("fixed inset-0 z-palette flex items-start justify-center scrim px-4 pt-[min(15dvh,7rem)] pb-4 text-left", !present && "pointer-events-none")}>
      <motion.div initial={{ opacity: 0, scale: 0.96, y: -8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, transition: leave }}
        transition={{ ...smooth, opacity: fade }}
        className={cn(sidePanel(true), "max-h-full w-full max-w-[40rem] origin-top overflow-hidden")}>
        <label className="flex shrink-0 items-center gap-2.5 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input data-autofocus value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onInputKey}
            role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={current ? optionId(current) : undefined} aria-label="Search commands"
            placeholder="Type a command or search…" autoComplete="off" spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-faint" />
          <Keycap className="shrink-0">esc</Keycap>
        </label>

        {groups.length === 0 && <p role="status" className="px-3 py-8 text-center text-body text-muted-strong">Nothing matches.</p>}
        <motion.div layoutScroll id={listId} role="listbox" aria-label="Commands"
          className={cn("openlive-scroll min-h-0 flex-1 overflow-y-auto p-1.5", groups.length === 0 && "hidden")}>
          {groups.map((g) => (
            <div key={g.group} role="group" aria-labelledby={`${listId}-g-${g.group}`} className="pb-1">
              <div id={`${listId}-g-${g.group}`} className={cn("px-3 pb-1 pt-2", groupLabel)}>{g.group}</div>
              {(g.items as PaletteCommand[]).map((c) => {
                const on = c === current;
                return (
                  <div key={c.id} id={optionId(c)} role="option" aria-selected={on}
                    // Move, not enter: a list scrolling under a still pointer must not steal the highlight.
                    onMouseMove={() => { if (!on) setActive(flat.indexOf(c)); }}
                    onMouseDown={(e) => e.preventDefault()} onClick={() => run(c)}
                    className={cn("relative isolate flex cursor-default items-center gap-3 rounded-lg px-3 py-2 text-body",
                      on ? "text-foreground" : "text-muted-strong")}>
                    {on && <motion.span layoutId={highlightId} transition={snappy} aria-hidden className="absolute inset-0 -z-10 rounded-lg bg-accent-soft" />}
                    <c.icon className={cn("size-4 shrink-0", on ? "text-accent" : "text-muted-foreground")} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    {c.hint && <span className="min-w-0 max-w-[45%] shrink truncate text-caption text-faint">{c.hint}</span>}
                    {c.keys && <span className="flex shrink-0 gap-1">{c.keys.map((k, i) => <Keycap key={i}>{k}</Keycap>)}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </motion.div>

        <div aria-hidden className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-caption text-faint">
          <span className="flex items-center gap-1"><Keycap>↑</Keycap><Keycap>↓</Keycap> move</span>
          <span className="flex items-center gap-1"><Keycap>↵</Keycap> run</span>
          <span className="flex items-center gap-1"><Keycap>{MOD}</Keycap><Keycap>K</Keycap> close</span>
        </div>
      </motion.div>
    </motion.div>
  );
}
