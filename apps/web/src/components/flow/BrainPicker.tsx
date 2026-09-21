"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import type { FlowConfig } from "@openlive/flow-store";

// Who does the thinking. The same control on the first run and in settings, so
// the choice reads identically wherever it is made.
//
// Which coding agents exist is not guessed: it is the same /api/agents probe the
// Agents settings tab uses, which runs the person's own login shell.

export function BrainPicker({ config, save, compact = false }: {
  config: FlowConfig | null;
  save: (patch: FlowConfigPatch) => void;
  /** Settings draws two rows; the first run draws two cards side by side. */
  compact?: boolean;
}) {
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const models = useQuery({
    queryKey: ["models", config?.brain.providerId ?? ""],
    queryFn: () => api.models(config?.brain.providerId || undefined),
    enabled: config?.brain.kind === "openlive",
  });

  const kind = config?.brain.kind ?? "openlive";
  const keyed = (providers.data ?? []).filter((p) => p.hasKey);
  const installed = (agents.data ?? []).filter((a) => a.installed && !a.hidden);

  return (
    <div className={cn("grid gap-4", compact ? "" : "[grid-template-columns:repeat(auto-fit,minmax(20rem,1fr))]")}>
      <Choice
        checked={kind === "openlive"}
        onChoose={() => save({ brain: { kind: "openlive" } })}
        title="OpenLive’s own brain"
        detail="Runs on the API keys you already put in OpenLive. Tuned for short spoken turns, so it starts answering while it is still thinking."
      >
        <label className="flex flex-wrap items-center gap-2.5">
          <span className="shrink-0 text-label text-muted-strong">Model</span>
          <select
            className="ol-select h-9 min-w-0 flex-1 rounded-md bg-surface-raised px-2.5 text-body text-foreground outline-none"
            value={config?.brain.model ?? ""}
            disabled={kind !== "openlive"}
            onChange={(e) => save({ brain: { kind: "openlive", model: e.target.value } })}
          >
            <option value="">Whatever live voice is set to</option>
            {(models.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.display_name || m.id}</option>)}
          </select>
        </label>
        <p className="text-caption leading-relaxed text-muted-strong">
          {keyed.length
            ? `${keyed.map((p) => p.name).join(", ")} ${keyed.length === 1 ? "key is" : "keys are"} saved on this machine.`
            : "No provider key is saved yet, so this brain has nothing to think with."}
        </p>
      </Choice>

      <Choice
        checked={kind === "acp"}
        onChoose={() => save({ brain: { kind: "acp", agentId: config?.brain.agentId || installed[0]?.id || "" } })}
        title="The coding agent you already use"
        detail="Flow talks to it over ACP. It keeps your project context, your tools and your rules, and now it has a voice."
      >
        <div className="flex flex-col rounded-lg bg-surface-raised p-1.5">
          {(agents.data ?? []).filter((a) => !a.hidden).map((a) => {
            const on = kind === "acp" && config?.brain.agentId === a.id;
            return (
              <label key={a.id}
                className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2.5 py-1.5 transition",
                  a.installed ? "hover:bg-foreground/[0.05]" : "cursor-default",
                  on && "bg-card shadow-[var(--shadow-xs)]")}>
                <input type="radio" name="flow-agent" checked={on} disabled={!a.installed}
                  onChange={() => save({ brain: { kind: "acp", agentId: a.id } })}
                  className="size-4 shrink-0 accent-[var(--accent)]" />
                <span className={cn("min-w-0 flex-1 truncate text-body", a.installed ? "font-medium text-foreground" : "text-muted-foreground")}>
                  {a.label}
                </span>
                <span className="shrink-0 text-caption text-muted-foreground">
                  {!a.installed ? "not on this machine" : a.credState === "ready" ? (a.version ?? "signed in") : "sign in needed"}
                </span>
              </label>
            );
          })}
          {!agents.isLoading && !agents.data?.length && (
            <p className="px-2.5 py-3 text-caption text-muted-strong">No coding agents were found on this machine.</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-caption leading-relaxed text-muted-strong">
            Found by running your login shell, the same way OpenLive launches it.
          </span>
          <button type="button" onClick={() => void agents.refetch()} disabled={agents.isFetching}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-surface-raised px-3 py-1.5 text-label font-medium transition hover:bg-foreground/10">
            <RefreshCw className="size-3.5" aria-hidden /> {agents.isFetching ? "Looking…" : "Look again"}
          </button>
        </div>
      </Choice>
    </div>
  );
}

function Choice({ checked, onChoose, title, detail, children }: {
  checked: boolean; onChoose: () => void; title: string; detail: string; children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-3.5 rounded-xl bg-card p-5 shadow-[var(--shadow-card)] transition",
      checked && "shadow-[var(--shadow-pop),inset_0_0_0_2px_var(--accent-soft)]")}>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="radio" name="flow-brain" checked={checked} onChange={onChoose}
          className="mt-1 size-[18px] shrink-0 accent-[var(--accent)]" />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-title-sm font-semibold">{title}</span>
          <span className="text-body leading-relaxed text-muted-strong">{detail}</span>
        </span>
      </label>
      {children}
    </div>
  );
}
