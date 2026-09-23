"use client";

import { useEffect, useId, useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, ChevronDown, Search } from "lucide-react";
import { useMenuPresence } from "@/lib/usePopIn";
import { cn } from "@/lib/cn";
import { useMotionTokens } from "@/lib/motion";

export interface SearchOption {
  value: string;
  label: string;
  hint?: string;   // small trailing note (e.g. "vision · reasoning")
}

// A searchable dropdown (type to filter) — replaces a native <select> when the
// list is long. Keyboard: ↑/↓ to move, Enter to pick, Esc to close.
export function SearchSelect({
  value, onChange, options, placeholder = "Select…", disabled, emptyText = "No matches", searchPlaceholder = "Search models…",
}: {
  value: string;
  onChange: (value: string) => void;
  options: SearchOption[];
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
  searchPlaceholder?: string;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { open, mounted, requestClose, toggle } = useMenuPresence(menuRef);
  const highlight = useId();
  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { spring } = useMotionTokens();

  const selected = options.find((o) => o.value === value);
  const filtered = q.trim()
    ? options.filter((o) => (o.label + " " + (o.hint ?? "")).toLowerCase().includes(q.trim().toLowerCase()))
    : options;

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) requestClose(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => { if (open) { setQ(""); setActive(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  useEffect(() => { setActive(0); }, [q]);
  // Keyboard movement keeps the active row in view; focus itself stays in the input.
  useEffect(() => { if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" }); }, [active, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (v: string) => { onChange(v); requestClose(); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(filtered.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const o = filtered[active]; if (o) pick(o.value); }
    else if (e.key === "Escape") { e.preventDefault(); requestClose(); triggerRef.current?.focus(); }
  };

  return (
    <div ref={rootRef} className="relative w-full max-w-md">
      <button ref={triggerRef} type="button" disabled={disabled} onClick={toggle} aria-haspopup="listbox" aria-expanded={open}
        className={cn("flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left text-body outline-none transition focus:border-border-heavy disabled:opacity-50",
          selected ? "text-foreground" : "text-faint")}>
        <span className="truncate">{selected ? selected.label : placeholder}{selected?.hint ? <span className="ml-1.5 text-muted-foreground">· {selected.hint}</span> : null}</span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition", open && "rotate-180")} />
      </button>

      {mounted && (
        <div ref={menuRef} className="absolute z-20 mt-1.5 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="size-3.5 shrink-0 text-faint" aria-hidden />
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
              placeholder={searchPlaceholder} aria-label={searchPlaceholder}
              role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list"
              aria-activedescendant={filtered[active] ? optionId(active) : undefined}
              className="w-full bg-transparent text-body text-foreground outline-none placeholder:text-faint" />
          </div>
          <motion.div layoutScroll id={listId} role="listbox" className="openlive-scroll max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && <div className="px-3 py-3 text-center text-label text-faint">{emptyText}</div>}
            {filtered.map((o, i) => (
              <button key={o.value} id={optionId(i)} type="button" role="option" aria-selected={o.value === value} tabIndex={-1} onMouseEnter={() => setActive(i)} onClick={() => pick(o.value)}
                className={cn("relative isolate flex w-full items-center gap-2 px-3 py-1.5 text-left text-body transition",
                  i !== active && "hover:bg-foreground/[0.04]")}>
                {i === active && <motion.span layoutId={highlight} transition={spring} aria-hidden className="absolute inset-0 -z-10 bg-foreground/[0.07]" />}
                <span className={cn("grid size-4 shrink-0 place-items-center", o.value === value ? "text-accent" : "text-transparent")}><Check className="size-3.5" /></span>
                <span className="truncate text-foreground">{o.label}</span>
                {o.hint && <span className="ml-auto shrink-0 text-caption text-muted-foreground">{o.hint}</span>}
              </button>
            ))}
          </motion.div>
        </div>
      )}
    </div>
  );
}
