"use client";

import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { effortName, THINK_HINT } from "@/components/live/SetupControls";
import { useApiModeChoice } from "@/lib/live/useApiModeChoice";
import { useUi } from "@/lib/uiStore";
import { cn } from "@/lib/cn";
import { useMotionTokens } from "@/lib/motion";
import type { FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import type { FlowConfig } from "@openlive/flow-store";

// Who does the thinking, and what that thinker is set to. API mode is set once
// in Settings > Models and shared with Chat, so it is only summarised here. A
// coding agent is asked what it can be set to, effort included.
//
// The lowest effort is the recommended one and the default, because every extra
// thinking token is silence on a spoken line. It is a recommendation, not a
// ceiling: every level the model takes is in the list.
//
// Which coding agents exist is not guessed: it is the same /api/agents probe the
// Agents settings tab uses, which runs the person's own login shell.

export function BrainPicker({ config, save }: {
  config: FlowConfig | null;
  save: (patch: FlowConfigPatch) => void;
}) {
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents });
  const choice = useApiModeChoice();
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  const { spring, fade } = useMotionTokens();

  const kind = config?.brain.kind ?? "api";
  const installed = (agents.data ?? []).filter((a) => a.installed && !a.hidden);

  const agentId = kind === "acp" ? config?.brain.agentId ?? "" : "";
  const agentReady = !!installed.find((a) => a.id === agentId);
  const agentModels = useQuery({
    queryKey: ["agent-models", agentId],
    queryFn: () => api.agentModels(agentId),
    enabled: !!agentId && agentReady,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const looking = agents.isFetching || agentModels.isFetching;
  const note = agentModelNote(agentReady, agentModels);

  return (
    <div className="flex flex-col divide-y divide-border rounded-lg bg-card px-4 shadow-[var(--shadow-card)]">
      <Choice checked={kind === "api"} onChoose={() => save({ brain: { kind: "api" } })} title="API mode · BYOK"
        detail={choice.loading ? "\u2026" : !choice.usable ? `${choice.providerName} has no key yet`
          : [choice.providerName, choice.model, `${effortName(choice.effort)} effort`].join(" \u00b7 ")}>
        <button type="button" onClick={() => openSettingsTab("models")}
          className="text-label font-medium text-accent transition hover:opacity-80">
          Change in Models
        </button>
      </Choice>

      {(agents.data ?? []).filter((a) => !a.hidden).map((a) => {
        const on = kind === "acp" && config?.brain.agentId === a.id;
        return (
          <Fragment key={a.id}>
            <Choice checked={on} disabled={!a.installed} title={a.label}
              onChoose={() => save({ brain: { kind: "acp", agentId: a.id, agentModel: "" } })}>
              {!a.installed ? "Not installed" : a.credState === "ready" ? (a.version ?? "Signed in") : (
                <button type="button" onClick={() => openSettingsTab("agents")} className="transition hover:text-foreground">
                  Sign in in Agents
                </button>
              )}
            </Choice>
            <AnimatePresence initial={false}>
            {on && (
              <motion.div className="overflow-hidden" transition={{ ...spring, bounce: 0, opacity: fade }}
                initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
              <div className="flex flex-col gap-2.5 py-3 pl-7">
                <Field label="Model">
                  <select className={selectClass} value={config?.brain.agentModel ?? ""}
                    disabled={!agentModels.data?.models.length}
                    onChange={(e) => save({ brain: { kind: "acp", agentModel: e.target.value } })}>
                    <option value="">Agent default</option>
                    {(agentModels.data?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                  </select>
                </Field>
                {!!agentModels.data?.effort?.values.length && (
                  <Field label="Effort" hint={THINK_HINT}>
                    <select className={selectClass} value={config?.brain.agentEffort ?? ""}
                      onChange={(e) => save({ brain: { kind: "acp", agentEffort: e.target.value } })}>
                      <option value="">Agent default (recommended)</option>
                      {/* Named by id, so the levels both brains have read the same on both
                          sides; an agent-only level keeps whatever the agent calls it. */}
                      {agentModels.data.effort.values.map((v) => <option key={v.id} value={v.id}>{effortName(v.id) || v.name}</option>)}
                    </select>
                  </Field>
                )}
                {note && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 text-caption leading-relaxed text-muted-foreground">{note}</span>
                    <button type="button" onClick={() => { void agents.refetch(); if (agentReady) void agentModels.refetch(); }} disabled={looking}
                      className="flex shrink-0 items-center gap-1.5 text-label font-medium text-muted-foreground transition hover:text-foreground">
                      <RefreshCw className={cn("size-3.5", looking && "animate-spin")} aria-hidden />
                      {looking ? "Looking\u2026" : "Look again"}
                    </button>
                  </div>
                )}
              </div>
              </motion.div>
            )}
            </AnimatePresence>
          </Fragment>
        );
      })}
      {!agents.data?.length && (
        <p className="py-3 text-caption text-muted-foreground">
          {agents.isLoading ? "Looking for coding agents…" : "No coding agents were found on this machine."}
        </p>
      )}
    </div>
  );
}

const selectClass = "ol-select h-9 min-w-[10rem] flex-1 rounded-lg border border-border bg-card px-3 text-label text-foreground outline-none focus:border-border-heavy";

/** Asking an agent for its models means starting it, so say what is happening. */
function agentModelNote(
  ready: boolean,
  q: { isLoading: boolean; isError: boolean; data?: { models: unknown[] } },
): string {
  if (!ready) return "Not on this machine any more. Pick another.";
  if (q.isLoading) return "Asking the agent what it can be set to\u2026";
  if (q.isError) return "The agent did not answer, so it keeps its own settings.";
  if (!q.data?.models.length) return "This agent keeps its own model.";
  return "";
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-wrap items-center gap-2.5">
      <span className="flex min-w-[4rem] shrink-0 flex-col">
        <span className="text-label text-muted-strong">{label}</span>
        {hint && <span className="text-caption text-muted-foreground">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Choice({ checked, disabled, onChoose, title, detail, children }: {
  checked: boolean; disabled?: boolean; onChoose: () => void; title: string; detail?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 py-2.5">
      <label className={cn("flex min-w-0 flex-1 items-center gap-3", disabled ? "cursor-default" : "cursor-pointer")}>
        <input type="radio" name="flow-brain" checked={checked} disabled={disabled} onChange={onChoose}
          className="size-4 shrink-0 accent-[var(--accent)]" />
        <span className="flex min-w-0 flex-col">
          <span className={cn("truncate text-body", disabled ? "text-muted-foreground" : "font-medium text-foreground")}>{title}</span>
          {detail && <span className="break-words text-caption text-muted-foreground">{detail}</span>}
        </span>
      </label>
      <span className="shrink-0 text-caption text-muted-foreground">{children}</span>
    </div>
  );
}
