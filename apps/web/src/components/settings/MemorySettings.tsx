"use client";

import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Loader2, Pencil, Search, Trash2 } from "lucide-react";
import { NOTE_MAX_CHARS, type MemoryWire, type NoteWire } from "@openlive/shared";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/historyList";
import { budgetMeter, budgetSegments, filterNotes, noteProblem } from "@/lib/memory";
import { Badge, Button, ConfirmButton, Input, Textarea, Tooltip } from "@/components/ui";
import { EmptyState, NoMatch, QueryState, card, grid2, msg } from "./common";

const memoryQuery = { queryKey: ["memory"], queryFn: api.memory };
// Notes drawn at once: the list can run to hundreds, and the filter reaches the rest.
const PAGE = 50;
const SEGMENT = { used: "bg-accent", free: "bg-foreground/5", unused: "bg-foreground/20" } as const;

/** Clear all, beside the page's title. */
export function MemoryClearAll() {
  const qc = useQueryClient();
  const { data } = useQuery({ ...memoryQuery, retry: 1 });
  const n = data?.notes.length ?? 0;
  if (!n) return null;
  const clear = async () => {
    try { qc.setQueryData(memoryQuery.queryKey, await api.clearNotes()); }
    catch (e) { toast(`Couldn’t clear memory. ${msg(e)}`); }
  };
  return <ConfirmButton label="Clear all" confirm={`Clear all ${n}?`} onConfirm={clear} />;
}

/** The notes every brain carries into its prompt. The agent adds to them on its
 *  own, so the list refreshes on focus. Every change answers with the whole list,
 *  because one note joining or leaving moves the budget's cutoff for the others. */
export function MemorySettings() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(PAGE);
  const { data, isLoading, error, refetch, isFetching } = useQuery({ ...memoryQuery, retry: 1, refetchOnWindowFocus: true });
  const put = (m: MemoryWire) => qc.setQueryData<MemoryWire>(memoryQuery.queryKey, m);
  useEffect(() => setShown(PAGE), [filter]);

  const all = data?.notes ?? [];
  const matches = filterNotes(all, filter);
  const meter = data && budgetMeter(data);

  return (
    <div id="set-memory-list" className="flex flex-col gap-4">
      <QueryState loading={isLoading} error={error} retrying={isFetching} onRetry={() => void refetch()} />
      {data && meter && (
        <>
          <AddNote notes={all} full={all.length >= data.max} onSaved={put} />
          <div className="flex flex-col gap-2">
            <div role="meter" aria-label="Prompt budget used by memory" aria-valuemin={0} aria-valuemax={data.budget} aria-valuenow={Math.min(data.used, data.budget)}
              className="flex h-2 w-full gap-0.5">
              {budgetSegments(data).map((x) => <span key={x.key} style={{ flexGrow: x.weight }} className={cn("h-full min-w-0.5 basis-0 rounded-sm", SEGMENT[x.kind])} />)}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-caption text-muted-foreground">
              <span className={cn("inline-flex items-center gap-1.5", meter.tone === "near" && "text-arc-text")}>
                <span aria-hidden className="size-1.5 rounded-full bg-accent" />
                {all.length - meter.unused} in use · {data.used.toLocaleString()} of {data.budget.toLocaleString()} characters
              </span>
              {meter.unused > 0 && (
                <Tooltip label="Past the prompt budget, so no brain sees them. Delete or shorten some to bring them back.">
                  <span tabIndex={0} className="inline-flex items-center gap-1.5 rounded-sm">
                    <span aria-hidden className="size-1.5 rounded-full bg-foreground/30" />{meter.unused} saved, not in use
                  </span>
                </Tooltip>
              )}
              {all.length > 0 && (
                <Input type="search" size="sm" icon={<Search />} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find" aria-label="Find a note"
                  className="ml-auto min-w-0 max-w-[13rem] flex-1 basis-32" />
              )}
            </div>
          </div>
        </>
      )}
      {data && all.length === 0 && (
        <EmptyState>Nothing remembered yet. Add a fact above, or ask an assistant: &ldquo;Remember that I prefer short answers.&rdquo;</EmptyState>
      )}
      {filter.trim() && matches.length === 0 && all.length > 0 && <NoMatch what="note" query={filter} />}
      {matches.length > 0 && (
        <div className={grid2}>
          {matches.slice(0, shown).map((n) => <NoteCard key={n.id} n={n} all={all} put={put} />)}
        </div>
      )}
      {matches.length > shown && (
        <Button size="sm" className="self-center" onClick={() => setShown((s) => s + PAGE)}>Show {Math.min(PAGE, matches.length - shown)} more of {matches.length - shown}</Button>
      )}
    </div>
  );
}

/** One line over the list. Enter saves; spacing is tidied on the server. */
function AddNote({ notes, full, onSaved }: { notes: readonly NoteWire[]; full: boolean; onSaved: (m: MemoryWire) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const helpId = useId();
  const problem = full ? "Memory is full. Delete a note to add another." : error || noteProblem(text, notes);
  const ready = !!text.trim() && !problem;
  const length = text.replace(/\s+/g, " ").trim().length;
  const submit = async () => {
    if (!ready || busy) return;
    setError("");
    setBusy(true);
    try { onSaved(await api.addNote(text)); setText(""); }
    catch (e) { setError(msg(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input size="md" icon={<Brain />} value={text} onChange={(e) => { setText(e.target.value); setError(""); }} invalid={!!text.trim() && !!problem}
          aria-label="Add a fact to remember" aria-describedby={problem ? helpId : undefined} placeholder="Add a fact, like: they prefer short answers"
          trailing={length > 0 && <span className="shrink-0 text-caption tabular-nums text-faint">{length}/{NOTE_MAX_CHARS}</span>}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}
          className="min-w-0 flex-1 basis-56" />
        <Button variant="primary" onClick={() => void submit()} disabled={!ready || busy}>{busy && <Loader2 className="animate-spin" />} Remember</Button>
      </div>
      {problem && <p id={helpId} className="break-words text-caption text-destructive-text">{problem}</p>}
    </div>
  );
}

function NoteCard({ n, all, put }: { n: NoteWire; all: readonly NoteWire[]; put: (m: MemoryWire) => void }) {
  const [editing, setEditing] = useState(false);
  const remove = async () => {
    try { put(await api.removeNote(n.id)); }
    catch (e) { toast(`Couldn’t delete that note. ${msg(e)}`); }
  };
  return (
    <div className={cn(card, "gap-2.5 p-3.5", !n.inUse && "border border-dashed border-border-heavy bg-transparent shadow-none")}>
      {editing ? (
        <Editor n={n} all={all} onSaved={(m) => { put(m); setEditing(false); }} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <p className={cn("min-w-0 flex-1 break-words text-callout text-foreground", !n.inUse && "opacity-60")}>{n.text}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {!n.inUse && (
              <Tooltip label="Past the prompt budget, so no brain sees it. Still saved.">
                <span tabIndex={0} className="inline-flex rounded-sm"><Badge tone="arc">Not in use</Badge></span>
              </Tooltip>
            )}
            {n.at != null && <span className="text-caption text-faint">{relativeTime(new Date(n.at).toISOString())}</span>}
            <span className="ml-auto flex items-center gap-0.5">
              <Tooltip label="Edit">
                <Button variant="ghost" size="sm" icon onClick={() => setEditing(true)} aria-label={`Edit: ${n.text.slice(0, 40)}`}><Pencil /></Button>
              </Tooltip>
              <ConfirmButton label={`Delete: ${n.text.slice(0, 40)}`} icon={<Trash2 />} confirm="Delete it?" onConfirm={remove} />
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function Editor({ n, all, onSaved, onCancel }: { n: NoteWire; all: readonly NoteWire[]; onSaved: (m: MemoryWire) => void; onCancel: () => void }) {
  const [text, setText] = useState(n.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const problem = noteProblem(text, all, n.id);
  const ready = !!text.trim() && !problem;
  const save = async () => {
    if (!ready || busy) return;
    if (text === n.text) return onCancel();
    setError("");
    setBusy(true);
    try { onSaved(await api.saveNote(n.id, text)); }
    catch (e) { setError(msg(e)); setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-2">
      <Textarea rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} invalid={!!problem} aria-label="Edit note"
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
        }} />
      <p className={cn("break-words text-caption", problem || error ? "text-destructive" : "text-faint")}>
        {error || problem || `${text.replace(/\s+/g, " ").trim().length} of ${NOTE_MAX_CHARS} characters.`}
      </p>
      <span className="flex flex-wrap gap-1.5">
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={!ready || busy}>{busy && <Loader2 className="animate-spin" />} Save</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </span>
    </div>
  );
}
