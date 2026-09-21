"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Play, Search, Volume2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { flowBridge } from "@/lib/flow/bridge";
import { clock, dayLabel, duration, latency, stamp } from "@/lib/flow/format";
import {
  assetUrl, deleteFlowSession, sessionLine, useFlowSession, useFlowSessions,
  type FlowSessionEntry, type FlowSessionSummary,
} from "@/lib/flow/sessions";

// Everything Flow has said and done, and everything it was told. The list is a
// page of the store's bounded listing, never the archive: a machine with tens of
// thousands of sessions costs exactly what a machine with ten costs, and search
// is the store's own capped scan rather than a filter over a list we loaded.

const PAGE = 40;
const SEARCH_DEBOUNCE_MS = 200;

export function FlowHistory({ sessionId, onSelect }: { sessionId: string | null; onSelect: (id: string | null) => void }) {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    const t = setTimeout(() => { setQuery(typed); setLimit(PAGE); }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed]);

  const { data, isLoading, error, isFetching } = useFlowSessions(query, limit);
  const sessions = data?.sessions ?? [];
  const more = sessions.length >= limit;

  if (sessionId) return <Transcript id={sessionId} onBack={() => onSelect(null)} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-8">
      <label className="flex items-center gap-2.5 rounded-lg bg-card px-3.5 py-2.5 shadow-[var(--shadow-card)]">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="sr-only">Search what you said</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} type="search"
          placeholder="Search what you said"
          className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-faint" />
        {isFetching && <span className="shrink-0 text-caption text-muted-foreground">Looking&hellip;</span>}
      </label>

      <div className="openlive-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto rounded-xl bg-card p-1.5 shadow-[var(--shadow-card)]">
        {error && <Note>Flow&rsquo;s history could not be read.</Note>}
        {!error && isLoading && <Note>Looking&hellip;</Note>}
        {!error && !isLoading && !sessions.length && (
          <Note>{query ? `Nothing matching &ldquo;${query}&rdquo;.` : "Nothing yet. Hold your key anywhere and say something."}</Note>
        )}
        <Rows sessions={sessions} onSelect={onSelect} />
        {more && (
          <button type="button" onClick={() => setLimit((n) => n + PAGE)}
            className="m-1.5 rounded-md bg-surface-raised px-4 py-2.5 text-label font-medium transition hover:bg-foreground/10">
            Show older sessions
          </button>
        )}
      </div>
    </div>
  );
}

/** Rows grouped by day. The grouping is derived, so an empty day never appears. */
function Rows({ sessions, onSelect }: { sessions: FlowSessionSummary[]; onSelect: (id: string) => void }) {
  const groups = useMemo(() => {
    const out: { day: string; rows: FlowSessionSummary[] }[] = [];
    for (const s of sessions) {
      const day = dayLabel(s.createdAt) || "Earlier";
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(s);
      else out.push({ day, rows: [s] });
    }
    return out;
  }, [sessions]);

  return (
    <>
      {groups.map((g) => (
        <div key={g.day} className="flex flex-col">
          <span className="px-3 pb-1 pt-3 text-micro font-medium uppercase tracking-[0.06em] text-muted-foreground">{g.day}</span>
          {g.rows.map((s) => {
            const ms = new Date(s.updatedAt).getTime() - new Date(s.createdAt).getTime();
            return (
              <button key={s.id} type="button" onClick={() => onSelect(s.id)}
                className="flex min-h-[3.25rem] items-center gap-4 rounded-md px-3.5 py-2 text-left transition hover:bg-foreground/[0.05]">
                <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{clock(s.createdAt)}</span>
                <span className="min-w-0 flex-1 truncate text-callout">&ldquo;{sessionLine(s)}&rdquo;</span>
                {s.state === "crash" && (
                  <span className="shrink-0 rounded-full bg-destructive/10 px-2.5 py-0.5 text-caption text-destructive-text">Ended unexpectedly</span>
                )}
                {Number.isFinite(ms) && ms > 0 && (
                  <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{duration(ms)}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}

const Note = ({ children }: { children: React.ReactNode }) => (
  <p className="m-auto max-w-[32rem] px-6 py-10 text-center text-body leading-relaxed text-muted-strong">{children}</p>
);

// ── one session ──────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function Transcript({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, isLoading, error } = useFlowSession(id);
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [gone, setGone] = useState(false);

  const entries = (data?.entries ?? []).filter((e) => e.type !== "session_state");
  const first = entries[0]?.timestamp ?? data?.header?.createdAt ?? "";
  const last = entries[entries.length - 1]?.timestamp ?? first;
  const ms = new Date(last).getTime() - new Date(first).getTime();
  const app = entries.find((e) => e.type === "context" && (e.context as { app?: string })?.app);
  const tools = [...new Set(entries.filter((e) => e.type === "tool_call").map((e) => str(e.name)))].filter(Boolean);

  const remove = async () => {
    if (!(await deleteFlowSession(id))) return;
    setGone(true);
    void qc.invalidateQueries({ queryKey: ["flow-sessions"] });
    onBack();
  };

  const copy = () => {
    const text = entries.map((e) => `${stamp(e.timestamp)}  ${lineOf(e)}`).join("\n");
    void navigator.clipboard.writeText(text).catch(() => {});
  };

  if (gone) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-wrap gap-7 px-6 pb-8">
      <div className="flex min-w-[20rem] flex-[1_1_32rem] flex-col gap-3.5">
        <div className="flex items-start gap-3">
          <button type="button" onClick={onBack} aria-label="Back to all sessions"
            className="grid size-9 shrink-0 place-items-center rounded-full bg-card shadow-[var(--shadow-xs)] transition hover:bg-foreground/[0.06]">
            <X className="size-4" />
          </button>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="text-title font-semibold">&ldquo;{sessionLine({ title: str(data?.header?.title), id, createdAt: first, updatedAt: last, state: "archived" })}&rdquo;</h1>
            <p className="text-caption text-muted-foreground">
              {[dayLabel(first), clock(first), app ? `${str((app.context as { app?: string }).app)} was in front` : "", `${entries.length} events`]
                .filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>

        <div className="openlive-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          {error && <Note>{String((error as Error).message)}</Note>}
          {isLoading && <Note>Opening&hellip;</Note>}
          {!isLoading && !error && !entries.length && <Note>This session has nothing in it.</Note>}
          {entries.map((e) => <Event key={e.id} entry={e} sessionId={id} assets={data?.assets ?? []} />)}
          {data?.truncated && (
            <p className="text-caption text-muted-strong">
              The end of this session was never finished being written, so the last line was left out.
            </p>
          )}
        </div>
      </div>

      <aside className="flex min-w-[15rem] flex-[0_1_17rem] flex-col gap-3.5 self-start">
        <dl className="flex flex-col gap-3 rounded-lg bg-card p-5 shadow-[var(--shadow-card)]">
          <span className="text-micro font-medium uppercase tracking-[0.06em] text-muted-foreground">This session</span>
          <Fact label="Lasted">{Number.isFinite(ms) && ms > 0 ? duration(ms) : "a moment"}</Fact>
          <Fact label="Brain">{str(data?.header?.brain) || "OpenLive"}</Fact>
          {app && <Fact label="In front">{str((app.context as { app?: string }).app)}</Fact>}
          <Fact label="Tools">{tools.length ? tools.join(", ") : "None"}</Fact>
        </dl>

        <p className="rounded-lg bg-card p-5 text-label leading-relaxed text-muted-strong shadow-[var(--shadow-card)]">
          Audio was never stored. Only the text above{data?.assets.length ? ` and ${data.assets.length === 1 ? "one capture" : `${data.assets.length} captures`}` : ""} are on this machine.
        </p>

        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => flowBridge()?.resumeSession(id)}
            className="flex items-center justify-center gap-2 rounded-full bg-card px-4 py-2.5 text-body font-medium shadow-[var(--shadow-xs)] transition hover:bg-foreground/[0.06]">
            <Play className="size-3.5" aria-hidden /> Carry on from here
          </button>
          <button type="button" onClick={copy}
            className="rounded-full bg-card px-4 py-2.5 text-body font-medium shadow-[var(--shadow-xs)] transition hover:bg-foreground/[0.06]">
            Copy transcript
          </button>
          {confirming ? (
            <div className="flex flex-col gap-2 rounded-lg bg-card p-3 shadow-[var(--shadow-xs)]">
              <span className="text-label leading-relaxed text-muted-strong">Delete this transcript and its captures? This cannot be undone.</span>
              <div className="flex gap-2">
                <button type="button" onClick={remove}
                  className="flex-1 rounded-full bg-destructive-fill px-3 py-2 text-label font-medium text-white transition hover:opacity-90">
                  Delete
                </button>
                <button type="button" onClick={() => setConfirming(false)}
                  className="flex-1 rounded-full bg-surface-raised px-3 py-2 text-label font-medium transition hover:bg-foreground/10">
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirming(true)}
              className="rounded-full px-4 py-2.5 text-body font-medium text-destructive-text transition hover:bg-destructive/10">
              Delete this session
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-[4.75rem] shrink-0 text-label text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-body">{children}</dd>
    </div>
  );
}

/** One line of the plain-text copy, so a pasted transcript reads like the screen. */
function lineOf(e: FlowSessionEntry): string {
  if (e.type === "message") return `${e.role === "user" ? "You" : "Flow"}: ${str(e.text)}`;
  if (e.type === "tool_call") return `${str(e.name)}(${JSON.stringify(e.args ?? {})})`;
  if (e.type === "tool_result") return `${str(e.name)} → ${e.isError ? "failed" : "ok"}`;
  if (e.type === "context") return `In front: ${str((e.context as { app?: string })?.app)}`;
  return e.type;
}

function Event({ entry, sessionId, assets }: { entry: FlowSessionEntry; sessionId: string; assets: { name: string }[] }) {
  return (
    <div className="flex gap-4">
      <span className="w-[4.25rem] shrink-0 pt-0.5 font-mono text-caption tabular-nums text-muted-foreground">{stamp(entry.timestamp)}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Body entry={entry} sessionId={sessionId} assets={assets} />
      </div>
    </div>
  );
}

function Body({ entry, sessionId, assets }: { entry: FlowSessionEntry; sessionId: string; assets: { name: string }[] }) {
  if (entry.type === "message") {
    const user = entry.role === "user";
    return (
      <>
        <span className="flex items-center gap-1.5 text-micro font-medium uppercase tracking-[0.06em] text-muted-foreground">
          {!user && <Volume2 className="size-3 shrink-0 text-icon-info" aria-hidden />}
          {user ? "You said" : "Said out loud"}
        </span>
        <p className="whitespace-pre-wrap break-words text-callout leading-relaxed">{str(entry.text) || str(entry.content)}</p>
      </>
    );
  }

  if (entry.type === "context") {
    const c = (entry.context ?? {}) as { app?: string; windowTitle?: string };
    return (
      <p className="min-w-0 truncate text-caption text-muted-strong">
        {[c.app, c.windowTitle].filter(Boolean).join(" · ") || "Nothing readable was in front"}
      </p>
    );
  }

  if (entry.type === "tool_call" || entry.type === "tool_result") {
    const failed = entry.type === "tool_result" && entry.isError === true;
    const shot = shotFor(entry, assets);
    return (
      <div className="flex flex-col gap-2.5 rounded-lg bg-card p-3.5 shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className={cn("size-[7px] shrink-0 rounded-full", failed ? "bg-destructive-fill" : "bg-success")} aria-hidden />
          <span className="min-w-0 truncate font-mono text-label">{str(entry.name) || "tool"}</span>
          {entry.type === "tool_result" && (
            <span className={cn("flex items-center gap-1 rounded-full px-2 py-0.5 text-caption",
              failed ? "bg-destructive/10 text-destructive-text" : "bg-success/15 text-success-text")}>
              {!failed && <Check className="size-3" strokeWidth={2.6} aria-hidden />}
              {failed ? "It did not work" : "Done"}
            </span>
          )}
          <span className="flex-1" />
          {typeof entry.durationMs === "number" && (
            <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{latency(entry.durationMs)}</span>
          )}
        </div>
        {entry.type === "tool_call" && !!entry.args && (
          <pre className="ol-selectable max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-raised px-3 py-2 font-mono text-caption leading-relaxed">
            {JSON.stringify(entry.args, null, 2)}
          </pre>
        )}
        {shot && (
          <a href={assetUrl(sessionId, shot)} target="_blank" rel="noreferrer" className="self-start">
            <img src={assetUrl(sessionId, shot)} alt={`What ${str(entry.name)} captured`} loading="lazy"
              className="max-h-64 w-auto max-w-full rounded-md bg-surface-raised object-contain shadow-[var(--shadow-xs)]" />
          </a>
        )}
      </div>
    );
  }

  return <p className="text-caption text-muted-strong">{entry.type}</p>;
}

/** An entry names its assets by relative path; the transcript needs the basename. */
function shotFor(entry: FlowSessionEntry, assets: { name: string }[]): string {
  const raw = str(entry.asset) || str((entry.details as { asset?: string })?.asset);
  const name = raw.split("/").pop() ?? "";
  return name && assets.some((a) => a.name === name) ? name : "";
}
