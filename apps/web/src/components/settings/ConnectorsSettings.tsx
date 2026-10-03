"use client";

import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Download, ExternalLink, Loader2, LogIn, LogOut, Pencil, Plug, Plus, RotateCcw, Search, ShieldCheck, Trash2, X } from "lucide-react";
import type { ConnectorImportSource, ConnectorWire } from "@openlive/shared";
import { api } from "@/lib/api";
import { bridge, isDesktop } from "@/lib/platform";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import {
  STATUS, bulkTools, draftOf, editPatch, initialPicks, monogram, pickKey, pickedItems, secretPatch, signInPollMs, signInsPollMs, transportLine,
  type EditDraft, type KeyRow,
} from "@/lib/connectors";
import { Badge, Button, Checkbox, Chip, ConfirmButton, Disclosure, Input, ListGroup, Notice, Segmented, Switch, Textarea, Tooltip, groupLabel } from "@/components/ui";
import { BuiltInBadge, EmptyState, FILTER_AT, MoreMenu, NoMatch, OneLine, QueryState, StatusDot, field, inset, msg, panel, tile, type MenuAction } from "./common";
import { capabilitiesQuery, useFlipGroup } from "./ToolsSettings";

export const connectorsQuery = { queryKey: ["connectors"], queryFn: api.connectors };
const KEY = connectorsQuery.queryKey;

type SignIn = { url: string; since: number };

/** Opens a page in the real browser: the desktop shell's bridge, or a tab. A tab
 *  opened before the await (`tab`) is pointed at it, since a browser blocks one
 *  opened after. */
function openPage(url: string, tab?: Window | null) {
  if (isDesktop && bridge) void bridge("open_url", url);
  else if (tab) { tab.opener = null; tab.location.href = url; }
  else window.open(url, "_blank", "noopener");
}

/** MCP servers every brain can use, in Chat and Flow, under the built-in web
 *  search. The agent pushes nothing, so this page refreshes itself: on focus,
 *  while a connector is connecting, and while any sign-in is open in the browser. */
export function ConnectorsSettings() {
  const qc = useQueryClient();
  // Keyed by connector id, so a second sign-in never ends the first one's watch.
  const [signIns, setSignIns] = useState<ReadonlyMap<string, SignIn>>(new Map());
  const [adding, setAdding] = useState<"add" | "import" | null>(null);
  const [filter, setFilter] = useState("");
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    ...connectorsQuery, retry: 1, refetchOnWindowFocus: true,
    refetchInterval: (q) => {
      if (signIns.size) return signInsPollMs([...signIns.values()].map((s) => s.since), Date.now());
      return q.state.data?.connectors.some((c) => c.status === "connecting") ? 2000 : false;
    },
  });
  const list = data?.connectors;
  const put = (c: ConnectorWire) => qc.setQueryData<Awaited<ReturnType<typeof api.connectors>>>(KEY, (d) => d && { ...d, connectors: d.connectors.map((x) => (x.id === c.id ? c : x)) });
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  // The desktop window regains focus without the page turning visible, which
  // is all the query's own focus check listens for.
  useEffect(() => {
    if (!signIns.size) return;
    const look = () => { if (document.visibilityState === "visible") void refetch(); };
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", look);
    const oldest = Math.min(...[...signIns.values()].map((s) => s.since));
    const giveUp = setTimeout(
      () => setSignIns((m) => new Map([...m].filter(([, s]) => signInPollMs(Date.now() - s.since) !== false))),
      Math.max(0, oldest + 5 * 60_000 - Date.now()),
    );
    return () => { window.removeEventListener("focus", look); document.removeEventListener("visibilitychange", look); clearTimeout(giveUp); };
  }, [signIns, refetch]);
  useEffect(() => {
    if (!signIns.size) return;
    const byId = new Map(list?.map((c) => [c.id, c]));
    const done = [...signIns.keys()].filter((id) => { const c = byId.get(id); return !c || c.status === "connected"; });
    if (!done.length) return;
    for (const id of done) { const c = byId.get(id); if (c) toast(`Signed in to ${c.name}.`, "info"); }
    setSignIns((m) => new Map([...m].filter(([id]) => !done.includes(id))));
  }, [signIns, list]);

  const startSignIn = async (c: ConnectorWire) => {
    const tab = isDesktop ? null : window.open("", "_blank");
    try {
      const r = await api.startConnectorSignIn(c.id);
      if ("connector" in r) { tab?.close(); put(r.connector); return; }
      openPage(r.authorizationUrl, tab);
      setSignIns((m) => new Map(m).set(c.id, { url: r.authorizationUrl, since: Date.now() }));
    } catch (e) {
      tab?.close();
      toast(`Couldn’t start signing in to ${c.name}. ${msg(e)}`);
    }
  };

  const q = filter.trim().toLowerCase();
  const all = list ?? [];
  const shown = q ? all.filter((c) => `${c.name} ${transportLine(c.transport)}`.toLowerCase().includes(q)) : all;
  const exaShown = !q || "web search exa mcp.exa.ai".includes(q);

  return (
    <div id="set-capabilities-connectors-list" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="search" icon={<Search />} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a connector" aria-label="Find a connector" className="min-w-0 flex-1 basis-40" />
        <span className="flex items-center gap-1.5">
          <MoreMenu label="More for connectors" actions={adding === "import" ? [] : [{ label: "Import", icon: Download, run: () => setAdding("import") }]} />
          <Button variant="primary" onClick={() => setAdding("add")} disabled={adding === "add"}><Plus /> Add connector</Button>
        </span>
      </div>
      {adding === "add" && <AddPanel onDone={() => { setAdding(null); void refresh(); }} onCancel={() => setAdding(null)} />}
      {adding === "import" && <ImportPanel onDone={() => { setAdding(null); void refresh(); }} onCancel={() => setAdding(null)} />}
      {!!data?.problems?.length && (
        <Notice role="alert" tone="danger" className="flex-col">
          <p className="text-foreground">mcp.json has a problem. Fix it in a text editor, then check again.</p>
          {data.problems.map((p) => <p key={p} className="break-words font-mono text-caption">{p}</p>)}
          <Button size="sm" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="animate-spin" /> : <RotateCcw />} Check again
          </Button>
        </Notice>
      )}
      <QueryState loading={isLoading} error={error} retrying={isFetching} onRetry={() => void refetch()} />
      {(exaShown || shown.length > 0) && (
        <ListGroup className="px-0">
          {exaShown && <ExaRow />}
          {shown.map((c) => (
            <ConnectorRow key={c.id} c={c} put={put} refresh={refresh} onSignIn={() => void startSignIn(c)}
              waiting={signIns.get(c.id)?.url ?? null} />
          ))}
        </ListGroup>
      )}
      {q && !exaShown && shown.length === 0 && <NoMatch what="connector" query={filter} />}
      {list && all.length === 0 && !q && !adding && (
        <EmptyState icon={Plug} actions={<>
          <Button size="sm" variant="primary" onClick={() => setAdding("add")}><Plus /> Add connector</Button>
          <Button size="sm" onClick={() => setAdding("import")}><Download /> Import</Button>
        </>}>No connectors of your own yet. Add an MCP server, or import yours from other tools.</EmptyState>
      )}
      <p className="text-caption text-muted-foreground">Changes apply from the next turn.</p>
    </div>
  );
}

/** The parts every connector row shares: its tile, name, status, transport, and the switch and disclosure on the right. */
function RowHead({ name, status, badge, line, problem, action, count, on, onFlip, switchTip, open, onOpen, bodyId, more = [] }: {
  name: string; status: React.ReactNode; badge?: React.ReactNode; line: string; problem?: string; action?: React.ReactNode; count: string;
  on: boolean; onFlip: () => void; switchTip?: string; open: boolean; onOpen: () => void; bodyId: string; more?: readonly MenuAction[];
}) {
  const flip = (
    <label className="flex cursor-pointer items-center">
      <span className="sr-only">Use {name}</span>
      <Switch on={on} onFlip={onFlip} />
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-card-x py-3">
      <div className={cn("flex min-w-[min(14rem,100%)] flex-1 items-center gap-3", !on && "opacity-60")}>
        <span aria-hidden className={cn(tile, "font-mono text-label font-semibold text-foreground")}>{monogram(name)}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 break-words text-body font-semibold text-foreground">{name}</span>
            {status}
            {badge}
          </span>
          <OneLine text={line} className="font-mono text-caption text-faint" />
          {problem && <OneLine text={problem} className="text-caption text-destructive-text" />}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {action}
        <span className="whitespace-nowrap text-caption tabular-nums text-muted-foreground">{count}</span>
        {switchTip ? <Tooltip label={switchTip}>{flip}</Tooltip> : flip}
        <MoreMenu label={`More for ${name}`} actions={more} />
        <Button variant="ghost" icon onClick={onOpen} aria-expanded={open} aria-controls={bodyId} aria-label={`${open ? "Hide" : "Show"} details for ${name}`}>
          <ChevronDown className={cn("transition-transform duration-fast motion-reduce:transition-none", open && "rotate-180")} />
        </Button>
      </div>
    </div>
  );
}

const asksDot = <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-arc" />;

/** The built-in web search: Exa's hosted server, keyless on its free tier. Its
 *  switch is the Web research group's, and a key of your own lifts the limit. */
function ExaRow() {
  const qc = useQueryClient();
  const { data } = useQuery({ ...capabilitiesQuery, retry: 1 });
  const flip = useFlipGroup();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const bodyId = useId();
  const web = data?.groups.find((g) => g.id === "web");
  if (!data || !web) return null;
  const save = async (next: string) => {
    setBusy(true);
    try { qc.setQueryData(capabilitiesQuery.queryKey, await api.setExaKey(next)); setKey(""); }
    catch (e) { toast(`Couldn’t ${next ? "save" : "remove"} the Exa key. ${msg(e)}`); }
    finally { setBusy(false); }
  };
  const status = data.exaKey === "saved" ? "Your key" : data.exaKey === "env" ? "Key from EXA_API_KEY" : "Free tier";
  return (
    <div id="set-capabilities-exa">
      <RowHead name="Web search (Exa)" line="mcp.exa.ai" status={<StatusDot tone={web.enabled ? "success" : "muted"}>{web.enabled ? status : "Off"}</StatusDot>} badge={<BuiltInBadge />}
        count={`${web.tools.length} tools`} on={web.enabled} onFlip={() => flip(web)} switchTip="Same switch as Web research in Tools"
        open={open} onOpen={() => setOpen(!open)} bodyId={bodyId} />
      <Disclosure open={open}>
        <div id={bodyId} className="flex flex-col gap-3 px-card-x pb-3">
          <span className="flex flex-wrap gap-1.5">
            {web.tools.map((t) => (
              <Tooltip key={t.name} label={t.description}>
                <span tabIndex={0} className="rounded-full"><Chip className="font-mono">{t.name}</Chip></span>
              </Tooltip>
            ))}
          </span>
          <div className={field}>
            <span>Exa API key (optional)</span>
            <span className="flex flex-wrap items-center gap-1.5">
              <Input size="sm" type="password" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Exa API key"
                placeholder={data.exaKey === "saved" ? "Saved. Type to replace it" : "Lifts the free tier's limit"}
                onKeyDown={(e) => { if (e.key === "Enter" && key.trim()) void save(key); }}
                autoComplete="off" spellCheck={false} className="min-w-0 flex-1 basis-48 font-mono" />
              <Button size="sm" variant="primary" onClick={() => void save(key)} disabled={!key.trim() || busy}>{busy && <Loader2 className="animate-spin" />} Save</Button>
              {data.exaKey === "saved" && <ConfirmButton label="Remove key" confirm="Remove it?" disabled={busy} onConfirm={() => save("")} />}
            </span>
          </div>
        </div>
      </Disclosure>
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
  const bodyId = useId();
  const status = STATUS[c.status];
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
  const reconnect = () => void run("reconnect", () => api.reconnectConnector(c.id), `Couldn’t reconnect ${c.name}.`);

  const action = c.status === "needs_auth" ? <Button variant="primary" size="sm" onClick={onSignIn}><LogIn /> Sign in</Button>
    : c.status === "needs_consent" ? <Button size="sm" onClick={() => { setReviewing(true); setOpen(true); }}><ShieldCheck /> Review</Button>
    : c.status === "error" || c.status === "disconnected" ? <Button variant="ghost" size="sm" onClick={reconnect} disabled={!!busy}>{spin("reconnect", RotateCcw)} Retry</Button>
    : null;

  return (
    <div>
      <RowHead name={c.name} line={transportLine(c.transport)} status={<StatusDot tone={status.dot}>{status.text}</StatusDot>}
        problem={c.status === "error" ? c.error : undefined} action={action}
        count={c.tools.length ? `${c.tools.length} ${c.tools.length === 1 ? "tool" : "tools"}${off ? ` · ${off} off` : ""}` : "No tools yet"}
        on={c.enabled} onFlip={() => flip({ ...c, enabled: !c.enabled }, () => api.setConnectorEnabled(c.id, !c.enabled), `Couldn’t turn ${c.name} ${c.enabled ? "off" : "on"}.`)}
        open={open} onOpen={() => setOpen(!open)} bodyId={bodyId} more={busy ? [] : [
          ...(c.signedIn ? [{ label: "Sign out", icon: LogOut, run: () => void run("signout", () => api.signOutConnector(c.id), `Couldn’t sign out of ${c.name}.`) }] : []),
          ...(editing ? [] : [{ label: "Edit", icon: Pencil, run: () => { setEditing(true); setOpen(true); } }]),
          { label: "Remove", icon: Trash2, confirm: "Remove it?", run: () => void run("remove", () => api.removeConnector(c.id), `Couldn’t remove ${c.name}.`) },
        ]} />

      {waiting && c.status !== "connected" && (
        <p role="status" className="flex flex-wrap items-center gap-1.5 px-card-x pb-3 text-caption text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Finish signing in in your browser. This updates by itself.
          <Button variant="accent" size="sm" onClick={() => openPage(waiting)}><ExternalLink /> Open the page again</Button>
        </p>
      )}

      <Disclosure open={open}>
        <div id={bodyId} className="flex flex-col gap-3 px-card-x pb-3">
          {reviewing && c.status === "needs_consent" && c.transport.type === "stdio" && (
            <div className={inset}>
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
              {consentError && <p role="alert" className="break-words text-label text-destructive-text">{consentError}</p>}
              <span className="flex flex-wrap gap-1.5">
                <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void allow()}>
                  {spin("consent", ShieldCheck)} Allow
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setReviewing(false); setConsentError(""); }}>Cancel</Button>
              </span>
            </div>
          )}
          {c.status === "error" && c.error && <p role="alert" className="break-words text-caption text-destructive-text">{c.error}</p>}
          {editing && <EditPanel c={c} onSaved={(next) => { put(next); setEditing(false); }} onCancel={() => setEditing(false)} />}
          {c.tools.length > 0 && <Tools c={c} flip={flip} />}
          {c.tools.some((t) => t.readOnly) && (
            <Tooltip label="Its server labels some tools as only reading. On, those run without asking first; off, every tool asks.">
              <label className="inline-flex w-fit cursor-pointer items-center gap-2 text-label text-foreground">
                <Checkbox checked={c.trustReadOnly}
                  onChange={() => flip({ ...c, trustReadOnly: !c.trustReadOnly }, () => api.updateConnector(c.id, { trustReadOnly: !c.trustReadOnly }), `Couldn’t change whether ${c.name} asks first.`)} />
                Trust its read-only labels
              </label>
            </Tooltip>
          )}
          {c.tools.length > 0 && <span className="inline-flex items-center gap-1.5 text-caption text-muted-foreground">{asksDot} asks first</span>}
        </div>
      </Disclosure>
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

/** A connector's tools as chips you press to turn on or off. */
function Tools({ c, flip }: {
  c: ConnectorWire; flip: (next: ConnectorWire, call: () => Promise<ConnectorWire>, fail: string) => void;
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
    <div className="flex flex-col gap-2">
      {c.tools.length > FILTER_AT && (
        <Input type="search" size="sm" icon={<Search />} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Find among ${c.tools.length} tools`} aria-label={`Find a tool in ${c.name}`} />
      )}
      {q && shown.length === 0 && <NoMatch what="tool" query={filter} />}
      {shown.length > 0 && (
        <span className="flex flex-wrap gap-1.5">
          {shown.map((t) => {
            const asks = !(c.trustReadOnly && t.readOnly);
            const tip = [t.description, asks ? "Asks first." : ""].filter(Boolean).join(" ");
            return (
              <Tooltip key={t.name} label={tip}>
                <button type="button" aria-pressed={t.enabled} className="rounded-full"
                  onClick={() => flip(
                    { ...c, tools: c.tools.map((x) => (x.name === t.name ? { ...x, enabled: !t.enabled } : x)) },
                    () => api.setConnectorToolEnabled(c.id, t.name, !t.enabled),
                    `Couldn’t turn ${t.name} ${t.enabled ? "off" : "on"}.`,
                  )}>
                  <Chip dot={t.enabled ? "success" : "muted"} className={cn("font-mono transition hover:bg-foreground/10", !t.enabled && "line-through opacity-60")}>
                    {t.exposedName}
                    {asks && <>{asksDot}<span className="sr-only">, asks first</span></>}
                  </Chip>
                </button>
              </Tooltip>
            );
          })}
        </span>
      )}
      {c.tools.length > 1 && shown.length > 0 && <span className="flex flex-wrap gap-1.5">{bulk(true)}{bulk(false)}</span>}
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
    <div className={inset}>
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
  const { data: sources, isLoading, error, refetch, isFetching } = useQuery({
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
      <OneLine className="text-label text-foreground" text="MCP servers found in the apps on this computer. Only the setup comes over, never a sign-in." />
      <QueryState loading={isLoading} error={error} retrying={isFetching} onRetry={() => void refetch()} what="look for servers" />
      {withServers.map((s) => <ImportSource key={s.source} s={s} picks={picks} flip={flip} />)}
      {sources && !withServers.length && <p className="text-label text-muted-foreground">No MCP servers found.</p>}
      {empty.length > 0 && <p className="break-words text-caption text-faint">Nothing in {empty.join(", ")}.</p>}
      {warned && <p className="text-caption text-muted-foreground">Some values couldn&apos;t come over. Fill them in after importing, with Edit.</p>}
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
