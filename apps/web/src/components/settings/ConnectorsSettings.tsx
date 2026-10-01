"use client";

import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, ExternalLink, Loader2, LogIn, LogOut, Pencil, Plus, RotateCcw, Search, ShieldCheck, X } from "lucide-react";
import type { ConnectorImportSource, ConnectorWire } from "@openlive/shared";
import { api } from "@/lib/api";
import { bridge, isDesktop } from "@/lib/platform";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import {
  STATUS, bulkTools, draftOf, editPatch, initialPicks, pickKey, pickedItems, secretPatch, signInPollMs, transportLine,
  type EditDraft, type KeyRow,
} from "@/lib/connectors";
import { Badge, Button, Checkbox, Chip, ConfirmButton, Input, ListGroup, Segmented, Switch, Textarea, Tooltip, groupLabel } from "@/components/ui";
import { Section } from "./Section";

const KEY = ["connectors"];
// Past this many connectors or tools a filter appears, as in Pronunciation.
const FILTER_AT = 8;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const field = "flex min-w-0 flex-col gap-1 text-label text-muted-foreground";
const panel = "flex flex-col gap-3 rounded-xl bg-card p-3 shadow-card";
const inset = "flex flex-col gap-3 rounded-lg border border-border p-3";

type SignIn = { id: string; url: string; since: number };

/** Opens a page in the real browser: the desktop shell's bridge, or a tab. A tab
 *  opened before the await (`tab`) is pointed at it, since a browser blocks one
 *  opened after. */
function openPage(url: string, tab?: Window | null) {
  if (isDesktop && bridge) void bridge("open_url", url);
  else if (tab) { tab.opener = null; tab.location.href = url; }
  else window.open(url, "_blank", "noopener");
}

/** MCP servers every brain can use, in Chat and Flow. The agent pushes nothing,
 *  so this page refreshes itself: on focus, while a connector is connecting,
 *  and while a sign-in is open in the browser. */
export function ConnectorsSettings() {
  const qc = useQueryClient();
  const [signIn, setSignIn] = useState<SignIn | null>(null);
  const [adding, setAdding] = useState<"add" | "import" | null>(null);
  const [filter, setFilter] = useState("");
  const { data: list, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: KEY, queryFn: api.connectors, retry: 1, refetchOnWindowFocus: true,
    refetchInterval: (q) => {
      if (signIn) return signInPollMs(Date.now() - signIn.since);
      return q.state.data?.some((c) => c.status === "connecting") ? 2000 : false;
    },
  });
  const put = (c: ConnectorWire) => qc.setQueryData<ConnectorWire[]>(KEY, (l) => l?.map((x) => (x.id === c.id ? c : x)));
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  // The desktop window regains focus without the page turning visible, which
  // is all the query's own focus check listens for.
  useEffect(() => {
    if (!signIn) return;
    const look = () => { if (document.visibilityState === "visible") void refetch(); };
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", look);
    const giveUp = setTimeout(() => setSignIn(null), 5 * 60_000);
    return () => { window.removeEventListener("focus", look); document.removeEventListener("visibilitychange", look); clearTimeout(giveUp); };
  }, [signIn, refetch]);
  const waitingOn = signIn && list?.find((c) => c.id === signIn.id);
  useEffect(() => {
    if (!signIn) return;
    if (!waitingOn) setSignIn(null);
    else if (waitingOn.status === "connected") { setSignIn(null); toast(`Signed in to ${waitingOn.name}.`, "info"); }
  }, [signIn, waitingOn]);

  const startSignIn = async (c: ConnectorWire) => {
    const tab = isDesktop ? null : window.open("", "_blank");
    try {
      const r = await api.startConnectorSignIn(c.id);
      if ("connector" in r) { tab?.close(); put(r.connector); return; }
      openPage(r.authorizationUrl, tab);
      setSignIn({ id: c.id, url: r.authorizationUrl, since: Date.now() });
    } catch (e) {
      tab?.close();
      toast(`Couldn’t start signing in to ${c.name}. ${msg(e)}`);
    }
  };

  const q = filter.trim().toLowerCase();
  const all = list ?? [];
  const shown = q ? all.filter((c) => `${c.name} ${transportLine(c.transport)}`.toLowerCase().includes(q)) : all;
  const actions = !adding && (
    <span className="flex flex-wrap gap-1.5">
      <Button size="sm" onClick={() => setAdding("import")}><Download /> Import</Button>
      <Button size="sm" onClick={() => setAdding("add")}><Plus /> Add connector</Button>
    </span>
  );

  return (
    <div className="flex flex-col gap-7">
      <Section id="set-connectors-list" title="Connectors" action={actions}
        desc={<>MCP servers that give every brain more tools, in Chat and Flow, for API models and coding agents alike. A tool that changes something asks you first. Changes apply from the next call or Flow run.</>}>
        <div className="flex flex-col gap-2">
          {adding === "add" && <AddPanel onDone={() => { setAdding(null); void refresh(); }} onCancel={() => setAdding(null)} />}
          {adding === "import" && <ImportPanel onDone={() => { setAdding(null); void refresh(); }} onCancel={() => setAdding(null)} />}
          {isLoading && <p className="text-label text-muted-foreground">Checking…</p>}
          {isError && (
            <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="min-w-0 flex-1 basis-48 break-words text-label text-muted-foreground">Couldn&apos;t reach OpenLive&apos;s agent. {msg(error)}</span>
              <Button size="sm" onClick={() => void refetch()} disabled={isFetching}>
                {isFetching ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry
              </Button>
            </div>
          )}
          {list && all.length === 0 && !adding && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-card-x py-5 text-center">
              <p className="text-label text-muted-foreground">No connectors yet. Add an MCP server by its URL, paste a config, or bring over the ones you set up in Claude, Codex, Cursor, Gemini CLI or VS Code.</p>
              <span className="flex flex-wrap justify-center gap-1.5">
                <Button size="sm" variant="primary" onClick={() => setAdding("add")}><Plus /> Add connector</Button>
                <Button size="sm" onClick={() => setAdding("import")}><Download /> Import</Button>
              </span>
            </div>
          )}
          {all.length > FILTER_AT && (
            <Input type="search" size="md" icon={<Search />} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Find among ${all.length} connectors`} aria-label="Find a connector" />
          )}
          {q && shown.length === 0 && <p className="text-label text-muted-foreground">No connector matches &ldquo;{filter.trim()}&rdquo;.</p>}
          {shown.length > 0 && (
            <ListGroup>
              {shown.map((c) => (
                <ConnectorRow key={c.id} c={c} put={put} refresh={refresh} onSignIn={() => void startSignIn(c)}
                  waiting={signIn?.id === c.id ? signIn.url : null} />
              ))}
            </ListGroup>
          )}
        </div>
      </Section>
    </div>
  );
}

function ConnectorRow({ c, put, refresh, onSignIn, waiting }: {
  c: ConnectorWire; put: (c: ConnectorWire) => void; refresh: () => Promise<void>; onSignIn: () => void; waiting: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [consentError, setConsentError] = useState("");
  const toolsId = useId();
  const status = STATUS[c.status];
  const line = transportLine(c.transport);
  const off = c.tools.filter((t) => !t.enabled).length;

  const run = async (what: string, call: () => Promise<ConnectorWire | unknown>, fail: string) => {
    setBusy(what);
    try { const r = await call(); if (r && typeof r === "object" && "id" in r) put(r as ConnectorWire); else await refresh(); }
    catch (e) { toast(`${fail} ${msg(e)}`); }
    finally { setBusy(null); }
  };
  // Switches move at once and go back if the agent says no.
  const flip = (next: ConnectorWire, call: () => Promise<ConnectorWire>, fail: string) => {
    put(next);
    call().then(put).catch((e) => { put(c); toast(`${fail} ${msg(e)}`); });
  };
  // A failed Allow keeps the card open, with the reason beside the button.
  const allow = async () => {
    setBusy("consent");
    setConsentError("");
    try { put(await api.consentConnector(c.id)); setReviewing(false); }
    catch (e) { setConsentError(`Couldn’t start ${c.name}. ${msg(e)}`); }
    finally { setBusy(null); }
  };
  const spin = (what: string, Icon: typeof LogIn) => (busy === what ? <Loader2 className="animate-spin" /> : <Icon />);

  return (
    <div className={cn("py-3 transition", !c.enabled && "opacity-60")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-words text-body font-medium text-foreground">{c.name}</span>
            <Chip dot={status.dot}>{status.text}</Chip>
          </div>
          <Tooltip label={<span className="break-all">{line}</span>} truncated className="flex min-w-0 max-w-full">
            <p className="mt-0.5 min-w-0 truncate font-mono text-caption text-faint">{line}</p>
          </Tooltip>
        </div>
        <label className="flex cursor-pointer items-center">
          <span className="sr-only">Use {c.name}</span>
          <Switch on={c.enabled} onFlip={() => flip({ ...c, enabled: !c.enabled }, () => api.setConnectorEnabled(c.id, !c.enabled), `Couldn’t turn ${c.name} ${c.enabled ? "off" : "on"}.`)} />
        </label>
      </div>

      {c.status === "error" && c.error && <p role="alert" className="mt-2 break-words text-caption text-destructive">{c.error}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {c.tools.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={toolsId}>
            <ChevronRight className={cn("transition-transform motion-reduce:transition-none", open && "rotate-90")} />
            {c.tools.length} {c.tools.length === 1 ? "tool" : "tools"}{off > 0 && ` · ${off} off`}
          </Button>
        ) : <span className="px-1 text-caption text-faint">No tools yet</span>}
        {c.status === "needs_auth" && <Button variant="primary" size="sm" onClick={onSignIn}><LogIn /> Sign in</Button>}
        {c.status === "needs_consent" && !reviewing && <Button variant="primary" size="sm" onClick={() => setReviewing(true)}><ShieldCheck /> Review and allow</Button>}
        {(c.status === "error" || c.status === "disconnected") && (
          <Button size="sm" onClick={() => void run("reconnect", () => api.reconnectConnector(c.id), `Couldn’t reconnect ${c.name}.`)} disabled={!!busy}>
            {spin("reconnect", RotateCcw)} Reconnect
          </Button>
        )}
        {c.signedIn && (
          <Button size="sm" onClick={() => void run("signout", () => api.signOutConnector(c.id), `Couldn’t sign out of ${c.name}.`)} disabled={!!busy}>
            {spin("signout", LogOut)} Sign out
          </Button>
        )}
        <span className="ml-auto flex flex-wrap gap-1.5">
          {!editing && <Button variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label={`Edit ${c.name}`}><Pencil /> Edit</Button>}
          <ConfirmButton label="Remove" confirm="Remove it?" disabled={!!busy}
            onConfirm={() => run("remove", () => api.removeConnector(c.id), `Couldn’t remove ${c.name}.`)} />
        </span>
      </div>

      {waiting && c.status !== "connected" && (
        <p role="status" className="mt-2 flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Finish signing in in your browser. This updates by itself.
          <Button variant="accent" size="sm" onClick={() => openPage(waiting)}><ExternalLink /> Open the page again</Button>
        </p>
      )}

      {reviewing && c.status === "needs_consent" && c.transport.type === "stdio" && (
        <div className={cn(inset, "mt-2.5")}>
          <p className="text-label text-foreground">OpenLive will start this program on your computer, with your access. Allow it only if you trust where it came from.</p>
          <dl className="grid grid-cols-1 gap-2 text-label">
            <Fact term="Command"><code className="break-all font-mono">{c.transport.command}</code></Fact>
            <Fact term="Arguments">
              {c.transport.args.length ? (
                <ol className="flex flex-col gap-0.5">{c.transport.args.map((a, i) => <li key={i} className="break-all font-mono">{a}</li>)}</ol>
              ) : "None"}
            </Fact>
            <Fact term="Folder">{c.transport.cwd ? <code className="break-all font-mono">{c.transport.cwd}</code> : "Not set"}</Fact>
            <Fact term="Environment">
              {Object.keys(c.transport.env).length + c.transport.secretEnv.length ? (
                <span className="flex flex-wrap gap-1">
                  {Object.keys(c.transport.env).map((k) => <Chip key={k} className="break-all font-mono">{k}</Chip>)}
                  {c.transport.secretEnv.map((k) => <Chip key={k} className="break-all font-mono">{k} · secret</Chip>)}
                </span>
              ) : "None"}
            </Fact>
          </dl>
          {consentError && <p role="alert" className="break-words text-label text-destructive">{consentError}</p>}
          <span className="flex flex-wrap gap-1.5">
            <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void allow()}>
              {spin("consent", ShieldCheck)} Allow
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setReviewing(false); setConsentError(""); }}>Cancel</Button>
          </span>
        </div>
      )}

      {editing && <EditPanel c={c} onSaved={(next) => { put(next); setEditing(false); }} onCancel={() => setEditing(false)} />}

      {open && c.tools.length > 0 && <Tools id={toolsId} c={c} flip={flip} />}
    </div>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className={groupLabel}>{term}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

function Tools({ id, c, flip }: {
  id: string; c: ConnectorWire; flip: (next: ConnectorWire, call: () => Promise<ConnectorWire>, fail: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const shown = q ? c.tools.filter((t) => `${t.exposedName} ${t.description}`.toLowerCase().includes(q)) : c.tools;
  const bulk = (on: boolean) => {
    const { names, label } = bulkTools(shown, !!q, on);
    const change = new Set(names);
    return (
      <Button variant="ghost" size="sm" disabled={!names.length} onClick={() => flip(
        { ...c, tools: c.tools.map((t) => (change.has(t.name) ? { ...t, enabled: on } : t)) },
        () => api.setConnectorToolsEnabled(c.id, names, on),
        `Couldn’t turn ${names.length === 1 ? names[0] : `${names.length} tools`} ${on ? "on" : "off"}.`,
      )}>{label}</Button>
    );
  };
  return (
    <div id={id} className="mt-2.5 flex flex-col gap-2">
      {c.tools.length > FILTER_AT && (
        <Input type="search" size="sm" icon={<Search />} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Find among ${c.tools.length} tools`} aria-label={`Find a tool in ${c.name}`} />
      )}
      {c.tools.length > 1 && shown.length > 0 && <span className="flex flex-wrap gap-1.5">{bulk(true)}{bulk(false)}</span>}
      {q && shown.length === 0 && <p className="text-label text-muted-foreground">No tool matches &ldquo;{filter.trim()}&rdquo;.</p>}
      {shown.length > 0 && (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border px-3">
          {shown.map((t) => (
            <div key={t.name} className="flex items-start gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 break-all font-mono text-label text-foreground">{t.exposedName}</span>
                  {t.readOnly ? <Badge>Read-only</Badge> : <Badge tone="arc">Asks first</Badge>}
                </div>
                {t.description && (
                  <Tooltip label={t.description} truncated className="flex min-w-0 max-w-full">
                    <p className="mt-0.5 line-clamp-2 min-w-0 break-words text-caption text-muted-foreground">{t.description}</p>
                  </Tooltip>
                )}
              </div>
              <label className="mt-0.5 flex cursor-pointer items-center">
                <span className="sr-only">Use {t.name}</span>
                <Switch on={t.enabled} onFlip={() => flip(
                  { ...c, tools: c.tools.map((x) => (x.name === t.name ? { ...x, enabled: !t.enabled } : x)) },
                  () => api.setConnectorToolEnabled(c.id, t.name, !t.enabled),
                  `Couldn’t turn ${t.name} ${t.enabled ? "off" : "on"}.`,
                )} />
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Names and values, one pair a line. A value saved earlier is never sent back
 *  here, so a saved secret shows as set and a typed value replaces it. */
function KeyRows({ rows, onChange, saved, noun, secrets }: {
  rows: KeyRow[]; onChange: (rows: KeyRow[]) => void; saved: readonly string[]; noun: string; secrets?: boolean;
}) {
  const set = (i: number, patch: Partial<KeyRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r, i) => {
        const isSet = r.secret && saved.includes(r.key.trim());
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <Input size="sm" value={r.key} onChange={(e) => set(i, { key: e.target.value })} placeholder="Name" aria-label={`${noun} ${i + 1} name`}
              spellCheck={false} className="min-w-0 flex-1 basis-32 font-mono" />
            <Input size="sm" type={r.secret ? "password" : "text"} value={r.value} onChange={(e) => set(i, { value: e.target.value })}
              placeholder={isSet ? "Set. Type to replace it" : r.secret ? "Not set" : "Value"} aria-label={`${noun} ${i + 1} value`}
              autoComplete="off" spellCheck={false} className="min-w-0 flex-1 basis-40 font-mono" />
            {secrets && (
              <label className="flex cursor-pointer items-center gap-1.5 text-caption text-muted-foreground">
                <Checkbox checked={r.secret} onChange={(e) => set(i, { secret: e.target.checked })} /> Secret
              </label>
            )}
            <Tooltip label={`Remove this ${noun}`}>
              <Button variant="ghost" size="sm" icon onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove ${noun} ${r.key || i + 1}`}><X /></Button>
            </Tooltip>
          </div>
        );
      })}
      <Button variant="ghost" size="sm" className="self-start" onClick={() => onChange([...rows, { key: "", value: "", secret: !secrets }])}>
        <Plus /> Add {noun}
      </Button>
    </div>
  );
}

function AddPanel({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [how, setHow] = useState<"url" | "json">("url");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [headers, setHeaders] = useState<KeyRow[]>([]);
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError("");
    let body: Parameters<typeof api.addConnector>[0];
    if (how === "json") body = { json };
    else {
      const rows = headers.filter((r) => r.key.trim() || r.value).map((r) => ({ ...r, key: r.key.trim() }));
      const { patch, missing } = secretPatch([], rows);
      if (rows.some((r) => !r.key)) return setError("Every header needs a name.");
      if (missing.length) return setError(`Enter a value for ${missing.join(", ")}.`);
      body = { url: url.trim(), ...(name.trim() && { name: name.trim() }), ...(rows.length && { headers: patch as Record<string, string> }) };
    }
    setBusy(true);
    try {
      const r = await api.addConnector(body);
      if (r.warnings.length) toast(r.warnings.join(" "), "info");
      onDone();
    } catch (e) { setError(msg(e)); }
    finally { setBusy(false); }
  };
  const ready = how === "url" ? !!url.trim() : !!json.trim();
  return (
    <div className={panel}>
      <Segmented label="How to add" value={how} onChange={(v) => { setHow(v); setError(""); }} className="self-start"
        options={[{ id: "url", label: "URL" }, { id: "json", label: "Paste JSON" }]} />
      {how === "url" ? (
        <>
          <label className={field}>Server URL
            <Input size="md" autoFocus type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp"
              onKeyDown={(e) => { if (e.key === "Enter" && ready) void submit(); }} spellCheck={false} />
          </label>
          <label className={field}>Name (optional)
            <Input size="md" value={name} onChange={(e) => setName(e.target.value)} placeholder="Taken from the address when empty" />
          </label>
          <div className={field}>
            <span>Headers (optional, kept secret)</span>
            <KeyRows rows={headers} onChange={setHeaders} saved={[]} noun="header" />
          </div>
        </>
      ) : (
        <label className={field}>The mcpServers block from Claude Desktop, Cursor or a server&apos;s README
          <Textarea autoFocus rows={8} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} className="font-mono text-label"
            placeholder={`{\n  "mcpServers": {\n    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"] }\n  }\n}`} />
        </label>
      )}
      {error && <p role="alert" className="break-words text-label text-destructive">{error}</p>}
      <span className="flex flex-wrap gap-1.5">
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={!ready || busy}>{busy ? <Loader2 className="animate-spin" /> : <Plus />} Add</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </span>
    </div>
  );
}

function EditPanel({ c, onSaved, onCancel }: { c: ConnectorWire; onSaved: (c: ConnectorWire) => void; onCancel: () => void }) {
  const [d, setD] = useState<EditDraft>(() => draftOf(c));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<EditDraft>) => setD({ ...d, ...patch });
  const t = c.transport;
  const save = async () => {
    const r = editPatch(c, d);
    if ("error" in r) return setError(r.error);
    if (!Object.keys(r.patch).length) return onCancel();
    setBusy(true);
    try { onSaved(await api.updateConnector(c.id, r.patch)); }
    catch (e) { setError(msg(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className={cn(inset, "mt-2.5")}>
      <label className={field}>Name
        <Input size="md" autoFocus value={d.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      {t.type === "http" ? (
        <>
          <label className={field}>Server URL
            <Input size="md" type="url" inputMode="url" value={d.url} onChange={(e) => set({ url: e.target.value })} spellCheck={false} />
          </label>
          <div className={field}>
            <span>Headers (kept secret)</span>
            <KeyRows rows={d.rows} onChange={(rows) => set({ rows })} saved={t.headers} noun="header" />
          </div>
          <label className={field}>Client metadata URL (optional)
            <Input size="md" type="url" inputMode="url" value={d.clientMetadataUrl} onChange={(e) => set({ clientMetadataUrl: e.target.value })}
              placeholder="https://example.com/oauth/client.json" spellCheck={false} />
          </label>
          <p className="text-caption text-muted-foreground">A new URL signs you out of this server.</p>
        </>
      ) : (
        <>
          <label className={field}>Command
            <Input size="md" value={d.command} onChange={(e) => set({ command: e.target.value })} spellCheck={false} className="font-mono" />
          </label>
          <label className={field}>Arguments, one per line
            <Textarea rows={Math.min(8, Math.max(2, d.args.split("\n").length))} value={d.args} onChange={(e) => set({ args: e.target.value })} spellCheck={false} className="font-mono text-label" />
          </label>
          <label className={field}>Folder (optional)
            <Input size="md" value={d.cwd} onChange={(e) => set({ cwd: e.target.value })} spellCheck={false} className="font-mono" />
          </label>
          <div className={field}>
            <span>Environment</span>
            <KeyRows rows={d.rows} onChange={(rows) => set({ rows })} saved={t.secretEnv} noun="variable" secrets />
          </div>
          <p className="text-caption text-muted-foreground">A new command or new arguments ask for your OK again before it runs.</p>
        </>
      )}
      {error && <p role="alert" className="break-words text-label text-destructive">{error}</p>}
      <span className="flex flex-wrap gap-1.5">
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>{busy && <Loader2 className="animate-spin" />} Save</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </span>
    </div>
  );
}

function ImportPanel({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { data: sources, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["connector-imports"], queryFn: api.connectorImports, retry: 1, staleTime: 0, gcTime: 0,
  });
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (sources) setPicks(initialPicks(sources)); }, [sources]);
  const flip = (k: string) => setPicks((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const items = sources ? pickedItems(sources, picks) : [];
  const withServers = sources?.filter((s) => s.servers.length || s.error) ?? [];
  const empty = sources?.filter((s) => !s.servers.length && !s.error).map((s) => s.label) ?? [];
  const warned = withServers.some((s) => s.servers.some((v) => v.warnings.length));

  const commit = async () => {
    setBusy(true);
    try {
      const r = await api.importConnectors(items);
      const n = r.connectors.length;
      toast(`Imported ${n} ${n === 1 ? "connector" : "connectors"}.${r.skipped.length ? ` Skipped ${r.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}.` : ""}`, "info");
      onDone();
    } catch (e) { toast(`Couldn’t import. ${msg(e)}`); }
    finally { setBusy(false); }
  };

  return (
    <div className={panel}>
      <p className="text-label text-foreground">MCP servers found in the apps on this computer. Only the setup comes over, never a sign-in.</p>
      {!sources && !isError && <p className="text-label text-muted-foreground">Looking…</p>}
      {isError && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1 basis-48 break-words text-label text-muted-foreground">Couldn&apos;t look for servers. {msg(error)}</span>
          <Button size="sm" onClick={() => void refetch()} disabled={isFetching}>{isFetching ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry</Button>
        </div>
      )}
      {withServers.map((s) => <ImportSource key={s.source} s={s} picks={picks} flip={flip} />)}
      {sources && !withServers.length && <p className="text-label text-muted-foreground">No MCP servers found.</p>}
      {empty.length > 0 && <p className="break-words text-caption text-faint">Nothing in {empty.join(", ")}.</p>}
      {warned && <p className="text-caption text-muted-foreground">Some values could not come over. Fill them in after importing, with Edit.</p>}
      <span className="flex flex-wrap gap-1.5">
        <Button variant="primary" size="sm" onClick={() => void commit()} disabled={!items.length || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />} Import {items.length || ""}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </span>
    </div>
  );
}

function ImportSource({ s, picks, flip }: { s: ConnectorImportSource; picks: ReadonlySet<string>; flip: (k: string) => void }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <h3 className={groupLabel}>{s.label}</h3>
        <Tooltip label={<span className="break-all">{s.path}</span>} truncated className="flex min-w-0 flex-1">
          <span className="min-w-0 truncate font-mono text-caption text-faint">{s.path}</span>
        </Tooltip>
      </div>
      {s.error && <p className="break-words text-caption text-destructive">{s.error}</p>}
      {s.servers.length > 0 && (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border px-3">
          {s.servers.map((v) => {
            const k = pickKey(s.source, v.name);
            const line = transportLine(v.transport);
            return (
              <div key={k} className="flex flex-col gap-1 py-2">
                <label className="flex cursor-pointer items-start gap-2.5">
                  <Checkbox checked={picks.has(k)} onChange={() => flip(k)} className="mt-0.5" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="min-w-0 break-words text-label font-medium text-foreground">{v.name}</span>
                      {v.duplicateOf && <Badge>Already added as {v.duplicateOf}</Badge>}
                    </span>
                    <Tooltip label={<span className="break-all">{line}</span>} truncated className="flex min-w-0 max-w-full">
                      <span className="min-w-0 truncate font-mono text-caption text-faint">{line}</span>
                    </Tooltip>
                  </span>
                </label>
                {v.warnings.map((w, i) => <p key={i} className="break-words pl-7 text-caption text-arc-text">{w}</p>)}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
