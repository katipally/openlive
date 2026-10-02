"use client";

import { memo, useState } from "react";
import { Check, ChevronRight, Loader2, ShieldQuestion, ShieldX, Slash, XCircle } from "lucide-react";
import { visibleContent, type ToolCallState } from "@openlive/shared";
import { kindMeta } from "@/lib/live/toolMeta";
import { useLiveStore } from "@/lib/live/liveStore";
import type { PermissionOption } from "@/lib/live/liveClient";
import { basename, bridge, isDesktop } from "@/lib/platform";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Disclosure, Button, Tooltip } from "@/components/ui";
import { DiffView } from "./DiffView";
import { TerminalView } from "./TerminalView";
import { AskLine } from "./AskLine";

/** Location chips: reveal in Finder/Explorer on desktop; copy the path on web. */
export function openLocation(path: string) {
  if (isDesktop && bridge) void bridge("reveal_path", path);
  else void navigator.clipboard.writeText(path).then(() => toast("Path copied", "info")).catch(() => {});
}

// One rich ACP tool call as a timeline row: kind icon, live status, title and
// file, expanding to its body (text, diffs, terminal output, raw input). When
// the agent waits on approval for THIS call, the ask sits right under it as a
// card. `standalone`: shown on its own in the timeline (an edit), so a diff is
// open from the start rather than one tap away.
export const ToolCallCard = memo(function ToolCallCard({ call, standalone }: { call: ToolCallState; standalone?: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const permission = useLiveStore((s) => (s.permission?.toolCallId === call.id ? s.permission : null));

  const running = call.status === "pending" || call.status === "in_progress";
  const content = visibleContent(call);
  const hasBody = content.length > 0 || !!call.rawInputJson;
  // Auto-expand while output is streaming (terminal/diff arriving); collapse is
  // always one tap away. A finished quiet call stays collapsed.
  const expanded = open ?? ((running && content.length > 0) || (!!standalone && content.some((c) => c.type === "diff")));

  const Icon = kindMeta(call.kind).icon;
  const loc = call.locations[0];

  return (
    <div className="flex min-w-0 flex-col">
      <button type="button" onClick={() => hasBody && setOpen(!expanded)} aria-expanded={hasBody ? expanded : undefined}
        className={cn("flex min-h-7 w-full min-w-0 items-center gap-2 text-left text-label text-muted-foreground", hasBody ? "transition hover:text-foreground" : "cursor-default")}>
        <StatusIcon status={call.status} waiting={!!permission} Icon={Icon} />
        <span className={cn("min-w-0 truncate", call.status === "failed" && "text-destructive")}>
          {permission ? "Waiting for you: " : ""}{call.title}
        </span>
        {/* The file, unless the title already names it. */}
        {loc && !call.title.includes(basename(loc.path)) && (
          <Tooltip label={`${loc.path}, ${isDesktop ? "click to reveal" : "click to copy"}`} className="min-w-0 shrink">
            <span role="link" tabIndex={0}
              onClick={(e) => { e.stopPropagation(); openLocation(loc.path); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); openLocation(loc.path); } }}
              className="cursor-pointer truncate font-mono text-caption text-faint transition hover:text-foreground">
              {basename(loc.path)}{loc.line != null ? `:${loc.line}` : ""}
            </span>
          </Tooltip>
        )}
        <StatusLabel status={call.status} />
        {hasBody && <ChevronRight aria-hidden className={cn("ml-auto size-3.5 shrink-0 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />}
      </button>

      <Disclosure open={expanded}>
        <div className="flex flex-col gap-1.5 pb-1.5 pl-5.5 pt-0.5">
          {content.map((c, i) =>
            c.type === "text" ? (
              <p key={i} className="whitespace-pre-wrap break-words text-label text-muted-foreground">{c.text}</p>
            ) : c.type === "diff" ? (
              <DiffView key={i} path={c.path} oldText={c.oldText} newText={c.newText} clipped={c.clipped} />
            ) : (
              <TerminalView key={i} terminalId={c.terminalId} snapshotOutput={c.output} snapshotExit={c.exitCode} />
            ),
          )}
          {call.rawInputJson && <RawDisclosure label="Raw input" json={call.rawInputJson} />}
        </div>
      </Disclosure>

      {permission && <PermissionCard question={permission.question} options={permission.options} command={call.title} Icon={Icon} />}
    </div>
  );
});

const isReject = (o: PermissionOption) => o.id === "deny" || !!o.kind?.startsWith("reject");

/** The agent's ask for this call, inline where the work is: what it wants to
 *  run, and the answers as buttons (allow first, the reject quietest). Voice
 *  answers it too; the card says so. */
function PermissionCard({ question, options, command, Icon }: { question: string; options: PermissionOption[]; command: string; Icon: typeof Check }) {
  const answer = useLiveStore((s) => s.answerPermission);
  const firstAllow = options.findIndex((o) => !isReject(o));
  return (
    <div className="mt-1.5 flex flex-col gap-2.5 rounded-lg border border-arc/35 bg-card p-3 shadow-card">
      {/* The tool's row above already names the call, so the command waits behind the details. */}
      <AskLine question={question} details={
        <p className="flex min-w-0 items-center gap-2 rounded-md bg-track px-2.5 py-2 font-mono text-caption text-foreground shadow-track">
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-all">{command}</span>
        </p>
      } />
      {answer && (
        <div className="flex flex-wrap items-center gap-1.5">
          {options.map((o, i) => (
            <Button key={o.id} size="sm" variant={isReject(o) ? "ghost" : i === firstAllow ? "primary" : "secondary"} onClick={() => answer(o.id)}>{o.label}</Button>
          ))}
          <span className="ml-auto text-caption text-faint">Say &ldquo;yes&rdquo; or &ldquo;no&rdquo;</span>
        </div>
      )}
    </div>
  );
}

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
      <Disclosure open={show}>
        <pre className="openlive-scroll mt-1 max-h-48 overflow-auto rounded-lg bg-surface p-2 font-mono text-caption leading-relaxed text-muted-foreground">{pretty()}</pre>
      </Disclosure>
    </div>
  );
}
