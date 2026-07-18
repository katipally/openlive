"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useMenuPresence } from "@/lib/usePopIn";
import { cn } from "@/lib/cn";

// Shared controls for the pre-call setup panel. Two rules keep the panel readable
// instead of a wall of dropdowns:
//   • a handful of choices → Segmented (all options visible, one tap, no menu)
//   • a long list (models)  → Picker, the same clean popover as the hero "Talk to"
// Every control borrows its look from Settings (border/bg-card fields, inverted
// active pill) so the panel and Settings read as one app, not two design systems.

// Segment budget for a 360px panel. Two limits, because a track can bust either
// way: too many segments, or too much text across them. Effort sets the count
// ceiling at six (Default/Low/Medium/High/Xhigh/Max, 28 chars — fits); Claude's
// modes bust the text one (Manual/Accept Edits/Plan/Bypass Permissions, ~40) and
// correctly fall back to a menu rather than a squeezed, unreadable ribbon.
// Measured against the panel's real width — revisit both if the panel resizes.
export const SEG_MAX = 6;
export const SEG_CHARS_MAX = 34;

/** The steer on every reasoning/effort control. This is a SPOKEN call: thinking
 *  tokens are dead air before the first word, so the lowest setting the model
 *  supports is the right default and deeper effort is the exception. */
export const THINK_HINT = "Lower answers faster";

/** The same steer, spelled out, under a reasoning control. Guidance only — we never
 *  silently override what the agent reports as its own current level. */
export function ThinkNote() {
  return (
    <p className="pt-1.5 text-caption leading-relaxed text-muted-foreground">
      You&apos;re on a call — every thinking token is silence before the first word. Keep this as low as the work allows.
    </p>
  );
}

export interface Opt {
  id: string;
  name: string;
  icon?: ReactNode;
  /** Secondary line in the menu (e.g. a model's context/pricing). */
  detail?: string;
  /** Marks the recommended choice (✦) — used for "Auto" effort. */
  starred?: boolean;
}

/** A titled group of fields — same heading style as a Settings section
 *  (settings/Section.tsx), so the panel and Settings read as one app. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-callout font-semibold text-foreground">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** One labelled row. `hint` is right-aligned guidance, not an error. */
export function Field({ label, hint, required, children }: {
  label: string; hint?: ReactNode; required?: boolean; children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-label font-medium text-foreground/90">
          {label}{required && <span className="text-danger"> *</span>}
        </span>
        {hint && <span className="shrink-0 text-micro leading-tight text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** Clean dropdown: brand mark + name + optional detail, checkmark on the current
 *  one. Same shape as the hero picker so the panel and the hero feel like one app. */
export function Picker({ value, options, onChange, disabled, placeholder, ariaLabel }: {
  value: string | null;
  options: Opt[];
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Shown when nothing is selected yet (or while the list is still loading). */
  placeholder?: string;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { open, mounted, requestClose: closeMenu, toggle } = useMenuPresence(menuRef);
  const requestClose = (refocus = false) => {
    closeMenu();
    if (refocus) ref.current?.querySelector("button")?.focus();
  };

  // Close on outside click OR Escape — a menu you can only dismiss by picking
  // something is a trap, especially when it covers the Start button. Arrow keys
  // walk the options (listbox convention); focus lands on the selection on open.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) requestClose(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { requestClose(true); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const opts = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
      if (!opts.length) return;
      e.preventDefault();
      const i = opts.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "Home" ? 0
        : e.key === "End" ? opts.length - 1
        : e.key === "ArrowDown" ? (i >= opts.length - 1 ? 0 : i + 1)
        : (i <= 0 ? opts.length - 1 : i - 1);
      opts[next]?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    // Focus the current selection so arrows continue from it.
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("[aria-selected=true]")?.focus());
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A disabled control that's still open would float a dead menu (e.g. the agent
  // disconnects mid-pick).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (disabled && open) requestClose(); }, [disabled]);

  const current = options.find((o) => o.id === value) ?? null;

  return (
    <div ref={ref} className="relative">
      <button type="button" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        onClick={toggle}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-lg border bg-card px-3 text-left shadow-[var(--shadow-xs)] transition",
          open ? "border-border-heavy" : "border-border",
          disabled ? "cursor-not-allowed opacity-55" : "hover:border-border-heavy",
        )}>
        {current?.icon && <span className="grid size-4 shrink-0 place-items-center">{current.icon}</span>}
        <span className={cn("min-w-0 flex-1 truncate text-label", current ? "text-foreground" : "text-muted-foreground")}>
          {current?.name ?? placeholder ?? "Select…"}
        </span>
        {current?.starred && <span className="shrink-0 text-caption text-accent">✦</span>}
        {!disabled && <ChevronDown className={cn("size-3.5 shrink-0 transition", open ? "rotate-180 text-foreground" : "text-muted-foreground")} />}
      </button>

      {mounted && (
        <div ref={menuRef} role="listbox" aria-label={ariaLabel}
          className="openlive-scroll absolute left-0 right-0 z-50 mt-1.5 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-[var(--shadow-pop)]">
          {options.length === 0 && <p className="px-2.5 py-2 text-label text-faint">Nothing to choose yet.</p>}
          {options.map((o) => (
            <button key={o.id} type="button" role="option" aria-selected={o.id === value}
              onClick={() => { onChange(o.id); requestClose(); }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-foreground/[0.06]">
              {o.icon && <span className="grid size-4 shrink-0 place-items-center">{o.icon}</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label text-foreground">{o.name}{o.starred && <span className="text-accent"> ✦</span>}</span>
                {o.detail && <span className="block truncate text-micro text-faint">{o.detail}</span>}
              </span>
              {o.id === value && <Check className="size-3.5 shrink-0 text-success" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Segmented control — the same bordered pill group Settings uses for providers
 *  and effort (ModelsSettings): `border p-1` track, active pill inverted to
 *  foreground-on-background. One vocabulary, no sliding thumb to maintain. */
export function Segmented({ value, options, onChange, ariaLabel, disabled }: {
  value: string | null; options: Opt[]; onChange: (id: string) => void; ariaLabel: string; disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel}
      className={cn("openlive-scroll flex w-full gap-0.5 overflow-x-auto rounded-lg border border-border bg-card p-1",
        disabled && "cursor-not-allowed opacity-55")}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button key={o.id} type="button" role="radio" aria-checked={on} disabled={disabled}
            onClick={() => onChange(o.id)} title={o.detail}
            // grow/basis-auto, NOT flex-1: equal-width segments size to the longest
            // label, so a six-level scale truncated "Medium" to "Medi…" in a 360px
            // panel. Growing from content width instead lets each segment take only
            // the room its own word needs.
            className={cn(
              "flex min-w-0 grow basis-auto items-center justify-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-label font-medium transition",
              on ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
            )}>
            {o.icon && <span className="grid size-3.5 shrink-0 place-items-center">{o.icon}</span>}
            <span className="truncate">{o.name}</span>
            {o.starred && <span className={cn("shrink-0 text-micro", on ? "text-background/70" : "text-accent")}>✦</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The panel's one layout rule: a few short choices lay out flat as a segmented
 *  track; anything longer (or carrying a detail line, which a segment can't show)
 *  needs a menu. Budget the TOTAL text, not each label — the track is one strip, so
 *  two long-ish names can fit where five short ones already don't. */
export function AutoControl(props: {
  value: string | null; options: Opt[]; onChange: (id: string) => void;
  ariaLabel: string; disabled?: boolean; placeholder?: string;
}) {
  const chars = props.options.reduce((n, o) => n + o.name.length, 0);
  const flat = props.options.length <= SEG_MAX && chars <= SEG_CHARS_MAX && !props.options.some((o) => o.detail);
  return flat ? <Segmented {...props} /> : <Picker {...props} />;
}

