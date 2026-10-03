"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Check, Trash2, Server, RotateCcw } from "lucide-react";
// Pure subpath only — the barrel pulls in catalog/models (node:fs), which cannot
// bundle into a client component.
import { BUILTIN_PROVIDERS, DEFAULT_OLLAMA_URL, isLoopbackUrl, normalizeOllamaUrl } from "@openlive/harness/registry";
import { api, type AppSettings } from "@/lib/api";
import { serverSettingsChanged } from "@/lib/settingChanges";
import { cn } from "@/lib/cn";
import { Button, Tooltip, Input, fieldTrigger } from "@/components/ui";
import { cancelDelete, deferDelete, usePendingDeletes } from "@/lib/deferredDelete";
import { StatusDot } from "./common";

// API-key entry bound to one provider, by registry id. A key pasted here is the
// one key Chat, Flow and Dictate use: it is the DB `providers` row every surface
// reads. Where it stands shows once, as a dot and a word.

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

  if (info?.keyless) return <OllamaAddressField name={info.name} />;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-[9rem] flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          {hasKey && <span className="font-mono text-label text-foreground">••••{row!.keyLast4}</span>}
          <StatusDot tone={hasKey ? "success" : "arc"}>{hasKey ? "Saved" : "No key yet"}</StatusDot>
        </span>
        <Input size="md" value={key} onChange={(e) => setKey(e.target.value)} type="password" name={`${kind}-api-key`}
          placeholder={`Paste ${info?.name ?? kind} key`} aria-label={`${info?.name ?? kind} API key`}
          onKeyDown={(e) => { if (e.key === "Enter" && key.trim()) save.mutate(); }}
          className="min-w-[9rem] flex-1" />
        <Button variant="primary" onClick={() => save.mutate()} disabled={!key.trim() || save.isPending}>
          {save.isSuccess ? <Check /> : <KeyRound />} Save
        </Button>
        {hasKey && (
          <Tooltip label="Remove the stored key">
            <Button icon onClick={remove} aria-label="Remove key">
              <Trash2 />
            </Button>
          </Tooltip>
        )}
      </div>
      {save.isError && <div role="alert"><StatusDot tone="danger">{(save.error as Error).message}</StatusDot></div>}
    </div>
  );
}

type ConfirmResult = { settings?: AppSettings & Record<string, string>; cancelled?: boolean; error?: string };
const confirmOllamaUrl = () =>
  typeof window !== "undefined" ? (window as unknown as { openlive?: { confirmOllamaUrl?: (url: string) => Promise<ConfirmResult> } }).openlive?.confirmOllamaUrl : undefined;

/** A local provider needs no key, only an address. Saved beside the other API-mode
 *  settings, and read by every call to it: Chat, Flow and the model list. */
function OllamaAddressField({ name }: { name: string }) {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const current = settings?.ollamaBaseUrl || DEFAULT_OLLAMA_URL;
  // A hand-written settings.json can hold one too; it is honoured, and named here.
  const offMachine = !!normalizeOllamaUrl(current) && !isLoopbackUrl(current);
  const [url, setUrl] = useState("");
  const typed = url.trim();
  const invalid = !!typed && !normalizeOllamaUrl(typed);
  const save = useMutation({
    // Off this computer, the desktop app asks in a native dialog and saves it
    // itself; the settings route refuses such an address from a page. Cancel
    // resolves to null and leaves the saved address alone.
    mutationFn: async (value: string) => {
      if (!value || isLoopbackUrl(value)) return api.updateSettings({ ollamaBaseUrl: value });
      const confirm = confirmOllamaUrl();
      if (!confirm) throw new Error("An address off this computer can only be set in the OpenLive desktop app.");
      const r = await confirm(value);
      if (r.error) throw new Error(r.error);
      return r.settings ?? null;
    },
    onSuccess: (s) => {
      if (!s) return;
      setUrl("");
      serverSettingsChanged(s); // an address off this computer is saved by the desktop app, not through api.updateSettings
      qc.setQueryData(["settings"], s);
      void qc.invalidateQueries({ queryKey: ["models"] });
      void qc.invalidateQueries({ queryKey: ["flow-config"] });
    },
  });
  const submit = () => { if (typed && !invalid) save.mutate(typed); };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-label text-muted-foreground">No key needed. {name} runs on a server you point it at.</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className={cn(fieldTrigger, "flex h-control-md min-w-[9rem] flex-1 items-center gap-2 text-label text-muted-foreground")}>
          <Server className="size-3.5 shrink-0" /> <Tooltip label={current} truncated className="min-w-0"><span className="truncate">{current}</span></Tooltip>
        </div>
        <Input size="md" value={url} onChange={(e) => setUrl(e.target.value)} type="url" name="ollama-base-url" inputMode="url"
          placeholder={DEFAULT_OLLAMA_URL} aria-label={`${name} server address`} invalid={invalid}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          className="min-w-[9rem] flex-1" />
        <Button variant="primary" onClick={submit} disabled={!typed || invalid || save.isPending}>
          {save.data ? <Check /> : <Server />} Save
        </Button>
        {!!settings?.ollamaBaseUrl && (
          <Tooltip label={`Go back to ${DEFAULT_OLLAMA_URL}`}>
            <Button icon onClick={() => save.mutate("")} aria-label="Reset the address">
              <RotateCcw />
            </Button>
          </Tooltip>
        )}
      </div>
      {offMachine && <p className="break-words text-label text-muted-foreground">{current} isn&apos;t on this computer. Flow and Chat send it what you say and type, and screen content.</p>}
      {invalid && <p className="text-label text-destructive">Enter an http:// or https:// address, like {DEFAULT_OLLAMA_URL}.</p>}
      {save.isError && <p className="text-label text-destructive">{(save.error as Error).message}</p>}
    </div>
  );
}
