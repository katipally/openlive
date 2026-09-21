"use client";

import { Volume2, VolumeX } from "lucide-react";
import { AGENT_REGISTRY, isAgentId } from "@openlive/shared";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { useFlowSessions, sessionLine, type FlowSessionSummary } from "@/lib/flow/sessions";
import { bindingLabel } from "@/lib/flow/binding";
import { clock, duration } from "@/lib/flow/format";
import type { FlowView } from "./FlowShell";
import { cn } from "@/lib/cn";

// Not a dashboard. One line that says what Flow is, three cards that say what it
// is set to right now, and then what the person actually said, most recent first.

const HOLD_MODES: Record<string, string> = {
  hold: "hold to talk", ptt: "hold to talk", hold_or_toggle: "hold to talk, or tap to keep it open", toggle: "tap to toggle",
};

export function FlowHome({ onOpen }: { onOpen: (view: FlowView, id?: string | null) => void }) {
  const { config } = useFlowConfig();
  const { caps } = useFlowCapabilities();
  const { data, isLoading, error } = useFlowSessions("", 8);
  const sessions = data?.sessions ?? [];

  const binding = bindingLabel(config?.binding ?? "");
  const speaking = config?.voice.speakReplies !== false;

  return (
    <div className="openlive-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-8 pt-1">
      <section className="flex flex-wrap items-center gap-6 rounded-xl bg-card p-6 shadow-[var(--shadow-card)]">
        <OpenLiveOrb size={76} pulse />
        <div className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
          <h1 className="text-title-lg font-semibold tracking-tight">
            {config ? `Hold ${binding} anywhere and talk` : "Hold your key anywhere and talk"}
          </h1>
          <p className="max-w-[40rem] text-callout leading-relaxed text-muted-strong">
            Nothing to open, nothing to set up. Flow types into whatever app you are in, does things for you when you
            ask, and says the rest out loud.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="flex min-w-[4.5rem] items-center justify-center rounded-lg bg-surface-raised px-4 py-2.5 font-mono text-title-sm shadow-[inset_0_-2px_0_rgba(0,0,0,.08)]">
            {binding}
          </span>
          <span className="text-caption text-muted-foreground">held alone for {config?.holdThresholdMs ?? 250}ms</span>
        </div>
      </section>

      <section className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))]">
        <Card label="Binding">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="font-mono text-title-sm">{binding}</span>
            <span className="text-body text-muted-strong">{HOLD_MODES[config?.activation ?? ""] ?? ""}</span>
          </div>
          <Link onClick={() => onOpen("settings")}>Change binding</Link>
        </Card>

        <Card label="Brain">
          <BrainLine config={config} />
          <Link onClick={() => onOpen("settings")}>Use a different brain</Link>
        </Card>

        <Card label="Voice">
          <div className="flex items-center gap-2">
            {speaking
              ? <Volume2 className="size-4 shrink-0 text-icon-info" aria-hidden />
              : <VolumeX className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
            <span className="text-title-sm font-medium">{speaking ? "Speaking replies" : "Written replies"}</span>
          </div>
          <p className="text-label leading-relaxed text-muted-strong">
            {speaking
              ? "Goes quiet on its own in calls, when the mic is busy, or in Do Not Disturb."
              : "Flow writes every reply on the pill instead of saying it."}
          </p>
        </Card>
      </section>

      {caps?.hookError && (
        <p className="rounded-xl bg-card px-4 py-3 text-label leading-relaxed text-destructive-text shadow-[var(--shadow-xs)]">
          Flow&rsquo;s key listener stopped: {caps.hookError}
        </p>
      )}

      <section className="flex min-h-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-1">
          <h2 className="text-title-sm font-semibold">Recent sessions</h2>
          <span className="text-caption text-muted-foreground">on this machine only</span>
          <span className="flex-1" />
          <Link onClick={() => onOpen("history")}>See all</Link>
        </div>

        <div className="flex min-h-0 flex-1 flex-col rounded-xl bg-card p-1.5 shadow-[var(--shadow-card)]">
          {error && <Empty>Flow&rsquo;s history could not be read.</Empty>}
          {!error && isLoading && <Empty>Looking&hellip;</Empty>}
          {!error && !isLoading && !sessions.length && (
            <Empty>
              Nothing yet. Hold {binding} anywhere on this machine and say something &mdash; whatever you say will be
              here afterwards.
            </Empty>
          )}
          {sessions.map((s, i) => (
            <SessionRow key={s.id} session={s} first={i === 0} onClick={() => onOpen("history", s.id)} />
          ))}
        </div>
      </section>
    </div>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg bg-card p-5 shadow-[var(--shadow-card)]">
      <span className="text-micro font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Link({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="self-start rounded text-label font-medium text-link-foreground transition hover:underline">
      {children}
    </button>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="m-auto max-w-[32rem] px-6 py-10 text-center text-body leading-relaxed text-muted-strong">{children}</p>
);

function BrainLine({ config }: { config: ReturnType<typeof useFlowConfig>["config"] }) {
  if (!config) return <span className="text-title-sm font-medium text-muted-foreground">&hellip;</span>;
  if (config.brain.kind === "acp") {
    const id = config.brain.agentId;
    const known = isAgentId(id);
    return (
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="size-[7px] shrink-0 translate-y-[-2px] rounded-full bg-arc" aria-hidden />
        <span className="min-w-0 truncate text-title-sm font-medium">{known ? AGENT_REGISTRY[id].label : id || "No agent chosen"}</span>
        <span className="text-caption text-muted-foreground">over ACP</span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="size-[7px] shrink-0 translate-y-[-2px] rounded-full bg-accent" aria-hidden />
      <span className="text-title-sm font-medium">OpenLive&rsquo;s own brain</span>
      {config.brain.model && <span className="min-w-0 truncate text-caption text-muted-foreground">{config.brain.model}</span>}
    </div>
  );
}

function SessionRow({ session, first, onClick }: { session: FlowSessionSummary; first: boolean; onClick: () => void }) {
  const ms = new Date(session.updatedAt).getTime() - new Date(session.createdAt).getTime();
  return (
    <button type="button" onClick={onClick}
      className={cn("flex min-h-[3.25rem] w-full items-center gap-4 rounded-md px-3.5 py-2 text-left transition hover:bg-foreground/[0.05]",
        !first && "shadow-[inset_0_1px_0_var(--border)]")}>
      <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{clock(session.createdAt)}</span>
      <span className="min-w-0 flex-1 truncate text-callout">&ldquo;{sessionLine(session)}&rdquo;</span>
      {session.state === "crash" && (
        <span className="shrink-0 rounded-full bg-destructive/10 px-2.5 py-0.5 text-caption text-destructive-text">Ended unexpectedly</span>
      )}
      {Number.isFinite(ms) && ms > 0 && (
        <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{duration(ms)}</span>
      )}
    </button>
  );
}
