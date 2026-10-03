"use client";

import { useId, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { AGENT_REGISTRY, isAgentId, type AgentId } from "@openlive/shared";
import { defaultBrain, defaultBrainSettings, type FlowBrain } from "@openlive/flow-store/shared";
import { api, type AgentStatus } from "@/lib/api";
import { toast } from "@/lib/toast";
import { usePersistedOpen } from "@/lib/disclosure";
import { flowBridge } from "@/lib/flow/bridge";
import { useApiModeChoice } from "@/lib/live/useApiModeChoice";
import { useUi } from "@/lib/uiStore";
import { cn } from "@/lib/cn";
import { effortName, THINK_HINT } from "@/components/live/SetupControls";
import { AgentIcon } from "@/components/live/AgentIcon";
import { Advanced, Radio, Select, linkClass } from "@/components/ui";
import { StatusDot } from "./common";

// Who answers you: your API key, or a coding agent you already use. One picker
// for the default (Settings > Models, and Welcome) and for Flow's and
// Dictate's own choice, so every place says it in the same words.
//
// Which coding agents exist is not guessed: it is the same /api/agents probe
// the Agents tab uses. An agent's model and effort are asked of the agent
// itself, and the lowest effort is its default, because every extra thinking
// token is silence on a spoken line.

export const API_KEY = "Your API key";
export const CODING_AGENT = "A coding agent";
const SHOWN_MISSING = 2;

/** An agent row's readiness in words. An unknown sign-in is not reported as missing. */
export function agentState(row: AgentStatus | undefined): { ready: boolean; text: string } {
  if (!row?.installed) return { ready: false, text: "Not set up" };
  if (row.credState === "login_required") return { ready: false, text: row.wizard ? "Setup incomplete" : "Sign in needed" };
  return { ready: true, text: [row.credState === "ready" ? "Signed in" : "Installed", row.version].filter(Boolean).join(" · ") };
}

/** The default, as settings.json holds it, and how to change it. */
export function useDefaultBrain() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const brain = settings ? defaultBrain(settings) : null;
  const save = useMutation({
    mutationFn: (b: Record<string, string>) => api.updateSettings(b),
    // Flow follows the default, and its runtime reads it in another renderer.
    onSuccess: (s) => { qc.setQueryData(["settings"], s); void qc.invalidateQueries({ queryKey: ["flow-config"] }); flowBridge()?.settingsChanged?.(); },
    onError: () => toast("Couldn’t save that choice. Try again."),
  });
  return { brain, settings, pick: (p: Partial<FlowBrain>) => { if (brain) save.mutate(defaultBrainSettings({ ...brain, ...p })); } };
}

/** The coding agent a new chat talks to, null for the API key, undefined while settings load. */
export function useDefaultAgent(): AgentId | null | undefined {
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  if (!settings) return undefined;
  const brain = defaultBrain(settings);
  return brain.kind === "acp" && isAgentId(brain.agentId) ? brain.agentId : null;
}

/** Who answers, in one line: its name, what it runs, and whether it is ready.
 *  `ready` is null while that is still being looked up. */
export function useAnswerLine(brain: FlowBrain | null) {
  const choice = useApiModeChoice();
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents, enabled: brain?.kind === "acp" });
  if (!brain || (brain.kind === "api" && choice.loading)) return { name: "…", detail: "", ready: null, agent: null };
  if (brain.kind === "api") {
    return { name: API_KEY, detail: choice.usable ? `${choice.providerName} · ${choice.model}` : `${choice.providerName}: no key yet`, ready: choice.usable, agent: null };
  }
  const agent = isAgentId(brain.agentId) ? brain.agentId : null;
  const state = agents.data ? agentState(agents.data.find((a) => a.id === brain.agentId)) : null;
  return { name: agent ? AGENT_REGISTRY[agent].label : "No agent chosen", detail: state?.text ?? "", ready: state?.ready ?? null, agent };
}

/** The one-line answer as a status, for a row that shows a choice made elsewhere. */
export function AnswerSummary({ brain }: { brain: FlowBrain | null }) {
  const line = useAnswerLine(brain);
  return <StatusDot tone={line.ready === false ? "arc" : "success"}>{[line.name, line.detail].filter(Boolean).join(" · ")}</StatusDot>;
}

/** `id` names this instance (its Advanced fold is remembered per id); `onPick`
 *  gets only what changed, a new agent with its model and effort reset. */
export function WhoAnswers({ id, label, value, onPick }: {
  id: string; label: string; value: FlowBrain | null; onPick: (pick: Partial<FlowBrain>) => void;
}) {
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents });
  const choice = useApiModeChoice();
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  const name = useId();

  const shown = (agents.data ?? []).filter((a) => !a.hidden);
  const installed = shown.filter((a) => a.installed);
  const missing = shown.filter((a) => !a.installed);
  const acp = value?.kind === "acp";
  // Kept while the API key answers, so going back to an agent goes back to the same one.
  const picked = installed.find((a) => a.id === value?.agentId);
  const current = acp ? picked : undefined;
  const pickAgent = (agentId: string) => onPick({ kind: "acp", agentId, agentModel: "", agentEffort: "" });
  const chooseAgent = () => {
    if (picked) onPick({ kind: "acp", agentId: picked.id });
    else { const first = installed.find((a) => agentState(a).ready) ?? installed[0]; if (first) pickAgent(first.id); }
  };
  const toAgents = () => openSettingsTab("agents");

  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col divide-y divide-border rounded-lg bg-card px-4 shadow-card">
      <Choice name={name} checked={value?.kind === "api"} onChoose={() => onPick({ kind: "api" })} title={API_KEY}
        status={choice.loading ? null : <StatusDot tone={choice.usable ? "success" : "arc"}>{choice.usable ? "Ready" : "No key yet"}</StatusDot>}>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 break-words">{choice.loading ? "…" : choice.usable ? `${choice.providerName} · ${choice.model}` : choice.providerName}</span>
          <button type="button" onClick={() => openSettingsTab("models", { anchor: "set-models-provider" })} className={cn("shrink-0 text-label", linkClass)}>
            Change &rsaquo;
          </button>
        </span>
      </Choice>

      <Choice name={name} checked={acp} disabled={!installed.length} onChoose={chooseAgent} title={CODING_AGENT}
        status={acp && value.agentId ? <StatusDot tone={agentState(current).ready ? "success" : "arc"}>{agentState(current).ready ? "Ready" : agentState(current).text}</StatusDot> : null}>
        {agents.isError ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Could not look for coding agents.</span>
            <LookAgain looking={agents.isFetching} onClick={() => void agents.refetch()} />
          </span>
        ) : !agents.data ? (
          <span>Looking for coding agents&hellip;</span>
        ) : !installed.length ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 break-words">None is set up on this machine yet. Claude Code, Codex and others answer under your own login.</span>
            <button type="button" onClick={toAgents} className={cn("shrink-0 text-label", linkClass)}>Set up in Agents &rsaquo;</button>
          </span>
        ) : (
          <div className="flex flex-col gap-2.5">
            <span className="flex min-w-0 items-center gap-2">
              {picked && isAgentId(picked.id) && <AgentIcon id={picked.id} className="size-4 shrink-0 text-foreground" />}
              <Select aria-label="Coding agent" className="min-w-0 flex-1" value={picked?.id ?? ""}
                onChange={(e) => pickAgent(e.target.value)}>
                {!picked && <option value="" disabled>Pick a coding agent</option>}
                {installed.map((a) => <option key={a.id} value={a.id}>{`${a.label} · ${agentState(a).text}`}</option>)}
              </Select>
            </span>
            {acp && value.agentId && !current && <span>Not on this machine any more. Pick another.</span>}
            {acp && current && !agentState(current).ready && (
              <button type="button" onClick={toAgents} className={cn("self-start text-label", linkClass)}>Sign in in Agents &rsaquo;</button>
            )}
            {acp && current && <AgentAdvanced id={id} brain={value} onPick={onPick} />}
          </div>
        )}
        {!!missing.length && (
          <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 break-words">
              Not set up: {missing.slice(0, SHOWN_MISSING).map((a) => a.label).join(", ")}{missing.length > SHOWN_MISSING && `,\u00a0+${missing.length - SHOWN_MISSING}`}
            </span>
            {!!installed.length && <button type="button" onClick={toAgents} className={cn("shrink-0 text-label", linkClass)}>Set up in Agents &rsaquo;</button>}
          </span>
        )}
      </Choice>
    </div>
  );
}

/** The agent's own model and effort, folded: most people keep the agent's defaults. */
function AgentAdvanced({ id, brain, onPick }: { id: string; brain: FlowBrain; onPick: (pick: Partial<FlowBrain>) => void }) {
  // Asking means starting the agent, so it waits for the fold to be opened.
  const [open] = usePersistedOpen(`settings:answers-${id}`);
  const models = useQuery({
    queryKey: ["agent-models", brain.agentId],
    queryFn: () => api.agentModels(brain.agentId),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const note = models.isLoading ? "Asking the agent what it can be set to…"
    : models.isError ? "The agent didn't answer, so it keeps its own settings."
    : !models.data?.models.length ? "This agent keeps its own model." : "";
  return (
    <Advanced id={`answers-${id}`}>
      <Field label="Model">
        <Select className="min-w-0 flex-1" value={brain.agentModel} disabled={!models.data?.models.length}
          onChange={(e) => onPick({ agentModel: e.target.value })}>
          <option value="">Agent default</option>
          {(models.data?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
        </Select>
      </Field>
      {!!models.data?.effort?.values.length && (
        <Field label="Effort" hint={THINK_HINT}>
          <Select className="min-w-0 flex-1" value={brain.agentEffort} onChange={(e) => onPick({ agentEffort: e.target.value })}>
            <option value="">Agent default (recommended)</option>
            {/* Named by id, so a level both kinds have reads the same on both sides;
                an agent-only level keeps whatever the agent calls it. */}
            {models.data.effort.values.map((v) => <option key={v.id} value={v.id}>{effortName(v.id) || v.name}</option>)}
          </Select>
        </Field>
      )}
      {note && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 flex-1 leading-relaxed">{note}</span>
          {models.isError && <LookAgain looking={models.isFetching} onClick={() => void models.refetch()} />}
        </span>
      )}
    </Advanced>
  );
}

function LookAgain({ looking, onClick }: { looking: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={looking}
      className="flex shrink-0 items-center gap-1.5 text-label font-medium text-muted-foreground transition hover:text-foreground">
      <RefreshCw className={cn("size-3.5", looking && "animate-spin")} aria-hidden />
      {looking ? "Looking…" : "Look again"}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
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

/** One option: the radio and its title on top, what it runs and how to change it under. */
function Choice({ name, checked, disabled, onChoose, title, status, children }: {
  name: string; checked: boolean; disabled?: boolean; onChoose: () => void; title: string; status: ReactNode; children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 py-3">
      <div className="flex min-h-control-sm flex-wrap items-center gap-x-3 gap-y-1">
        <label className={cn("flex min-w-0 flex-1 items-center gap-3", disabled ? "cursor-default" : "cursor-pointer")}>
          <Radio name={name} checked={checked} disabled={disabled} onChange={onChoose} />
          <span className={cn("min-w-0 break-words text-body font-medium", disabled ? "text-muted-foreground" : "text-foreground")}>{title}</span>
        </label>
        {status && <span className="shrink-0">{status}</span>}
      </div>
      <div className="pl-[1.875rem] text-caption text-muted-foreground">{children}</div>
    </div>
  );
}
