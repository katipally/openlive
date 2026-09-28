"use client";

import { useEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { cn } from "@/lib/cn";

// The app's one slider: a label, the value as words, and a native range drawn
// by .ol-range (globals.css), so arrows, Page keys and screen readers work as
// the platform does.
//
// commitOnRelease: moves locally and saves once, when the thumb is let go or a
// key has moved it, for values whose write is slow. A write per tick lagged
// behind the thumb, and each reply snapped it back. The draft is held until the
// write settles (`saving` false), so the thumb never jumps back to the old value
// while the new one is on its way; a refused write lands on what was stored.
export function Slider({ label, value, min, max, step, format, onChange, commitOnRelease = false, saving = false, className }: {
  label: string; value: number; min: number; max: number; step: number;
  format: (v: number) => string; onChange: (v: number) => void;
  commitOnRelease?: boolean; saving?: boolean; className?: string;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  useEffect(() => { if (!saving) setDraft(null); }, [value, saving]);
  // The native `change` is the release (or one key press); React's onChange is every tick.
  useEffect(() => {
    const el = input.current;
    if (!el || !commitOnRelease) return;
    const commit = () => {
      const v = Number(el.value);
      if (v === latest.current.value) setDraft(null);
      else latest.current.onChange(v);
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, [commitOnRelease]);
  const shown = draft ?? value;
  const p = max > min ? Math.min(1, Math.max(0, (shown - min) / (max - min))) : 0;
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="flex items-baseline justify-between gap-3 text-label text-foreground">
        <span className="min-w-0 break-words">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{format(shown)}</span>
      </span>
      <input ref={input} type="range" min={min} max={max} step={step} value={shown}
        onChange={(e) => (commitOnRelease ? setDraft(Number(e.target.value)) : onChange(Number(e.target.value)))}
        style={{ "--p": p } as CSSProperties} className="ol-range w-full" />
    </label>
  );
}

/** The bare track and thumb, for a range that is not a labelled setting: a
 *  seek bar. Label it with aria-label. `small` draws the lighter thumb. */
export function Range({ value, min = 0, max, small, className, style, ...input }: Omit<ComponentProps<"input">, "type" | "value" | "min" | "max"> & {
  value: number; min?: number; max: number; small?: boolean;
}) {
  const p = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  return (
    <input type="range" min={min} max={max} value={Math.min(max, Math.max(min, value))} {...input}
      style={{ "--p": p, ...(small && { "--thumb-size": "0.75rem" }), ...style } as CSSProperties} className={cn("ol-range", className)} />
  );
}
