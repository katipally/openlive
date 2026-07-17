"use client";

import { memo, useEffect, useRef } from "react";
import { useLiveStore } from "@/lib/live/liveStore";
import { cn } from "@/lib/cn";

// Command output inside a tool call. Live sessions stream into
// liveStore.terminals (term_output events); reopened transcripts fall back to
// the output snapshotted into the tool call at persist time.
export const TerminalView = memo(function TerminalView({ terminalId, snapshotOutput, snapshotExit }: {
  terminalId: string; snapshotOutput?: string; snapshotExit?: number | null;
}) {
  const live = useLiveStore((s) => s.terminals[terminalId]);
  const output = live?.output || snapshotOutput || "";
  const exitCode = live?.exitCode !== undefined ? live.exitCode : snapshotExit;
  const truncated = live?.truncated ?? false;
  const running = live !== undefined && live.exitCode === undefined;

  // Pin to the bottom while the command runs (tail -f feel); leave the user's
  // scroll alone once it's done.
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (running && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [output, running]);

  return (
    <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-xs)]">
      {truncated && <div className="border-b border-border/60 px-2.5 py-1 text-[11px] text-faint">Earlier output truncated</div>}
      <pre ref={pre} className="openlive-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words p-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
        {output || (running ? "…" : "")}
      </pre>
      {exitCode != null && (
        <div className={cn(
          "border-t border-border/60 px-2.5 py-1 text-[11px]",
          exitCode === 0 ? "text-success" : "text-destructive",
        )}>
          exited with code {exitCode}
        </div>
      )}
    </div>
  );
});
