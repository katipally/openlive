"use client";

import { useQuery } from "@tanstack/react-query";
import { Settings2, AlertCircle } from "lucide-react";
import { BUILTIN_PROVIDERS } from "@openlive/harness/registry";
import { api } from "@/lib/api";
import { useSettings } from "@/lib/settingsStore";
import { cn } from "@/lib/cn";

const PROVIDERS = BUILTIN_PROVIDERS.map((p) => ({ id: p.id, name: p.name, keyless: !!p.keyless }));
const sel = "min-w-0 rounded-lg border border-border bg-surface px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-border-heavy";

// Compact provider + model picker for the lobby, so you can switch fast without
// opening full Settings. Reads/writes the same localStorage settings store.
export function ModelQuickPick({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { keys, liveProviderId, liveModel, liveEffort, setProvider, setModel } = useSettings();
  const providerId = liveProviderId || PROVIDERS[0]!.id;
  const key = keys[providerId];
  const keyless = PROVIDERS.find((p) => p.id === providerId)?.keyless;
  const hasKey = keyless || !!key;

  const { data: models = [] } = useQuery({
    queryKey: ["models", providerId, key ? "keyed" : "nokey"],
    queryFn: () => api.models(providerId, key),
  });

  return (
    <div className="flex w-full max-w-xs flex-col gap-2 rounded-xl border border-border bg-surface/60 p-2.5">
      <div className="flex items-center gap-2">
        <select className={cn(sel, "shrink-0")} value={providerId} onChange={(e) => setProvider(e.target.value)}>
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className={cn(sel, "flex-1")} value={liveModel} onChange={(e) => setModel(e.target.value)}>
          <option value="">{models.length ? "Recommended" : hasKey ? "Loading…" : "Add a key →"}</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
        </select>
        <button onClick={onOpenSettings} title="Settings" aria-label="Open settings"
          className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
          <Settings2 className="size-4" />
        </button>
      </div>
      <div className="flex items-center justify-between px-0.5 text-[11px] text-faint">
        <span>Effort: <span className="capitalize text-muted-foreground">{liveEffort || "auto"}</span></span>
        {!hasKey && <span className="inline-flex items-center gap-1 text-arc"><AlertCircle className="size-3" /> no API key yet</span>}
      </div>
    </div>
  );
}
