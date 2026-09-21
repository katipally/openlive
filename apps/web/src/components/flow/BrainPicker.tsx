"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import type { FlowConfig } from "@openlive/flow-store";

// Who does the thinking, and what that thinker is set to. Both sides end in a
// model: OpenLive's own brain lists the models of the provider whose key you
// saved, and a coding agent is asked what it can be set to.
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

  const kind = config?.brain.kind ?? "openlive";
  const keyed = (providers.data ?? []).filter((p) => p.hasKey);
  const installed = (agents.data ?? []).filter((a) => a.installed && !a.hidden);

  // Nothing was picked, so the models shown are the ones the default key can
  // reach, which is also what the turn would actually run on.
  const providerKind = config?.brain.providerId || keyed.find((p) => p.isDefault)?.kind || keyed[0]?.kind || "";
  const models = useQuery({
    queryKey: ["models", providerKind],
    queryFn: () => api.models(providerKind || undefined),
    enabled: kind === "openlive" && !!keyed.length,
  });

  const agentId = kind === "acp" ? config?.brain.agentId ?? "" : "";
  const agentReady = !!installed.find((a) => a.id === agentId);
  const agentModels = useQuery({
    queryKey: ["agent-models", agentId],
    queryFn: () => api.agentModels(agentId),
    enabled: !!agentId && agentReady,
    staleTime: 5 * 60_000,
    retry: false,
  });

  return (
    <div className={cn("grid items-start gap-4", compact ? "" : "[grid-template-columns:repeat(auto-fit,minmax(20rem,1fr))]")}>
      <Choice
        checked={kind === "openlive"}
        onChoose={() => save({ brain: { kind: "openlive" } })}
        title="OpenLive’s own brain"
        detail="Runs on the API keys you already put in OpenLive. Tuned for short spoken turns, so it starts answering while it is still thinking."
      >
        <Field label="Provider">
          <select
            className="ol-select h-9 min-w-0 flex-1 rounded-md bg-surface-raised px-2.5 text-body text-foreground outline-none"
            value={providerKind}
            disabled={kind !== "openlive" || !keyed.length}
            onChange={(e) => save({ brain: { kind: "openlive", providerId: e.target.value, model: "" } })}
          >
            {!keyed.length && <option value="">No key saved yet</option>}
            {keyed.map((p) => <option key={p.id} value={p.kind}>{p.name}</option>)}
          </select>
        </Field>

        <Field label="Model">
          <select
            className="ol-select h-9 min-w-0 flex-1 rounded-md bg-surface-raised px-2.5 text-body text-foreground outline-none"
            value={config?.brain.model ?? ""}
            disabled={kind !== "openlive"}
            onChange={(e) => save({ brain: { kind: "openlive", model: e.target.value } })}
          >
            <option value="">Whatever live voice is set to</option>
            {(models.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.display_name || m.id}</option>)}
          </select>
        </Field>

        <p className="text-caption leading-relaxed text-muted-strong">
          {!keyed.length
            ? "No provider key is saved yet, so this brain has nothing to think with."
            : models.isLoading
              ? "Asking the provider what it offers…"
              : `${keyed.map((p) => p.name).join(", ")} ${keyed.length === 1 ? "key is" : "keys are"} saved on this machine.`}
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
                  onChange={() => save({ brain: { kind: "acp", agentId: a.id, agentModel: "" } })}
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

        <Field label="Model">
          <select
            className="ol-select h-9 min-w-0 flex-1 rounded-md bg-surface-raised px-2.5 text-body text-foreground outline-none"
            value={config?.brain.agentModel ?? ""}
            disabled={kind !== "acp" || !agentModels.data?.models.length}
            onChange={(e) => save({ brain: { kind: "acp", agentModel: e.target.value } })}
          >
            <option value="">Whatever the agent is already set to</option>
            {(agentModels.data?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
          </select>
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-caption leading-relaxed text-muted-strong">
            {agentModelNote(agentId, agentReady, agentModels)}
          </span>
          <button type="button" onClick={() => { void agents.refetch(); if (agentId) void agentModels.refetch(); }}
            disabled={agents.isFetching || agentModels.isFetching}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-surface-raised px-3 py-1.5 text-label font-medium transition hover:bg-foreground/10">
            <RefreshCw className={cn("size-3.5", (agents.isFetching || agentModels.isFetching) && "animate-spin")} aria-hidden />
            {agents.isFetching || agentModels.isFetching ? "Looking…" : "Look again"}
          </button>
        </div>
      </Choice>
    </div>
  );
}

/** Asking an agent for its models means starting it, so say what is happening. */
function agentModelNote(
  agentId: string,
  ready: boolean,
  q: { isLoading: boolean; isError: boolean; data?: { models: unknown[] } },
): string {
  if (!agentId) return "Found by running your login shell, the same way OpenLive launches it.";
  if (!ready) return "Pick one that is on this machine, and its models are read from the agent itself.";
  if (q.isLoading) return "Starting the agent once to ask what it can be set to. This takes a few seconds.";
  if (q.isError) return "The agent did not answer. It still works; Flow will use whatever it is already set to.";
  if (!q.data?.models.length) return "This agent does not let its model be chosen from outside, so it keeps its own.";
  return "Read from the agent itself, not a list OpenLive keeps.";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-wrap items-center gap-2.5">
      <span className="w-[4rem] shrink-0 text-label text-muted-strong">{label}</span>
      {children}
    </label>
  );
}

function Choice({ checked, onChoose, title, detail, children }: {
  checked: boolean; onChoose: () => void; title: string; detail: string; children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-3.5 rounded-xl bg-card p-5 shadow-[var(--shadow-card)] transition-shadow duration-300",
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
