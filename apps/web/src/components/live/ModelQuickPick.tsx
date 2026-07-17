"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { BUILTIN_PROVIDERS } from "@openlive/harness/registry";
import { allowedEfforts } from "@openlive/harness/types";
import { api } from "@/lib/api";
import { useUi } from "@/lib/uiStore";
import { Section, Field, Picker, Segmented, FactChips, ThinkNote, THINK_HINT } from "./SetupControls";

const PROVIDERS = BUILTIN_PROVIDERS.map((p) => ({ id: p.id, name: p.name, keyless: !!p.keyless, protocol: p.protocol }));

const compact = (n: number): string =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);

// The built-in brain's side of the setup panel: provider, model, and how hard it
// thinks — the same Field/Picker/Chips vocabulary the agent panel uses, so switching
// "Talk to" doesn't switch design languages. Writes the same liveProviderId /
// liveModel settings as full Settings.
export function ModelQuickPick({ onOpenSettings }: { onOpenSettings: () => void }) {
  const qc = useQueryClient();
  const { data: providers = [] } = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });

  const providerId = settings?.liveProviderId ?? providers.find((p) => p.isDefault)?.kind ?? providers[0]?.kind ?? PROVIDERS[0]!.id;
  const { data: models = [], isLoading: modelsLoading } = useQuery({ queryKey: ["models", providerId], queryFn: () => api.models(providerId), enabled: !!providerId });
  const row = providers.find((p) => p.kind === providerId);
  const provider = PROVIDERS.find((p) => p.id === providerId);
  const hasKey = provider?.keyless || row?.hasKey;

  const save = useMutation({
    mutationFn: (b: Record<string, string>) => api.updateSettings(b),
    onSuccess: (s) => qc.setQueryData(["settings"], s),
  });

  const effort = settings?.liveEffort ?? "auto";
  const model = models.find((m) => m.id === settings?.liveModel);
  // Warn only on KNOWN-blind models (real metadata) with no vision model set.
  const blind = model?.vision === false && !settings?.visionModel;
  // Efforts the CURRENT provider/model supports — a non-reasoning model collapses
  // this to just "Auto", so the control tracks the model instead of offering
  // levels it would silently ignore.
  const efforts = ["auto", ...allowedEfforts(provider?.protocol, model?.reasoning ?? true)];

  // Facts about the picked model, not choices — they re-render as the model changes.
  const facts: { label: string; tone?: "muted" | "warn" }[] = model
    ? [
        ...(model.vision ? [{ label: "vision" as const }] : []),
        ...(model.reasoning ? [{ label: "reasoning" as const }] : []),
        ...(model.contextWindow ? [{ label: `${compact(model.contextWindow)} ctx` }] : []),
      ]
    : [];

  return (
    <Section title="How it runs">
      <Field label="Provider">
        <Picker ariaLabel="Provider" value={providerId}
          onChange={(id) => save.mutate({ liveProviderId: id, liveModel: "" })}
          options={PROVIDERS.map((p) => ({ id: p.id, name: p.name, detail: p.keyless ? "runs locally · no key" : undefined }))} />
      </Field>

      <Field label="Model" hint={hasKey ? undefined : <button onClick={onOpenSettings} className="text-accent transition hover:underline">Add a key →</button>}>
        <Picker ariaLabel="Model" value={settings?.liveModel || ""}
          onChange={(id) => save.mutate({ liveModel: id })}
          disabled={!hasKey || !models.length}
          placeholder={!hasKey ? "Add an API key to load models" : modelsLoading ? "Loading models…" : models.length ? "Recommended" : "No models available"}
          options={[
            { id: "", name: "Recommended", detail: "Let OpenLive pick a fast one", starred: true },
            ...models.map((m) => ({ id: m.id, name: m.display_name })),
          ]} />
        {facts.length > 0 && <div className="pt-1.5"><FactChips items={facts} /></div>}
        {blind && (
          <p className="flex items-center gap-1 pt-1 text-[10.5px] text-arc">
            <AlertCircle className="size-3 shrink-0" /> This model can&apos;t see — set a vision model in Settings.
          </p>
        )}
      </Field>

      <Field label="Effort" hint={THINK_HINT}>
        <Segmented ariaLabel="Effort" value={effort} onChange={(v) => save.mutate({ liveEffort: v })}
          options={efforts.map((e) => ({
            id: e,
            name: e === "auto" ? "Auto" : e[0]!.toUpperCase() + e.slice(1),
            starred: e === "auto",
          }))} />
        <ThinkNote />
      </Field>
    </Section>
  );
}
