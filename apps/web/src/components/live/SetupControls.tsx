"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Check } from "lucide-react";
import { usePopIn } from "@/lib/usePopIn";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { cn } from "@/lib/cn";

// Shared controls for the pre-call setup panel. Two rules keep the panel readable
// instead of a wall of dropdowns:
//   • a handful of choices → Chips (all options visible, one tap, no menu)
//   • a long list (models)  → Picker, the same clean popover as the hero "Talk to"
// Native <select> is deliberately gone: it can't show a brand mark or a per-option
// detail line, and it renders as an OS widget that breaks the app's look.

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
    <p className="pt-1.5 text-micro leading-relaxed text-faint">
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

// Three levels of type, and only three — the panel was unreadable when a section
// heading, a field name and a hint were all the same 11px uppercase grey, so
// nothing told you where one group ended and the next began:
//   Section  10px UPPERCASE, tracked, faint     — the quietest thing; a signpost
//   Field    12px sentence case, near-full white — the loudest label; what you read
//   Hint     10.5px faint, right-aligned         — guidance, never competes
// Contrast is inverted from the obvious instinct on purpose: the *group* label is
// the one that should recede, because it's repeated furniture, while the field name
// is the thing you actually scan for.

/** A titled group of fields. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-micro font-semibold uppercase tracking-[0.09em] text-faint">{title}</h3>
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
        {hint && <span className="shrink-0 text-micro leading-tight text-faint">{hint}</span>}
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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  usePopIn(menuRef, open);

  // Close on outside click OR Escape — a menu you can only dismiss by picking
  // something is a trap, especially when it covers the Start button.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); ref.current?.querySelector("button")?.focus(); } };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // A disabled control that's still open would float a dead menu (e.g. the agent
  // disconnects mid-pick).
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const current = options.find((o) => o.id === value) ?? null;

  return (
    <div ref={ref} className="relative">
      <button type="button" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-lg bg-card px-3 text-left shadow-[var(--shadow-xs)] transition",
          disabled ? "cursor-not-allowed opacity-55" : "hover:shadow-[var(--shadow-card)]",
        )}>
        {current?.icon && <span className="grid size-4 shrink-0 place-items-center">{current.icon}</span>}
        <span className={cn("min-w-0 flex-1 truncate text-label", current ? "text-foreground" : "text-muted-foreground")}>
          {current?.name ?? placeholder ?? "Select…"}
        </span>
        {current?.starred && <span className="shrink-0 text-caption text-accent">✦</span>}
        {!disabled && <ChevronDown className={cn("size-3.5 shrink-0 text-faint transition", open && "rotate-180")} />}
      </button>

      {open && (
        <div ref={menuRef} role="listbox" aria-label={ariaLabel}
          className="openlive-scroll absolute left-0 right-0 z-50 mt-1.5 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-[var(--shadow-pop)]">
          {options.length === 0 && <p className="px-2.5 py-2 text-label text-faint">Nothing to choose yet.</p>}
          {options.map((o) => (
            <button key={o.id} type="button" role="option" aria-selected={o.id === value}
              onClick={() => { onChange(o.id); setOpen(false); }}
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

/** Segmented control — every choice visible in one track, with a thumb that slides
 *  to the selection. Right for a short, ORDERED scale (effort levels, on/off): the
 *  track itself shows the range, so you can see where you sit on it without opening
 *  anything. The thumb is one element that moves, not a background that flips, which
 *  is what makes the change read as a position rather than a repaint. */
export function Segmented({ value, options, onChange, ariaLabel, disabled }: {
  value: string | null; options: Opt[]; onChange: (id: string) => void; ariaLabel: string; disabled?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const idx = options.findIndex((o) => o.id === value);
  const placed = useRef(false); // first placement jumps; later ones animate

  useGSAP(() => {
    const el = track.current?.querySelectorAll<HTMLElement>("[data-seg]")[idx];
    if (!thumb.current) return;
    // No selection (or a value the agent no longer offers) — hide rather than park
    // the thumb on an unrelated segment.
    if (!el || idx < 0) { gsap.set(thumb.current, { autoAlpha: 0 }); placed.current = false; return; }
    const to = { x: el.offsetLeft, width: el.offsetWidth, autoAlpha: 1 };
    if (!placed.current || prefersReduced()) { gsap.set(thumb.current, to); placed.current = true; return; }
    gsap.to(thumb.current, { ...to, duration: DUR.fast, ease: EASE.snappy });
  }, { dependencies: [idx, options.length] });

  // Web fonts land after first paint and resize every segment — re-measure, or the
  // thumb sits a few px off the label it's supposed to be under.
  useEffect(() => {
    const el = track.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const seg = el.querySelectorAll<HTMLElement>("[data-seg]")[idx];
      if (seg && thumb.current && idx >= 0) gsap.set(thumb.current, { x: seg.offsetLeft, width: seg.offsetWidth });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [idx]);

  return (
    <div ref={track} role="radiogroup" aria-label={ariaLabel}
      className={cn("openlive-scroll relative flex w-full gap-0 overflow-x-auto rounded-lg bg-card p-0.5 shadow-[var(--shadow-xs)]",
        disabled && "cursor-not-allowed opacity-55")}>
      <div ref={thumb} aria-hidden className="pointer-events-none absolute inset-y-0.5 left-0 rounded-[7px] bg-foreground opacity-0" />
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button key={o.id} data-seg type="button" role="radio" aria-checked={on} disabled={disabled}
            onClick={() => onChange(o.id)} title={o.detail}
            // grow/basis-auto, NOT flex-1: equal-width segments size to the longest
            // label, so a six-level scale truncated "Medium" to "Medi…" in a 360px
            // panel. Growing from content width instead lets each segment take only
            // the room its own word needs.
            className={cn(
              "relative z-10 flex min-w-0 grow basis-auto items-center justify-center gap-1 whitespace-nowrap rounded-[7px] px-1.5 py-1.5 text-caption font-medium transition-colors duration-150",
              on ? "text-background" : "text-muted-foreground hover:text-foreground",
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

/** Read-only facts about the current selection (vision / context / …). Not
 *  choices — never make them look tappable. */
export function FactChips({ items }: { items: { label: string; tone?: "muted" | "warn" }[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((f) => (
        <span key={f.label}
          className={cn("rounded-md px-1.5 py-0.5 text-micro font-medium",
            f.tone === "warn" ? "bg-arc/10 text-arc" : "bg-foreground/[0.06] text-muted-foreground")}>
          {f.label}
        </span>
      ))}
    </div>
  );
}
