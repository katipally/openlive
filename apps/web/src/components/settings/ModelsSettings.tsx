"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Check, Trash2, Eye, EyeOff, Brain, Zap, AlertTriangle, ChevronDown } from "lucide-react";
// Pure subpaths only — the barrel pulls in catalog/models (node:fs), which can't
// bundle into this client component.
import { BUILTIN_PROVIDERS } from "@openlive/harness/registry";
import { allowedEfforts } from "@openlive/harness/types";
import { modelVision } from "@openlive/shared";
import { api, type ModelInfo } from "@/lib/api";
import { SearchSelect, type SearchOption } from "./SearchSelect";
import { cn } from "@/lib/cn";

const fmtCtx = (n?: number) => (n ? (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`) : "—");

// Real image-input capability when the API reports it (models.dev / provider
// payload); fall back to the name heuristic when it doesn't.
const hasVision = (providerId: string, m: ModelInfo) => m.vision ?? modelVision(providerId, m.id);

// Every provider the harness supports. `protocol` drives which reasoning efforts
// a model can take.
const PROVIDERS = BUILTIN_PROVIDERS.map((p) => ({ id: p.id, name: p.name, protocol: p.protocol, keyless: !!p.keyless }));

// A titled section: left-aligned heading + description, then its controls.
function Section({ title, desc, children }: { title: string; desc: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-border pb-7 last:border-0 last:pb-0">
      <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-muted-foreground">{desc}</p>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

// API-key entry bound to one provider (by registry id).
function ProviderKey({ kind }: { kind: string }) {
  const qc = useQueryClient();
  const { data: providers = [] } = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const row = providers.find((p) => p.kind === kind);
  const info = PROVIDERS.find((p) => p.id === kind);
  const [key, setKey] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["providers"] }); qc.invalidateQueries({ queryKey: ["models"] }); };
  const save = useMutation({ mutationFn: () => api.setProviderKey(kind, key.trim()), onSuccess: () => { setKey(""); refresh(); } });
  const remove = useMutation({ mutationFn: () => api.removeProviderKey(row!.id), onSuccess: refresh });

  if (info?.keyless) return <p className="text-[12px] text-muted-foreground">No key needed — {info.name} is a local provider.</p>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="flex h-9 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 text-[12.5px] text-muted-foreground">
          {row?.hasKey ? <><Check className="size-3.5 text-success" /> Key set · ••••{row.keyLast4}</> : "No key set"}
        </div>
        <input value={key} onChange={(e) => setKey(e.target.value)} type="password" name={`${kind}-api-key`}
          placeholder={`Paste ${info?.name ?? kind} key`} aria-label={`${info?.name ?? kind} API key`}
          onKeyDown={(e) => { if (e.key === "Enter" && key.trim()) save.mutate(); }}
          className="h-9 flex-1 rounded-lg border border-border bg-card px-3 text-[12.5px] text-foreground outline-none focus:border-border-heavy" />
        <button onClick={() => save.mutate()} disabled={!key.trim() || save.isPending}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-3.5 text-[13px] font-medium text-background transition hover:opacity-90 disabled:opacity-30">
          {save.isSuccess ? <Check className="size-4" /> : <KeyRound className="size-4" />} Save
        </button>
        {row?.hasKey && (
          <button onClick={() => remove.mutate()} disabled={remove.isPending} title="Remove the stored key" aria-label="Remove key"
            className="grid size-9 place-items-center rounded-lg border border-border text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
            <Trash2 className="size-4" />
          </button>
        )}
      </div>
      {save.isError && <p className="text-[12px] text-destructive">{(save.error as Error).message}</p>}
    </div>
  );
}

function ModelBadges({ providerId, m }: { providerId: string; m?: ModelInfo }) {
  if (!m) return null;
  const vision = hasVision(providerId, m);
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
      {vision && <span className="inline-flex items-center gap-1 text-foreground"><Eye className="size-3.5" /> vision</span>}
      {m.reasoning
        ? <span className="inline-flex items-center gap-1 text-foreground"><Brain className="size-3.5" /> reasoning</span>
        : <span className="inline-flex items-center gap-1"><Zap className="size-3.5" /> fast</span>}
      <span>Context <b className="text-foreground">{fmtCtx(m.contextWindow)}</b></span>
      {m.maxOutput ? <span>Max out <b className="text-foreground">{Math.round(m.maxOutput / 1000)}k</b></span> : null}
      {m.cost ? <span>${m.cost.input}/M in</span> : null}
      {m.cost ? <span>${m.cost.output}/M out</span> : null}
    </div>
  );
}

// Optional dedicated vision model, its own provider. Used only when the live
// model can't see: frames are described by this model and handed to the live one.
function VisionModelPicker() {
  const qc = useQueryClient();
  const { data: providers = [] } = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const save = useMutation({
    mutationFn: (b: Record<string, string>) => api.updateSettings(b),
    onSuccess: (s) => qc.setQueryData(["settings"], s),
  });

  // Default the provider box to a keyed provider so the model list isn't empty.
  const vProvider = settings?.visionProviderId
    ?? providers.find((p) => p.isDefault)?.kind ?? providers[0]?.kind ?? PROVIDERS[0]!.id;
  const { data: models = [] } = useQuery({ queryKey: ["models", vProvider], queryFn: () => api.models(vProvider), enabled: !!vProvider });

  // Only vision-capable models make sense here.
  const options: SearchOption[] = models
    .filter((m) => hasVision(vProvider, m))
    .map((m) => ({ value: m.id, label: m.display_name, hint: m.reasoning ? "reasoning" : "fast" }));

  return (
    <div className="flex flex-col gap-2.5">
      <select value={vProvider} aria-label="Vision provider"
        onChange={(e) => save.mutate({ visionProviderId: e.target.value, visionModel: "" })}
        className="h-9 w-full rounded-lg border border-border bg-card px-3 text-[12.5px] text-foreground outline-none focus:border-border-heavy">
        {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <SearchSelect value={settings?.visionModel ?? ""} onChange={(id) => save.mutate({ visionModel: id })}
        options={options} placeholder={models.length ? "None — use the live model to see" : "Add a key to load models…"}
        disabled={!models.length} emptyText="No vision models here" />
      {settings?.visionModel
        ? <button onClick={() => save.mutate({ visionModel: "" })} className="self-start text-[11.5px] text-muted-foreground hover:text-foreground">Clear — let the live model see</button>
        : null}
    </div>
  );
}

export function ModelsSettings() {
  const qc = useQueryClient();
  const { data: providers = [] } = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });

  const providerId = settings?.liveProviderId ?? providers.find((p) => p.isDefault)?.kind ?? providers[0]?.kind ?? PROVIDERS[0]!.id;
  const { data: models = [] } = useQuery({ queryKey: ["models", providerId], queryFn: () => api.models(providerId), enabled: !!providerId });

  const saveSetting = useMutation({
    mutationFn: (b: Record<string, string>) => api.updateSettings(b),
    onSuccess: (s) => qc.setQueryData(["settings"], s),
  });

  const provider = PROVIDERS.find((p) => p.id === providerId);
  const model = models.find((m) => m.id === settings?.liveModel);
  const efforts = ["auto", ...allowedEfforts(provider?.protocol, model?.reasoning ?? true)];
  const effort = settings?.liveEffort ?? "auto";

  const options: SearchOption[] = models.map((m) => {
    const bits = [hasVision(providerId, m) && "vision", m.reasoning ? "reasoning" : "fast"].filter(Boolean);
    return { value: m.id, label: m.display_name, hint: bits.join(" · ") };
  });

  // Warn only when we KNOW it can't see (false), not when capability is unknown.
  const liveBlind = model ? hasVision(providerId, model) === false : false;
  const hasVisionModel = !!settings?.visionModel;

  const changeModel = (id: string) => {
    const m = models.find((x) => x.id === id);
    const eff = ["auto", ...allowedEfforts(provider?.protocol, m?.reasoning ?? true)];
    const patch: Record<string, string> = { liveModel: id };
    if (effort !== "auto" && !eff.includes(effort)) patch.liveEffort = "auto";
    saveSetting.mutate(patch);
  };

  return (
    <div className="flex flex-col gap-7">
      <Section title="Provider & API key"
        desc="Pick a provider and paste its key. It's encrypted at rest on this machine — only the last 4 digits are ever shown.">
        <div className="mb-3 inline-flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1">
          {PROVIDERS.map((p) => (
            <button key={p.id} onClick={() => saveSetting.mutate({ liveProviderId: p.id, liveModel: "" })}
              className={cn("rounded-md px-3.5 py-1.5 text-[13px] font-medium transition",
                providerId === p.id ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground")}>
              {p.name}
            </button>
          ))}
        </div>
        <ProviderKey kind={providerId} />
      </Section>

      <Section title="Model"
        desc={<>Fetched live from {provider?.name}. Pick a fast one with vision — in a voice call, time-to-first-word matters and the camera needs a model that can see.</>}>
        <SearchSelect value={settings?.liveModel ?? ""} onChange={changeModel} options={options}
          placeholder={models.length ? "Select a model…" : "Add a key to load models…"}
          disabled={!models.length} emptyText="No models match" />
        <ModelBadges providerId={providerId} m={model} />
        {liveBlind && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-arc/40 bg-arc-soft px-3 py-2.5 text-[12px] leading-relaxed text-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-arc" />
            <span>
              <b>{model?.display_name}</b> can’t see images — camera & screen won’t work with it.
              {hasVisionModel ? " A vision model is set below, so frames route through that." : " Pick a vision-capable model, or set a dedicated vision model below."}
            </span>
          </div>
        )}
      </Section>

      <details className="group border-b border-border pb-7 last:border-0 last:pb-0">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <div>
            <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-foreground">
              <EyeOff className="size-3.5 text-muted-foreground" /> Vision model
              <span className="rounded bg-surface px-1.5 py-0.5 text-[10.5px] font-normal text-muted-foreground">optional · advanced</span>
            </h2>
            <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-muted-foreground">
              Leave off and the live model sees for itself. Pick one to route camera/screen through a
              different model — used <b className="text-foreground">only</b> for vision, even if the live model can already see.
            </p>
          </div>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition group-open:rotate-180" />
        </summary>
        <div className="mt-3.5"><VisionModelPicker /></div>
      </details>

      <Section title="Reasoning effort"
        desc={<><b className="text-foreground">Auto</b> keeps the voice snappy (lowest the model supports). Raise it for deeper answers — but higher effort means a longer pause before it starts speaking.</>}>
        <div className="inline-flex rounded-lg border border-border bg-card p-1">
          {efforts.map((e) => (
            <button key={e} onClick={() => saveSetting.mutate({ liveEffort: e })}
              className={cn("rounded-md px-3.5 py-1.5 text-[12.5px] font-medium capitalize transition",
                effort === e ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground")}>
              {e === "auto" ? "Auto ✦" : e}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}
