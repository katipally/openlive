"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Brain, Zap, AlertTriangle, ChevronDown } from "lucide-react";
// Pure subpaths only — the barrel pulls in catalog/models (node:fs), which can't
// bundle into this client component.
import { BUILTIN_PROVIDERS } from "@openlive/harness/registry";
import { allowedEfforts } from "@openlive/harness/types";
import { effortName } from "@/components/live/SetupControls";
import { modelVision } from "@openlive/shared";
import { api, type ModelInfo } from "@/lib/api";
import { toast } from "@/lib/toast";
import { SearchSelect, type SearchOption } from "./SearchSelect";
import { ProviderKeyField } from "./ProviderKeyField";
import { usePersistedOpen } from "@/lib/disclosure";
import { Segmented } from "@/lib/seg";
import { Section } from "./Section";
import { useApiModeChoice } from "@/lib/live/useApiModeChoice";

const fmtCtx = (n?: number) => (n ? (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`) : "—");

// Real image-input capability when the API reports it (models.dev / provider
// payload); fall back to the name heuristic when it doesn't.
const hasVision = (providerId: string, m: ModelInfo) => m.vision ?? modelVision(providerId, m.id);

// Every provider the harness supports. `protocol` drives which reasoning efforts
// a model can take.
const PROVIDERS = BUILTIN_PROVIDERS.map((p) => ({ id: p.id, name: p.name, protocol: p.protocol, keyless: !!p.keyless }));

function ModelBadges({ providerId, m }: { providerId: string; m?: ModelInfo }) {
  if (!m) return null;
  const vision = hasVision(providerId, m);
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
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
    onError: () => toast("Couldn’t save that choice. Try again."),
  });

  // Default the provider box to a keyed provider so the model list isn't empty.
  const vProvider = settings?.visionProviderId
    ?? providers.find((p) => p.isDefault)?.kind ?? providers[0]?.kind ?? PROVIDERS[0]!.id;
  const { data: models = [], error: modelsError } = useQuery({ queryKey: ["models", vProvider], queryFn: () => api.models(vProvider), enabled: !!vProvider, retry: false });

  // Only vision-capable models make sense here.
  const options: SearchOption[] = models
    .filter((m) => hasVision(vProvider, m))
    .map((m) => ({ value: m.id, label: m.display_name, hint: m.reasoning ? "reasoning" : "fast" }));

  return (
    <div className="flex flex-col gap-2.5">
      <select value={vProvider} aria-label="Vision provider"
        onChange={(e) => save.mutate({ visionProviderId: e.target.value, visionModel: "" })}
        className="ol-select h-9 w-full rounded-lg border border-border bg-card px-3 text-label text-foreground outline-none focus:border-border-heavy">
        {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <SearchSelect value={settings?.visionModel ?? ""} onChange={(id) => save.mutate({ visionModel: id })}
        options={options} placeholder={models.length ? "None — use the live model to see" : modelsError?.message ?? "Add a key to load models…"}
        disabled={!models.length} emptyText="No vision models here" />
      {settings?.visionModel
        ? <button onClick={() => save.mutate({ visionModel: "" })} className="self-start text-caption text-muted-foreground hover:text-foreground">Clear — let the live model see</button>
        : null}
    </div>
  );
}

export function ModelsSettings() {
  const { model: fallbackModel } = useApiModeChoice();
  const qc = useQueryClient();
  const { data: providers = [] } = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });

  const providerId = settings?.liveProviderId ?? providers.find((p) => p.isDefault)?.kind ?? providers[0]?.kind ?? PROVIDERS[0]!.id;
  const { data: models = [], error: modelsError } = useQuery({ queryKey: ["models", providerId], queryFn: () => api.models(providerId), enabled: !!providerId, retry: false });
  const [visionOpen, setVisionOpen] = usePersistedOpen("models:vision");

  const saveSetting = useMutation({
    mutationFn: (b: Record<string, string>) => api.updateSettings(b),
    // Flow's brainReady is derived from the chosen provider, so it goes stale here.
    onSuccess: (s) => { qc.setQueryData(["settings"], s); void qc.invalidateQueries({ queryKey: ["flow-config"] }); },
    onError: () => toast("Couldn’t save that choice. Try again."),
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

  const providerOptions: SearchOption[] = PROVIDERS.map((p) => ({
    value: p.id,
    label: p.name,
    hint: p.keyless ? "local, no key" : providers.some((r) => r.kind === p.id && r.hasKey) ? "key saved" : "needs a key",
  }));

  const changeModel = (id: string) => {
    const m = models.find((x) => x.id === id);
    const eff = ["auto", ...allowedEfforts(provider?.protocol, m?.reasoning ?? true)];
    const patch: Record<string, string> = { liveModel: id };
    if (effort !== "auto" && !eff.includes(effort)) patch.liveEffort = "auto";
    saveSetting.mutate(patch);
  };

  return (
    <div className="flex flex-col gap-7">
      <p className="text-body text-foreground">Your own key, your own model. Chat and Flow both use this.</p>
      <Section id="set-models-provider" title="Provider & API key" desc="Pick a provider and paste its key. It stays encrypted on this machine.">
        <div className="mb-3">
          <SearchSelect value={providerId} onChange={(id) => saveSetting.mutate({ liveProviderId: id, liveModel: "" })}
            options={providerOptions} placeholder="Select a provider…" searchPlaceholder="Search providers…" emptyText="No providers match" />
        </div>
        <ProviderKeyField key={providerId} kind={providerId} />
      </Section>

      <Section id="set-models-model" title="Model"
        desc={<>Fetched live from {provider?.name}. A fast one with vision suits voice best.</>}>
        <SearchSelect value={settings?.liveModel ?? ""} onChange={changeModel} options={options}
          placeholder={models.length ? `Recommended: ${fallbackModel}` : modelsError?.message ?? "Add a key to load models…"}
          disabled={!models.length} emptyText="No models match" />
        <ModelBadges providerId={providerId} m={model} />
        {liveBlind && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-arc/40 bg-arc-soft px-3 py-2.5 text-label leading-relaxed text-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-arc" />
            <span>
              <b>{model?.display_name}</b> can’t see images — camera & screen won’t work with it.
              {hasVisionModel ? " A vision model is set below, so frames route through that." : " Pick a vision-capable model, or set a dedicated vision model below."}
            </span>
          </div>
        )}
      </Section>

      <details id="set-models-vision" open={visionOpen} onToggle={(e) => setVisionOpen(e.currentTarget.open)} className="group border-b border-border pb-7 last:border-0 last:pb-0">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <div>
            <h2 className="flex items-center gap-1.5 text-callout font-semibold text-foreground">
              <EyeOff className="size-3.5 text-muted-foreground" /> Vision model
              <span className="rounded bg-surface px-1.5 py-0.5 text-micro font-normal text-muted-foreground">optional · advanced</span>
            </h2>
            <p className="mt-1 max-w-xl text-label leading-relaxed text-muted-foreground">
              Routes camera and screen through a separate model. Leave off and the live model sees for itself.
            </p>
          </div>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition group-open:rotate-180" />
        </summary>
        <div className="mt-3.5"><VisionModelPicker /></div>
      </details>

      <Section id="set-models-effort" title="Reasoning effort"
        desc={<><b className="text-foreground">Lowest</b> keeps voice snappy. Higher thinks deeper but pauses longer before speaking.</>}>
        <Segmented label="Reasoning effort" value={effort} onChange={(liveEffort) => saveSetting.mutate({ liveEffort })}
          options={efforts.map((e) => ({ id: e, label: e === "auto" ? `${effortName(e)} ✦` : effortName(e) }))} />
      </Section>
    </div>
  );
}
