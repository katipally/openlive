"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Check, Trash2 } from "lucide-react";
// Pure subpath only — the barrel pulls in catalog/models (node:fs), which cannot
// bundle into a client component.
import { BUILTIN_PROVIDERS } from "@openlive/harness/registry";
import { api } from "@/lib/api";
import { cancelDelete, deferDelete, usePendingDeletes } from "@/lib/deferredDelete";

// API-key entry bound to one provider, by registry id. The same row serves the
// Models tab and Flow's brain picker, so a key pasted in either place is the one
// key both of them use: it is the DB `providers` row every surface reads.

export function ProviderKeyField({ kind }: { kind: string }) {
  const qc = useQueryClient();
  const { data: providers = [] } = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const row = providers.find((p) => p.kind === kind);
  const info = BUILTIN_PROVIDERS.find((p) => p.id === kind);
  const [key, setKey] = useState("");
  const pendingKey = row ? `key:${row.id}` : "";
  const removing = usePendingDeletes((s) => s.keys.has(pendingKey));
  const hasKey = !!row?.hasKey && !removing;
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ["providers"] }),
    qc.invalidateQueries({ queryKey: ["models"] }),
    qc.invalidateQueries({ queryKey: ["flow-config"] }),
  ]);
  // A key pasted while the old one waits out its Undo replaces it; the pending
  // clear must not land afterwards and wipe the new one.
  const save = useMutation({ mutationFn: () => { if (pendingKey) cancelDelete(pendingKey); return api.setProviderKey(kind, key.trim()); }, onSuccess: () => { setKey(""); void refresh(); } });
  const remove = () => {
    const id = row!.id;
    deferDelete(`key:${id}`, `${info?.name ?? kind} key removed`, async () => { await api.removeProviderKey(id); await refresh(); },
      "Couldn’t remove the key. It’s still saved.");
  };

  if (info?.keyless) return <p className="text-label text-muted-foreground">No key needed — {info.name} is a local provider.</p>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-9 min-w-[9rem] flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 text-label text-muted-foreground">
          {hasKey ? <><Check className="size-3.5 text-success" /> Key set · ••••{row!.keyLast4}</> : "No key set"}
        </div>
        <input value={key} onChange={(e) => setKey(e.target.value)} type="password" name={`${kind}-api-key`}
          placeholder={`Paste ${info?.name ?? kind} key`} aria-label={`${info?.name ?? kind} API key`}
          onKeyDown={(e) => { if (e.key === "Enter" && key.trim()) save.mutate(); }}
          className="h-9 min-w-[9rem] flex-1 rounded-lg border border-border bg-card px-3 text-label text-foreground outline-none focus:border-border-heavy" />
        <button onClick={() => save.mutate()} disabled={!key.trim() || save.isPending}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-3.5 text-body font-medium text-background transition hover:opacity-90 disabled:opacity-30">
          {save.isSuccess ? <Check className="size-4" /> : <KeyRound className="size-4" />} Save
        </button>
        {hasKey && (
          <button onClick={remove} title="Remove the stored key" aria-label="Remove key"
            className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
            <Trash2 className="size-4" />
          </button>
        )}
      </div>
      {save.isError && <p className="text-label text-destructive">{(save.error as Error).message}</p>}
    </div>
  );
}
