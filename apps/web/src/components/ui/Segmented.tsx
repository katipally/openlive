import { isValidElement, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { Info, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./Tooltip";
import { useMotionTokens } from "@/lib/motion";

// The app's one segmented control, in one look: a recessed track, so it reads on
// a card and on the window alike, and a soft raised thumb that slides to the
// chosen option.
//
// Columns are equal where they fit and never narrower than their own label
// (minmax(max-content, 1fr)): a settings row gets even segments, a narrow panel
// with a long label gets a wider segment instead of a truncated word, and if
// even that cannot fit the track scrolls, or with `wrap` flows onto a second
// line. Nothing is sized in pixels.
//
// The thumb is one element of the track, moved to the chosen option's box as
// measured inside the track: immune to any scrolling around it (a shared-layout
// thumb measured against the viewport glided from the wrong place in a
// scrolled page). It is re-measured when the track resizes. A value no option
// matches (a hand-tuned "custom" state, or nothing chosen yet) shows no thumb
// rather than claiming the first one.
//
// Always no-drag: on the desktop these sit inside frameless title bars, and a
// button in a drag region is a button that swallows its own clicks.

type Box = { x: number; y: number; width: number; height: number };

export interface SegOption<T extends string> {
  id: T;
  label: string;
  /** A lucide icon, or any node (an agent's brand mark). */
  icon?: LucideIcon | ReactNode;
  /** A second line under the label; stacks the option (icon above, sub below). */
  sub?: string;
  title?: string;
  /** Marks the recommended choice with a ✦. */
  starred?: boolean;
  /** Why this option can't be picked right now: greys it out and says so on hover. */
  unavailable?: string;
}

// A lucide icon is a component (a forwardRef object); anything else is a node to render as is.
const isComponent = (icon: SegOption<string>["icon"]): icon is LucideIcon =>
  typeof icon === "function" || (typeof icon === "object" && icon !== null && !isValidElement(icon) && "render" in icon);

export function Segmented<T extends string>({ options, value, onChange, label, className, size = "md", anchor, disabled, wrap }: {
  options: readonly SegOption<T>[];
  value: T | null;
  onChange: (v: T) => void;
  label: string;
  className?: string;
  size?: "sm" | "md";
  /** Gives each option `id="<anchor>-<id>"` and marks it for Settings search to click. */
  anchor?: string;
  disabled?: boolean;
  /** Too many options for the width wrap onto more lines instead of scrolling. */
  wrap?: boolean;
}) {
  const index = options.findIndex((o) => o.id === value);
  const { smooth } = useMotionTokens();
  const track = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<Box | null>(null);
  // Before paint, so the thumb is never seen on the old option. Options are often
  // an inline array, so only a moved box sets state. O(1) per track resize.
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => {
      // Offsets, not client rects: the pressed option is mid scale-down, and a
      // rect would size the thumb to it.
      const b = el.querySelectorAll<HTMLElement>("[role=radio]")[index];
      const next = b ? { x: b.offsetLeft, y: b.offsetTop, width: b.offsetWidth, height: b.offsetHeight } : null;
      setThumb((prev) => (prev && next && prev.x === next.x && prev.y === next.y && prev.width === next.width && prev.height === next.height) || prev === next ? prev : next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [index, options.length]);
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step || disabled) return;
    e.preventDefault();
    let next = Math.max(0, index);
    for (let n = 0; n < options.length; n++) {
      next = (next + step + options.length) % options.length;
      if (!options[next]!.unavailable) break;
    }
    if (options[next]!.unavailable) return;
    onChange(options[next]!.id);
    (e.currentTarget.querySelectorAll("button")[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div ref={track} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} onKeyDown={onKey}
      className={cn("relative isolate max-w-full rounded-md bg-track p-[3px] shadow-track [-webkit-app-region:no-drag]",
        wrap ? "flex flex-wrap" : "openlive-scroll inline-grid auto-cols-[minmax(max-content,1fr)] grid-flow-col overflow-x-auto",
        disabled && "cursor-not-allowed opacity-55", className)}>
      {thumb && <motion.span aria-hidden initial={false} animate={thumb} transition={smooth}
        className="pointer-events-none absolute left-0 top-0 -z-10 rounded-sm bg-thumb shadow-thumb" />}
      {options.map((o, i) => {
        const on = value === o.id;
        const off = !!o.unavailable;
        const tip = o.unavailable ?? o.title;
        const button = (
          <button key={o.id} type="button" role="radio" aria-checked={on} disabled={disabled} aria-disabled={off || undefined}
            onClick={() => { if (!off) onChange(o.id); }}
            tabIndex={i === Math.max(0, index) ? 0 : -1}
            id={anchor && `${anchor}-${o.id}`} data-reveal={anchor ? "" : undefined}
            className={cn("relative isolate flex min-w-0 items-center justify-center gap-1.5 rounded-sm font-medium transition-[color,transform] focus-visible:outline-offset-[-2px] motion-reduce:active:scale-100",
              wrap && "flex-auto", tip && "flex-1",
              off ? "cursor-not-allowed opacity-45" : "enabled:active:scale-[0.96]",
              o.sub ? "flex-col gap-1 px-2 py-2 text-center" : "whitespace-nowrap",
              size === "sm" ? "min-h-[1.375rem] px-2.5 text-label" : cn("min-h-7 text-body", !o.sub && "px-3"),
              on ? "text-foreground" : cn("text-muted-foreground", !off && "enabled:hover:text-foreground"))}>
            {isComponent(o.icon)
              ? <o.icon aria-hidden className={o.sub ? "size-4" : "size-3.5"} />
              : o.icon && <span className="grid size-3.5 shrink-0 place-items-center">{o.icon}</span>}
            <span className={cn(o.sub && "leading-tight")}>{o.label}</span>
            {o.starred && <span aria-hidden className="shrink-0 text-micro text-accent">✦</span>}
            {o.sub && <span className="text-micro font-normal leading-tight text-faint">{o.sub}</span>}
            {off && <><Info aria-hidden className="size-3 shrink-0" /><span className="sr-only">{`. ${o.unavailable}`}</span></>}
          </button>
        );
        return tip ? <Tooltip key={o.id} label={tip} className={cn("flex", wrap && "flex-auto")}>{button}</Tooltip> : button;
      })}
    </div>
  );
}
