"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Search, Plus, MessageSquare, Waves, Keyboard, SunMoon, History, type LucideIcon } from "lucide-react";
import { useUi } from "@/lib/uiStore";
import { useLiveStore } from "@/lib/live/liveStore";
import { isTextTarget } from "@/lib/live/keyTargets";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { filterCommands, type Command } from "@/lib/commandPalette";
import { MOD } from "@/lib/platform";
import { cn } from "@/lib/cn";
import { SECTIONS } from "@/components/settings/SettingsPage";
import { Keycap } from "./Keycap";

type PaletteCommand = Command & { icon: LucideIcon };

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

  return open ? <Palette onNewChat={onNewChat} onClose={() => setOpen(false)} /> : null;
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
  useFocusTrap(ref, true, onClose);

  const commands = useMemo<PaletteCommand[]>(() => {
    const ui = useUi.getState();
    // Actions that change what the window shows would land behind Settings.
    const leaveSettings = () => ui.closeSettings();
    const flowShown = mode === "flow" && !liveOpen;
    const out: PaletteCommand[] = [];
    // A new conversation remounts the dock, which would drop a live call.
    if (!inCall) out.push({ id: "new", label: "New chat", group: "Actions", icon: Plus, keywords: "conversation call talk openlive lobby start",
      run: () => { leaveSettings(); onNewChat(); } });
    // The switch is hidden while the lobby or a call is up; so is this.
    if (!liveOpen) out.push(mode === "flow"
      ? { id: "mode", label: "Switch to Chat", group: "Actions", icon: MessageSquare, keywords: "mode", run: () => { leaveSettings(); ui.setMode("chat"); } }
      : { id: "mode", label: "Switch to Flow", group: "Actions", icon: Waves, keywords: "mode", run: () => { leaveSettings(); ui.setMode("flow"); } });
    out.push({ id: "shortcuts", label: "Show shortcuts", group: "Actions", icon: Keyboard, keywords: "keyboard keys help", keys: ["?"],
      run: () => ui.setShortcutsOpen(true) });
    out.push({ id: "theme", label: "Toggle theme", group: "Actions", icon: SunMoon, keywords: "dark light appearance",
      hint: resolvedTheme === "dark" ? "Now dark" : "Now light", run: () => setTheme(resolvedTheme === "dark" ? "light" : "dark") });
    // The History drawer lives in the Chat view.
    if (!flowShown) out.push({ id: "history", label: "Open history", group: "Actions", icon: History, keywords: "sessions resume past conversations",
      run: () => { leaveSettings(); ui.setHistoryOpen(true); } });
    for (const s of SECTIONS) out.push({ id: `settings-${s.id}`, label: s.label, group: "Settings", icon: s.icon, keywords: s.sub, hint: s.sub,
      run: () => ui.openSettingsTab(s.id) });
    return out;
  }, [mode, liveOpen, inCall, resolvedTheme, setTheme, onNewChat]);

  const groups = useMemo(() => filterCommands(commands, query), [commands, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.items) as PaletteCommand[], [groups]);
  const current = flat[Math.min(active, flat.length - 1)];
  const optionId = (c: Command) => `${listId}-${c.id}`;

  useEffect(() => {
    if (current) document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // Close first: the trap hands focus back before the command opens whatever it opens.
  const run = (c: Command) => { onClose(); c.run(); };

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
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Command palette"
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className="animate-fade-in fixed inset-0 z-[var(--z-palette)] flex items-start justify-center bg-black/30 px-4 pt-[min(15dvh,7rem)] pb-4 text-left">
      <div className="animate-modal-in flex max-h-full w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-[var(--shadow-pop)]">
        <label className="flex shrink-0 items-center gap-2.5 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onInputKey}
            role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={current ? optionId(current) : undefined} aria-label="Search commands"
            placeholder="Type a command or search…" autoComplete="off" spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-faint" />
          <Keycap className="shrink-0">esc</Keycap>
        </label>

        {groups.length === 0 && <p role="status" className="px-3 py-8 text-center text-body text-muted-foreground">Nothing matches.</p>}
        <div id={listId} role="listbox" aria-label="Commands"
          className={cn("openlive-scroll min-h-0 flex-1 overflow-y-auto p-1.5", groups.length === 0 && "hidden")}>
          {groups.map((g) => (
            <div key={g.group} role="group" aria-labelledby={`${listId}-g-${g.group}`} className="pb-1">
              <div id={`${listId}-g-${g.group}`} className="px-3 pb-1 pt-2 text-caption font-medium uppercase tracking-wide text-faint">{g.group}</div>
              {(g.items as PaletteCommand[]).map((c) => {
                const on = c === current;
                return (
                  <div key={c.id} id={optionId(c)} role="option" aria-selected={on}
                    // Move, not enter: a list scrolling under a still pointer must not steal the highlight.
                    onMouseMove={() => { if (!on) setActive(flat.indexOf(c)); }}
                    onMouseDown={(e) => e.preventDefault()} onClick={() => run(c)}
                    className={cn("flex cursor-default items-center gap-3 rounded-lg px-3 py-2 text-body",
                      on ? "bg-accent-soft text-foreground" : "text-muted-strong")}>
                    <c.icon className={cn("size-4 shrink-0", on ? "text-accent" : "text-muted-foreground")} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    {c.hint && <span className="min-w-0 max-w-[45%] shrink truncate text-caption text-faint">{c.hint}</span>}
                    {c.keys && <span className="flex shrink-0 gap-1">{c.keys.map((k, i) => <Keycap key={i}>{k}</Keycap>)}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div aria-hidden className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-caption text-faint">
          <span className="flex items-center gap-1"><Keycap>↑</Keycap><Keycap>↓</Keycap> move</span>
          <span className="flex items-center gap-1"><Keycap>↵</Keycap> run</span>
          <span className="flex items-center gap-1"><Keycap>{MOD}</Keycap><Keycap>K</Keycap> close</span>
        </div>
      </div>
    </div>
  );
}
