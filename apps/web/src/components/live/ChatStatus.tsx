"use client";

import { Chip, Tooltip, linkClass } from "@/components/ui";
import { FixPill } from "@/components/flow/GrantPills";
import { StatusDot } from "@/components/settings/common";
import { useChatReadiness } from "@/lib/live/chatReadiness";
import { cn } from "@/lib/cn";

// Whether a new call would start, said the way Flow's and Dictate's homes say
// theirs: Ready, or the one thing missing as a pill that goes to the fix.

/** On Chat's home, beside who answers. Nothing while it is still being read. */
export function ChatStatusChip() {
  const r = useChatReadiness();
  if (r.loading) return null;
  if (r.gap) return <FixPill tour="chat-status" tip={r.tip} onClick={r.fix}>{r.label}</FixPill>;
  return (
    <Tooltip label={r.tip} className="flex min-w-0 max-w-full">
      <span data-tour="chat-status" className="flex min-w-0 max-w-full"><Chip dot="success">Ready</Chip></span>
    </Tooltip>
  );
}

/** Settings > Chat's status line, where Flow and Dictate say whether they are on. */
export function ChatStatusLine({ id }: { id: string }) {
  const r = useChatReadiness();
  return (
    <p id={id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label">
      <StatusDot tone={r.gap ? "arc" : r.loading ? "muted" : "success"}>{r.gap ? `${r.tip}.` : r.loading ? "Checking…" : "Ready for a call."}</StatusDot>
      {r.gap && <button type="button" onClick={r.fix} className={cn(linkClass, "text-caption")}>{r.label}</button>}
    </p>
  );
}
