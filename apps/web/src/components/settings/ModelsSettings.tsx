"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Brain, Zap, AlertTriangle, ChevronDown, KeyRound } from "lucide-react";
// Pure subpaths only — the barrel pulls in catalog/models (node:fs), which can't
// bundle into this client component.
import { BUILTIN_PROVIDERS } from "@openlive/harness/registry";
import { allowedEfforts } from "@openlive/harness/types";
import { effortName } from "@/components/live/SetupControls";
import { modelVision } from "@openlive/shared";
import { api, type ModelInfo } from "@/lib/api";
import { toast } from "@/lib/toast";
import { ProviderKeyField } from "./ProviderKeyField";
import { EmptyState, LoadingRows, StatusDot } from "./common";
import { useSettingsNav } from "./nav";
import { cn } from "@/lib/cn";
import { usePersistedOpen } from "@/lib/disclosure";
import { Segmented, Select, Button, Notice, SearchSelect, ListGroup, ListRow, type SearchOption } from "@/components/ui";
import { useApiModeChoice } from "@/lib/live/useApiModeChoice";

const fmtCtx = (n?: number) => (n ? (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`) : "unknown");

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
      <Select value={vProvider} aria-label="Vision provider"
        onChange={(e) => save.mutate({ visionProviderId: e.target.value, visionModel: "" })} className="w-full">
        {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
      <SearchSelect value={settings?.visionModel ?? ""} onChange={(id) => save.mutate({ visionModel: id })}
        options={options} placeholder={models.length ? "None, so the live model sees" : modelsError?.message ?? "Add a key to load models…"}
        disabled={!models.length} emptyText="No vision models here" />
      {settings?.visionModel
        ? <Button variant="ghost" size="sm" onClick={() => save.mutate({ visionModel: "" })} className="self-start">Clear, so the live model sees</Button>
        : null}
    </div>
  );
}

export function ModelsSettings() {
  const { model: fallbackModel, providerId, usable, loading } = useApiModeChoice();
  const go = useSettingsNav();
  const qc = useQueryClient();
  const { data: providers = [] } = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });

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

  if (loading) return <LoadingRows rows={5} />;

  return (
    <div className="flex flex-col gap-4">
      {!usable && (
        <EmptyState icon={KeyRound} actions={<Button size="sm" onClick={() => go("agents")}>Open Agents</Button>}>
          No key yet. Paste one below, or use a coding agent instead.
        </EmptyState>
      )}
      <ListGroup>
        <div id="set-models-provider">
          <ListRow label="Provider" detail="One provider at a time">
            <div className="min-w-0 flex-1 basis-56">
              <SearchSelect value={providerId} onChange={(id) => saveSetting.mutate({ liveProviderId: id, liveModel: "" })}
                options={providerOptions} placeholder="Select a provider…" searchPlaceholder="Search providers…" emptyText="No providers match" />
            </div>
          </ListRow>
        </div>
        <ListRow label={provider?.keyless ? "Server" : "API key"} detail={provider?.keyless ? "No key needed" : "Encrypted on this machine"}>
          <div className="min-w-0 basis-full"><ProviderKeyField key={providerId} kind={providerId} /></div>
        </ListRow>

        <div id="set-models-model">
          <ListRow label="Model" info={`Fetched live from ${provider?.name ?? "the provider"}. A fast one with vision suits voice best.`}>
            <div className="min-w-0 flex-1 basis-56">
              <SearchSelect value={settings?.liveModel ?? ""} onChange={changeModel} options={options}
                placeholder={models.length ? `Recommended: ${fallbackModel}` : "Add a key to load models…"}
                disabled={!models.length} emptyText="No models match" />
            </div>
            {modelsError && <div role="alert" className="basis-full"><StatusDot tone="danger">{modelsError.message}</StatusDot></div>}
            {model && <div className="basis-full"><ModelBadges providerId={providerId} m={model} /></div>}
            {liveBlind && (
              <Notice className="basis-full">
                <AlertTriangle aria-hidden />
                <span>
                  <b>{model?.display_name}</b> can’t see images, so camera and screen won’t work with it.
                  {hasVisionModel ? " A vision model is set below, so frames route through that." : " Pick a vision-capable model, or set a vision model below."}
                </span>
              </Notice>
            )}
          </ListRow>
        </div>

        <div id="set-models-effort">
          <ListRow label="Reasoning effort" info="Lowest keeps voice snappy. Higher thinks deeper but pauses longer before speaking.">
            <Segmented label="Reasoning effort" value={effort} onChange={(liveEffort) => saveSetting.mutate({ liveEffort })} wrap
              options={efforts.map((e) => ({ id: e, label: e === "auto" ? `${effortName(e)} ✦` : effortName(e) }))} />
          </ListRow>
        </div>

        <div id="set-models-vision">
          <ListRow label="Vision" detail="For screenshots and images"
            info="Routes camera and screen through a separate model. Leave it off and the live model sees for itself.">
            <Button variant="ghost" size="sm" onClick={() => setVisionOpen(!visionOpen)} aria-expanded={visionOpen} className="min-w-0 max-w-full">
              <span className="min-w-0 truncate">{settings?.visionModel || "Same as above"}</span>
              <ChevronDown className={cn("shrink-0 transition", visionOpen && "rotate-180")} />
            </Button>
            {visionOpen && <div className="min-w-0 basis-full"><VisionModelPicker /></div>}
          </ListRow>
        </div>
      </ListGroup>
    </div>
  );
}
