"use client";

import { memo, useState } from "react";
import { Check, ChevronRight, Loader2, ShieldQuestion, ShieldX, Slash, XCircle } from "lucide-react";
import { visibleContent, type ToolCallState } from "@openlive/shared";
import { kindMeta } from "@/lib/live/toolMeta";
import { useLiveStore } from "@/lib/live/liveStore";
import { basename, bridge, isDesktop } from "@/lib/platform";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { DiffView } from "./DiffView";
import { TerminalView } from "./TerminalView";

/** Location chips: reveal in Finder/Explorer on desktop; copy the path on web. */
export function openLocation(path: string) {
  if (isDesktop && bridge) void bridge("reveal_path", path);
  else void navigator.clipboard.writeText(path).then(() => toast("Path copied", "info")).catch(() => {});
}

// One rich ACP tool call: kind icon, live status, expandable body (text, diffs,
// terminal output, raw input) and — when the agent is waiting on approval for
// THIS call — the permission options inline, right where the work is shown.
export const ToolCallCard = memo(function ToolCallCard({ call }: { call: ToolCallState }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const permission = useLiveStore((s) => (s.permission?.toolCallId === call.id ? s.permission : null));
  const answerPermission = useLiveStore((s) => s.answerPermission);

  const running = call.status === "pending" || call.status === "in_progress";
  const content = visibleContent(call);
  const hasBody = content.length > 0 || !!call.rawInputJson;
  // Auto-expand while output is streaming (terminal/diff arriving); collapse is
  // always one tap away. A finished quiet call stays collapsed.
  const expanded = open ?? (running && content.length > 0);

  const Icon = kindMeta(call.kind).icon;
  const loc = call.locations[0];

  return (
    <div className={cn("rounded-lg bg-card/40 shadow-[var(--shadow-xs)]", call.status === "failed" && "outline outline-1 outline-destructive/30")}>
      <button onClick={() => hasBody && setOpen(!expanded)} disabled={!hasBody}
        className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-label text-muted-foreground transition", hasBody && "hover:text-foreground")}>
        <StatusIcon status={call.status} waiting={!!permission} Icon={Icon} />
        <span className={cn("truncate", call.status === "failed" && "text-destructive")}>
          {permission ? "Awaiting approval — " : ""}{call.title}
        </span>
        {loc && (
          <span role="link" tabIndex={0} title={`${loc.path} — ${isDesktop ? "click to reveal" : "click to copy"}`}
            onClick={(e) => { e.stopPropagation(); openLocation(loc.path); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); openLocation(loc.path); } }}
            className="shrink-0 cursor-pointer truncate rounded bg-foreground/8 px-1.5 py-0.5 font-mono text-micro text-faint transition hover:bg-foreground/15 hover:text-foreground">
            {basename(loc.path)}{loc.line != null ? `:${loc.line}` : ""}
          </span>
        )}
        <StatusLabel status={call.status} />
        {hasBody && <ChevronRight className={cn("size-3.5 shrink-0 transition", expanded && "rotate-90")} />}
      </button>

      {expanded && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2.5">
          {content.map((c, i) =>
            c.type === "text" ? (
              <p key={i} className="whitespace-pre-wrap text-label leading-relaxed text-muted-foreground">{c.text}</p>
            ) : c.type === "diff" ? (
              <DiffView key={i} path={c.path} oldText={c.oldText} newText={c.newText} clipped={c.clipped} />
            ) : (
              <TerminalView key={i} terminalId={c.terminalId} snapshotOutput={c.output} snapshotExit={c.exitCode} />
            ),
          )}
          {call.rawInputJson && <RawDisclosure label="Raw input" json={call.rawInputJson} />}
        </div>
      )}

      {permission && answerPermission && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 px-2.5 py-2">
          <ShieldQuestion className="size-3.5 shrink-0 text-accent" />
          {permission.options.map((o) => (
            <button key={o.id} onClick={() => answerPermission(o.id)}
              className={cn(
                "rounded-full px-2.5 py-1 text-caption font-medium transition",
                o.id === "deny" || o.kind?.startsWith("reject")
                  ? "border border-border text-muted-foreground hover:bg-foreground/5"
                  : "bg-foreground text-background hover:opacity-90",
              )}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

function StatusIcon({ status, waiting, Icon }: { status: ToolCallState["status"]; waiting: boolean; Icon: typeof Check }) {
  if (waiting) return <ShieldQuestion className="size-3.5 shrink-0 text-accent" />;
  switch (status) {
    case "pending":
    case "in_progress": return <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />;
    case "failed": return <XCircle className="size-3.5 shrink-0 text-destructive" />;
    case "canceled": return <Slash className="size-3.5 shrink-0 text-faint" />;
    case "rejected": return <ShieldX className="size-3.5 shrink-0 text-destructive" />;
    default: return <Icon className="size-3.5 shrink-0 text-faint" />;
  }
}

function StatusLabel({ status }: { status: ToolCallState["status"] }) {
  const label = status === "failed" ? "failed" : status === "canceled" ? "canceled" : status === "rejected" ? "rejected" : null;
  if (!label) return null;
  return <span className={cn("ml-auto shrink-0 text-micro", status === "failed" ? "text-destructive" : "text-faint")}>{label}</span>;
}

function RawDisclosure({ label, json }: { label: string; json: string }) {
  const [show, setShow] = useState(false);
  const pretty = () => { try { return JSON.stringify(JSON.parse(json), null, 2); } catch { return json; } };
  return (
    <div>
      <button onClick={() => setShow((v) => !v)} className="flex items-center gap-1 text-caption text-faint transition hover:text-foreground">
        <ChevronRight className={cn("size-3 transition", show && "rotate-90")} />{label}
      </button>
      {show && <pre className="openlive-scroll mt-1 max-h-48 overflow-auto rounded-lg bg-surface p-2 font-mono text-caption leading-relaxed text-muted-foreground">{pretty()}</pre>}
    </div>
  );
}
