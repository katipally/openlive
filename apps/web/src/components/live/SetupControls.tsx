"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { Segmented, menuItem, menuPanel, MenuCheck, useMenu, Disclosure, Switch, Tooltip, fieldTrigger } from "@/components/ui";

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

/** One name per effort level, wherever effort is offered: live voice, the quick
 *  pick and Flow's brain. "auto" is whatever the lowest level the model supports
 *  is, which is why it reads as "Lowest" rather than as a setting of its own. */
const EFFORT_NAMES: Record<string, string> = {
  auto: "Lowest", low: "Low", medium: "Medium", high: "High", xhigh: "Very high", max: "Maximum",
};
export const effortName = (effort: string): string =>
  EFFORT_NAMES[effort] ?? (effort ? effort[0]!.toUpperCase() + effort.slice(1) : "");

/** The same steer, spelled out, under a reasoning control. Guidance only — we never
 *  silently override what the agent reports as its own current level. */
export function ThinkNote() {
  return (
    <p className="pt-1.5 text-caption leading-relaxed text-muted-foreground">
      You&apos;re on a call, so every thinking token is silence before the first word. Keep this as low as the work allows.
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

/** A titled group: a small label over its control or controls. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label font-medium text-muted-strong">{title}</h3>
      {children}
    </section>
  );
}

/** One labelled row. `hint` is right-aligned guidance, not an error. */
export function Field({ label, hint, required, children }: {
  label: string; hint?: ReactNode; required?: boolean; children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className="text-label font-medium text-muted-strong">
          {label}{required && <span className="text-danger"> *</span>}
        </span>
        {hint && <span className="text-caption leading-tight text-faint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** "How it runs": one line saying what the call runs on, which opens in place
 *  to the controls behind it. Closed by default, so the panel stays quiet. */
export function HowItRuns({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Section title="How it runs">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
        className="flex min-h-control-lg w-full min-w-0 items-center gap-2.5 rounded-lg border border-border bg-secondary px-3 py-2 text-left text-body text-foreground shadow-rim transition hover:border-border-heavy">
        <Tooltip label={summary || "Choose the model and mode"} truncated className="min-w-0 flex-1">
          <span className={cn("truncate", !summary && "text-muted-foreground")}>{summary || "Choose the model and mode"}</span>
        </Tooltip>
        <ChevronRight aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-base motion-reduce:transition-none", open && "rotate-90")} />
      </button>
      <Disclosure open={open}>
        <div id={id} className="flex flex-col gap-5 px-0.5 pb-1 pt-4">{children}</div>
      </Disclosure>
    </Section>
  );
}

/** An agent option that is really on/off, as a switch rather than two segments. */
export function SwitchField({ label, on, onFlip }: { label: string; on: boolean; onFlip: () => void }) {
  return (
    <label className="flex min-h-control-lg cursor-pointer select-none items-center gap-3">
      <span className="min-w-0 flex-1 break-words text-body text-foreground">{label}</span>
      <Switch on={on} onFlip={onFlip} />
    </label>
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
  const { open, mounted, requestClose, toggle } = useMenu(ref, menuRef);

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
          fieldTrigger, "flex w-full items-center gap-2 text-left",
          open && "border-border-heavy",
          disabled ? "cursor-not-allowed opacity-55" : "hover:border-border-heavy",
        )}>
        {current?.icon && <span className="grid size-4 shrink-0 place-items-center">{current.icon}</span>}
        <span className={cn("min-w-0 flex-1 truncate text-body", current ? "text-foreground" : "text-muted-foreground")}>
          {current?.name ?? placeholder ?? "Select…"}
        </span>
        {current?.starred && <span className="shrink-0 text-caption text-accent">✦</span>}
        {!disabled && <ChevronDown className={cn("size-3.5 shrink-0 transition", open ? "rotate-180 text-foreground" : "text-muted-foreground")} />}
      </button>

      {mounted && (
        <div ref={menuRef} role="listbox" aria-label={ariaLabel}
          className={cn("openlive-scroll absolute left-0 right-0 z-overlay mt-1.5 max-h-64 overflow-y-auto", menuPanel)}>
          {options.length === 0 && <p className="px-2.5 py-2 text-label text-faint">Nothing to choose yet.</p>}
          {options.map((o) => (
            <button key={o.id} type="button" role="option" aria-selected={o.id === value}
              onClick={() => { onChange(o.id); requestClose(); }}
              className={menuItem}>
              {o.icon && <span className="grid size-4 shrink-0 place-items-center">{o.icon}</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label text-foreground">{o.name}{o.starred && <span className="text-accent"> ✦</span>}</span>
                {o.detail && <span className="block truncate text-micro text-faint">{o.detail}</span>}
              </span>
              {o.id === value && <MenuCheck />}
            </button>
          ))}
        </div>
      )}
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
  return flat
    ? <Segmented wrap size="sm" label={props.ariaLabel} value={props.value} onChange={props.onChange} disabled={props.disabled} className="w-full"
        options={props.options.map((o) => ({ id: o.id, label: o.name, icon: o.icon, starred: o.starred }))} />
    : <Picker {...props} />;
}

