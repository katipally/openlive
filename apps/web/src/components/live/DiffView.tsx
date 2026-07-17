"use client";

import { memo, useMemo, useState } from "react";
import { diffLines } from "diff";
import { isDesktop } from "@/lib/platform";
import { cn } from "@/lib/cn";
import { openLocation } from "./ToolCallCard";

// Plain colored unified diff (green/red line backgrounds — no syntax
// highlighting by design: the add/remove signal carries the meaning, and the
// voice app never pays for a highlighter bundle). Collapsed to the first
// changed lines with a "show all" toggle for big edits.

const COLLAPSED_LINES = 20;

type Row = { sign: "+" | "-" | " "; text: string };

function rows(oldText: string, newText: string): Row[] {
  const out: Row[] = [];
  for (const part of diffLines(oldText, newText)) {
    const sign = part.added ? "+" : part.removed ? "-" : " ";
    const lines = part.value.replace(/\n$/, "").split("\n");
    // Unchanged runs collapse to 2 context lines each side — the diff stays a
    // diff, not a full file listing.
    if (sign === " " && lines.length > 5) {
      out.push(...lines.slice(0, 2).map((text) => ({ sign, text }) as Row));
      out.push({ sign: " ", text: `⋯ ${lines.length - 4} unchanged lines` });
      out.push(...lines.slice(-2).map((text) => ({ sign, text }) as Row));
    } else {
      out.push(...lines.map((text) => ({ sign, text }) as Row));
    }
  }
  return out;
}

export const DiffView = memo(function DiffView({ path, oldText, newText, clipped }: {
  path: string; oldText?: string | null; newText: string; clipped?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const all = useMemo(() => rows(oldText ?? "", newText), [oldText, newText]);
  const visible = showAll ? all : all.slice(0, COLLAPSED_LINES);
  const hidden = all.length - visible.length;

  return (
    <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-xs)]">
      <button onClick={() => openLocation(path)} title={`${path} — ${isDesktop ? "click to reveal" : "click to copy"}`}
        className="block w-full truncate border-b border-border/60 px-2.5 py-1 text-left font-mono text-[11px] text-muted-foreground transition hover:text-foreground">
        {path}
      </button>
      <pre className="openlive-scroll overflow-x-auto p-0 font-mono text-[11.5px] leading-relaxed">
        {visible.map((r, i) => (
          <div key={i} className={cn(
            "flex min-w-max px-2.5",
            r.sign === "+" && "bg-success/15 text-foreground",
            r.sign === "-" && "bg-destructive/15 text-muted-foreground",
            r.sign === " " && "text-faint",
          )}>
            <span className="w-4 shrink-0 select-none">{r.sign === " " ? "" : r.sign}</span>
            <span className="whitespace-pre">{r.text}</span>
          </div>
        ))}
      </pre>
      {(hidden > 0 || clipped) && (
        <button onClick={() => setShowAll((v) => !v)}
          className="w-full border-t border-border/60 px-2.5 py-1 text-left text-[11px] text-link-foreground transition hover:bg-foreground/5">
          {showAll ? "Show less" : `Show ${hidden} more lines${clipped ? " (diff was clipped)" : ""}`}
        </button>
      )}
    </div>
  );
});
