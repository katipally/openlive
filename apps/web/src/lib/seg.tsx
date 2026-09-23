import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useMotionTokens } from "@/lib/motion";

// The app's one segmented control. Equal columns and a thumb exactly one column
// wide, so the selection slides rather than blinking and the arithmetic holds
// for any number of options with any label lengths. Nothing here is sized in
// pixels: the control is as wide as its widest label and as tall as its text.
//
// The thumb moves in percent of its own width, so a resize mid-slide still lands
// on the right column without measuring anything. A value no option matches (a
// hand-tuned "custom" state) hides the thumb rather than claiming the first one.
//
// Always no-drag: on the desktop these sit inside frameless title bars, and a
// button in a drag region is a button that swallows its own clicks.

export interface SegOption<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
  /** A second line under the label; stacks the option (icon above, sub below). */
  sub?: string;
  title?: string;
}

const TONE = {
  solid: { thumb: "bg-foreground", on: "text-background" },
  soft: { thumb: "bg-foreground/10", on: "text-foreground" },
};

export function Segmented<T extends string>({ options, value, onChange, label, className, tone = "solid", size = "md", anchor }: {
  options: readonly SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
  tone?: keyof typeof TONE;
  size?: "sm" | "md";
  /** Gives each option `id="<anchor>-<id>"` and marks it for Settings search to click. */
  anchor?: string;
}) {
  const index = options.findIndex((o) => o.id === value);
  const { spring } = useMotionTokens();
  const t = TONE[tone];
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (Math.max(0, index) + step + options.length) % options.length;
    onChange(options[next]!.id);
    (e.currentTarget.querySelectorAll("button")[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div role="group" aria-label={label} onKeyDown={onKey}
      className={cn("relative inline-grid auto-cols-fr grid-flow-col bg-card p-[var(--pad)] shadow-[var(--shadow-card)] [-webkit-app-region:no-drag]",
        size === "sm" ? "rounded-lg [--pad:0.125rem]" : "rounded-xl [--pad:0.25rem]", className)}>
      <motion.span aria-hidden className={cn("absolute inset-y-[var(--pad)] left-[var(--pad)]", size === "sm" ? "rounded-md" : "rounded-lg", t.thumb, index < 0 && "opacity-0")}
        style={{ width: `calc((100% - 2 * var(--pad)) / ${options.length})` }}
        initial={false} animate={{ x: `${Math.max(0, index) * 100}%` }}
        transition={spring} />
      {options.map((o) => {
        const on = value === o.id;
        return (
          <button key={o.id} type="button" onClick={() => onChange(o.id)} aria-pressed={on} title={o.title}
            id={anchor && `${anchor}-${o.id}`} data-reveal={anchor ? "" : undefined}
            className={cn("relative flex min-w-0 items-center justify-center gap-1.5 font-medium transition-[color,transform] active:scale-[0.96] motion-reduce:active:scale-100",
              o.sub ? "flex-col gap-1 px-2 py-2.5 text-center" : "whitespace-nowrap",
              size === "sm" ? "min-h-6 rounded-md px-2.5 text-caption" : cn("min-h-9 rounded-lg text-label", !o.sub && "px-4"),
              on ? t.on : "text-muted-foreground hover:text-foreground")}>
            {o.icon && <o.icon aria-hidden className={o.sub ? "size-4" : "size-3.5"} />}
            <span className={cn(o.sub && "leading-tight")}>{o.label}</span>
            {o.sub && <span className="text-micro font-normal leading-tight text-faint">{o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}
